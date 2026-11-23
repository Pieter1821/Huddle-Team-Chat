import { ApiError, api } from '@/lib/api';
import { chunk, type SlackExport } from './slack-export';

export type ImportOptions = { includeDirectMessages: boolean; includeFiles: boolean };
export type Step = 'people' | 'conversations' | 'messages' | 'files' | 'finishing';
export type Progress = {
  step: Step;
  people: { done: number; total: number };
  conversations: { done: number; total: number };
  messages: { done: number; total: number; imported: number; skipped: number };
  files: { done: number; total: number; failed: number };
};
export type Outcome =
  | { kind: 'finished'; progress: Progress }
  | { kind: 'paused'; progress: Progress }
  | { kind: 'daily-limit'; progress: Progress; message: string }
  | { kind: 'failed'; progress: Progress; message: string };

// The import API's per-request limits.
const PEOPLE_PER_BATCH = 15;
const CHANNELS_PER_BATCH = 10;
const MESSAGES_PER_BATCH = 20;
/** Gone from Slack (502), too big (413), not allowed or unreadable (400, 415): skip that file. */
const FILE_SKIPPABLE = new Set([400, 413, 415, 502]);

/**
 * Runs (or continues) an import through the API, a batch at a time. Every step is safe to repeat:
 * the server skips people, conversations and messages it already imported in this session, so
 * "Continue" after a pause, a closed tab or the daily limit simply starts again from the top.
 */
export async function runImport(
  sessionId: string,
  data: SlackExport,
  options: ImportOptions,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<Outcome> {
  const channels = data.channels.filter(
    (c) => options.includeDirectMessages || (c.kind !== 'dm' && c.kind !== 'group_dm'),
  );
  const included = new Set(channels.map((c) => c.slackId));
  const files = options.includeFiles ? data.files.filter((f) => included.has(f.channelSlackId)) : [];
  const p: Progress = {
    step: 'people',
    people: { done: 0, total: data.users.length },
    conversations: { done: 0, total: channels.length },
    messages: {
      done: 0,
      total: channels.reduce((n, c) => n + (data.messages.get(c.slackId)?.length ?? 0), 0),
      imported: 0,
      skipped: 0,
    },
    files: { done: 0, total: files.length, failed: 0 },
  };
  const report = () => onProgress(structuredClone(p));
  const base = `/import/${sessionId}`;

  try {
    report();
    for (const users of chunk(data.users, PEOPLE_PER_BATCH)) {
      if (signal.aborted) return { kind: 'paused', progress: p };
      await api(`${base}/users`, { json: { users }, signal });
      p.people.done += users.length;
      report();
    }

    p.step = 'conversations';
    for (const batch of chunk(channels, CHANNELS_PER_BATCH)) {
      if (signal.aborted) return { kind: 'paused', progress: p };
      await api(`${base}/channels`, { json: { channels: batch }, signal });
      p.conversations.done += batch.length;
      report();
    }

    p.step = 'messages';
    for (const c of channels) {
      for (const messages of chunk(data.messages.get(c.slackId) ?? [], MESSAGES_PER_BATCH)) {
        if (signal.aborted) return { kind: 'paused', progress: p };
        try {
          const res = await api<{ imported: number; skipped: number }>(`${base}/messages`, {
            json: { channelSlackId: c.slackId, messages },
            signal,
          });
          p.messages.imported += res.imported;
          p.messages.skipped += res.skipped;
        } catch (err) {
          if (err instanceof ApiError && err.code === 'import_daily_limit') {
            return { kind: 'daily-limit', progress: p, message: err.message };
          }
          throw err;
        }
        p.messages.done += messages.length;
        report();
      }
    }

    p.step = 'files';
    for (const f of files) {
      if (signal.aborted) return { kind: 'paused', progress: p };
      try {
        await api(`${base}/files`, { json: f, signal });
      } catch (err) {
        // A file that Slack no longer serves (or that's too big) is skipped, not fatal.
        if (signal.aborted) return { kind: 'paused', progress: p };
        if (!(err instanceof ApiError && FILE_SKIPPABLE.has(err.status))) throw err;
        p.files.failed += 1;
      }
      p.files.done += 1;
      report();
    }

    p.step = 'finishing';
    report();
    await api(`${base}/finish`, { json: {}, signal });
    return { kind: 'finished', progress: p };
  } catch (err) {
    if (signal.aborted) return { kind: 'paused', progress: p };
    return {
      kind: 'failed',
      progress: p,
      message:
        err instanceof ApiError
          ? err.message
          : 'The connection dropped. Continue to pick up where it stopped.',
    };
  }
}
