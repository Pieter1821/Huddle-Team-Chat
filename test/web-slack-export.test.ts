// The browser-side reader for Slack export zips.
import { describe, expect, it } from 'vitest';
import { ExportError, chunk, parseSlackExport } from '../src/web/features/admin/slack-export';

const enc = new TextEncoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v));

/** A tiny export in Slack's documented layout, optionally inside a top-level folder. */
function sampleExport(root = '') {
  return {
    [`${root}users.json`]: json([
      {
        id: 'U01AAAA',
        name: 'olive',
        real_name: 'Olive Owner',
        profile: { email: 'OLIVE@Example.com', display_name: 'Olive' },
      },
      { id: 'U02BBBB', name: 'sam', profile: { email: 'not-an-email' } },
      { id: 'bad id', name: 'ignored' },
    ]),
    [`${root}channels.json`]: json([
      { id: 'C01GEN', name: 'general', members: ['U01AAAA', 'U02BBBB'], topic: { value: 'Everyone' } },
      { id: 'C02OLD', name: 'old-news', is_archived: true, members: [], purpose: { value: 'Retired' } },
    ]),
    [`${root}groups.json`]: json([{ id: 'G01PRIV', name: 'leadership', members: ['U01AAAA'] }]),
    [`${root}dms.json`]: json([{ id: 'D01DM', members: ['U01AAAA', 'U02BBBB'] }]),
    [`${root}general/2024-03-02.json`]: json([
      { ts: '1709373600.000300', user: 'U02BBBB', text: 'reply', thread_ts: '1709373600.000100' },
      {
        ts: '1709373600.000100',
        user: 'U01AAAA',
        text: 'Kickoff <@U02BBBB>',
        thread_ts: '1709373600.000100',
        reactions: [{ name: 'tada', users: ['U02BBBB'], count: 1 }],
        files: [{ name: 'plan.pdf', url_private_download: 'https://files.slack.com/files-pri/T1/plan.pdf' }],
      },
    ]),
    [`${root}general/2024-03-01.json`]: json([
      { ts: '1709287200.000100', user: 'U01AAAA', text: 'First!' },
      { ts: 'not-a-ts', text: 'dropped' },
      { ts: '1709287300.000100', subtype: 'channel_join', user: 'U02BBBB', text: 'joined' },
    ]),
    [`${root}general/notes.txt`]: enc.encode('not a day file'),
    [`${root}D01DM/2024-03-03.json`]: json([{ ts: '1709460000.000100', user: 'U02BBBB', text: 'hi' }]),
    [`${root}leadership/2024-03-01.json`]: enc.encode('{ broken json'),
  };
}

describe('reading a Slack export', () => {
  it('maps people, keeping valid emails (lower-cased) and display names', () => {
    const { users } = parseSlackExport(sampleExport());
    expect(users).toEqual([
      { slackId: 'U01AAAA', name: 'Olive', realName: 'Olive Owner', email: 'olive@example.com' },
      { slackId: 'U02BBBB', name: 'sam' },
    ]);
  });

  it('maps every kind of conversation with topics, archive state and members', () => {
    const { channels } = parseSlackExport(sampleExport());
    expect(channels).toEqual([
      {
        slackId: 'C01GEN',
        kind: 'public',
        name: 'general',
        topic: 'Everyone',
        memberSlackIds: ['U01AAAA', 'U02BBBB'],
      },
      {
        slackId: 'C02OLD',
        kind: 'public',
        name: 'old-news',
        topic: 'Retired',
        archived: true,
        memberSlackIds: [],
      },
      { slackId: 'G01PRIV', kind: 'private', name: 'leadership', memberSlackIds: ['U01AAAA'] },
      { slackId: 'D01DM', kind: 'dm', memberSlackIds: ['U01AAAA', 'U02BBBB'] },
    ]);
  });

  it('reads messages oldest first across day files, with threads, reactions and files', () => {
    const exp = parseSlackExport(sampleExport());
    const general = exp.messages.get('C01GEN')!;
    expect(general.map((m) => m.ts)).toEqual([
      '1709287200.000100',
      '1709287300.000100',
      '1709373600.000100',
      '1709373600.000300',
    ]);
    // The thread's first message isn't a reply to itself; the reply points at it.
    expect(general[2]).toEqual({
      ts: '1709373600.000100',
      user: 'U01AAAA',
      text: 'Kickoff <@U02BBBB>',
      reactions: [{ name: 'tada', users: ['U02BBBB'] }],
    });
    expect(general[3]?.threadTs).toBe('1709373600.000100');
    expect(general[1]?.subtype).toBe('channel_join'); // the server decides what to skip
    expect(exp.files).toEqual([
      {
        channelSlackId: 'C01GEN',
        ts: '1709373600.000100',
        name: 'plan.pdf',
        url: 'https://files.slack.com/files-pri/T1/plan.pdf',
      },
    ]);
    expect(exp.messages.get('D01DM')).toHaveLength(1);
    expect(exp.messages.get('G01PRIV')).toEqual([]); // its only day file was unreadable
  });

  it('summarises what will be imported', () => {
    expect(parseSlackExport(sampleExport()).summary).toEqual({
      people: 2,
      publicChannels: 2,
      privateChannels: 1,
      directMessages: 1,
      messages: 5,
      files: 1,
      from: '2024-03-01T10:00:00.000Z',
      to: '2024-03-03T10:00:00.000Z',
    });
  });

  it('works when the export sits inside a folder', () => {
    expect(parseSlackExport(sampleExport('acme-slack-export/')).summary.messages).toBe(5);
  });

  it('explains when the zip isn’t a Slack export', () => {
    expect(() => parseSlackExport({ 'photos/cat.json': json([]) })).toThrow(ExportError);
  });

  it('batches lists to the API’s limits', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 15)).toEqual([]);
  });
});
