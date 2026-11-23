// Reads a Slack workspace export (the .zip a Slack admin downloads) into the shapes Huddle's import
// API accepts. Pure functions over the zip's files, so they're unit-tested without a browser.
// Only the documented export format is used: users.json, channels.json, groups.json, dms.json,
// mpims.json, and one folder per conversation holding a JSON file per day.
// No path aliases or DOM types here: the tests import this file directly.

export type ImportUser = { slackId: string; name: string; realName?: string; email?: string };
export type ImportChannel = {
  slackId: string;
  kind: 'public' | 'private' | 'dm' | 'group_dm';
  name?: string;
  topic?: string;
  archived?: boolean;
  memberSlackIds: string[];
};
export type ImportMessage = {
  ts: string;
  user?: string;
  text: string;
  subtype?: string;
  threadTs?: string;
  reactions?: { name: string; users: string[] }[];
};
export type ImportFile = { channelSlackId: string; ts: string; name: string; url: string };

export type SlackExport = {
  users: ImportUser[];
  channels: ImportChannel[];
  /** Messages per channel id, oldest first. */
  messages: Map<string, ImportMessage[]>;
  files: ImportFile[];
  summary: {
    people: number;
    publicChannels: number;
    privateChannels: number;
    directMessages: number;
    messages: number;
    files: number;
    from: string | null;
    to: string | null;
  };
};

const SLACK_ID = /^[A-Z0-9]{2,30}$/;
const TS = /^\d{9,11}\.\d{1,6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const clip = (s: string | undefined, max: number) => (s ? s.trim().slice(0, max) : undefined);

/** Thrown with a message meant for the person importing. */
export class ExportError extends Error {}

/**
 * Parses the zip's JSON files (path → bytes). Exports sometimes sit inside one top-level folder,
 * so everything is found relative to where users.json is.
 */
export function parseSlackExport(files: Record<string, Uint8Array>): SlackExport {
  const decoder = new TextDecoder();
  const usersPath = Object.keys(files).find((p) => p === 'users.json' || p.endsWith('/users.json'));
  if (!usersPath) {
    throw new ExportError('This doesn’t look like a Slack export: there’s no users.json inside the zip.');
  }
  const root = usersPath.slice(0, -'users.json'.length);
  const read = (name: string): unknown[] => {
    const bytes = files[root + name];
    if (!bytes) return [];
    try {
      return arr(JSON.parse(decoder.decode(bytes)));
    } catch {
      throw new ExportError(`${name} in the export couldn’t be read.`);
    }
  };

  const users: ImportUser[] = [];
  for (const u of read('users.json').map(obj)) {
    const slackId = str(u.id);
    if (!slackId || !SLACK_ID.test(slackId)) continue;
    const profile = obj(u.profile);
    const email = str(profile.email);
    const realName = clip(str(u.real_name) ?? str(profile.real_name), 80);
    users.push({
      slackId,
      name: clip(str(profile.display_name) || str(u.name), 80) ?? '',
      ...(realName ? { realName } : {}),
      ...(email && EMAIL.test(email) ? { email: email.toLowerCase() } : {}),
    });
  }

  // Each conversation type lives in its own file; the folder holding its messages is named after
  // the channel (channels, private channels, group DMs) or its id (DMs).
  const channels: ImportChannel[] = [];
  const folders = new Map<string, string>(); // channel id → folder
  const add = (list: unknown[], kind: ImportChannel['kind'], folderBy: 'name' | 'id') => {
    for (const c of list.map(obj)) {
      const slackId = str(c.id);
      if (!slackId || !SLACK_ID.test(slackId)) continue;
      const name = clip(str(c.name), 100);
      const topic = clip(str(obj(c.topic).value) || str(obj(c.purpose).value), 250);
      channels.push({
        slackId,
        kind,
        ...(kind === 'public' || kind === 'private' ? (name ? { name } : {}) : {}),
        ...(topic ? { topic } : {}),
        ...(c.is_archived === true ? { archived: true } : {}),
        memberSlackIds: arr(c.members)
          .map(str)
          .filter((m): m is string => !!m && SLACK_ID.test(m))
          .slice(0, 500),
      });
      const folder = folderBy === 'name' ? str(c.name) : slackId;
      if (folder) folders.set(slackId, folder);
    }
  };
  add(read('channels.json'), 'public', 'name');
  add(read('groups.json'), 'private', 'name');
  add(read('dms.json'), 'dm', 'id');
  add(read('mpims.json'), 'group_dm', 'name');

  const messages = new Map<string, ImportMessage[]>();
  const fileList: ImportFile[] = [];
  let first: number | null = null;
  let last: number | null = null;
  const paths = Object.keys(files);
  for (const ch of channels) {
    const folder = folders.get(ch.slackId);
    if (!folder) continue;
    const prefix = `${root}${folder}/`;
    const days = paths.filter((p) => p.startsWith(prefix) && DAY_FILE.test(p.slice(prefix.length))).sort();
    const list: ImportMessage[] = [];
    for (const day of days) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(files[day]));
      } catch {
        continue; // one unreadable day shouldn't stop the whole import
      }
      for (const m of arr(parsed).map(obj)) {
        const ts = str(m.ts);
        if (!ts || !TS.test(ts)) continue;
        const user = str(m.user);
        const threadTs = str(m.thread_ts);
        const subtype = clip(str(m.subtype), 50);
        const reactions = arr(m.reactions)
          .map(obj)
          .map((r) => ({
            name: clip(str(r.name), 100) ?? '',
            users: arr(r.users)
              .map(str)
              .filter((id): id is string => !!id && SLACK_ID.test(id))
              .slice(0, 50),
          }))
          .filter((r) => r.name && r.users.length)
          .slice(0, 20);
        list.push({
          ts,
          ...(user && SLACK_ID.test(user) ? { user } : {}),
          text: (str(m.text) ?? '').slice(0, 40_000),
          ...(subtype ? { subtype } : {}),
          // A thread's first message carries its own ts as thread_ts; only replies point elsewhere.
          ...(threadTs && TS.test(threadTs) && threadTs !== ts ? { threadTs } : {}),
          ...(reactions.length ? { reactions } : {}),
        });
        for (const f of arr(m.files).map(obj)) {
          const url = str(f.url_private_download) ?? str(f.url_private);
          const name = clip(str(f.name) ?? str(f.title), 255);
          if (url && name && /^https:\/\//.test(url))
            fileList.push({ channelSlackId: ch.slackId, ts, name, url });
        }
        const seconds = Number(ts);
        first = first === null ? seconds : Math.min(first, seconds);
        last = last === null ? seconds : Math.max(last, seconds);
      }
    }
    list.sort((a, b) => Number(a.ts) - Number(b.ts));
    messages.set(ch.slackId, list);
  }

  const count = (kind: ImportChannel['kind']) => channels.filter((c) => c.kind === kind).length;
  return {
    users,
    channels,
    messages,
    files: fileList,
    summary: {
      people: users.length,
      publicChannels: count('public'),
      privateChannels: count('private'),
      directMessages: count('dm') + count('group_dm'),
      messages: [...messages.values()].reduce((n, l) => n + l.length, 0),
      files: fileList.length,
      from: first === null ? null : new Date(first * 1000).toISOString(),
      to: last === null ? null : new Date(last * 1000).toISOString(),
    },
  };
}

/** Splits a list into batches of at most `size` (the import API's per-request limits). */
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
