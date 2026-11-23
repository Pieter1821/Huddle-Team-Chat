// Pure logic behind the chat screen: the message format and how live events update a conversation.
import { describe, expect, it } from 'vitest';
import type { ConversationEvent, MessageDto } from '../src/shared/events';
import { parseInline, parseMessage, plainText, toMessageText } from '../src/web/features/chat/format';
import {
  addPending,
  applyEvent,
  applyEvents,
  markPending,
  prependOlder,
  upsertConfirmed,
  type Feed,
} from '../src/web/features/chat/feed-state';

const USER = '01J0000000000000000000000A';

describe('message format', () => {
  it('reads bold, italic, strike, code, links and mentions', () => {
    expect(parseInline(`**hi** _there_ ~~old~~ \`x()\` see https://example.com/a. <@${USER}>`)).toEqual([
      { t: 'bold', children: [{ t: 'text', text: 'hi' }] },
      { t: 'text', text: ' ' },
      { t: 'italic', children: [{ t: 'text', text: 'there' }] },
      { t: 'text', text: ' ' },
      { t: 'strike', children: [{ t: 'text', text: 'old' }] },
      { t: 'text', text: ' ' },
      { t: 'code', text: 'x()' },
      { t: 'text', text: ' see ' },
      { t: 'link', href: 'https://example.com/a' },
      { t: 'text', text: '. ' },
      { t: 'mention', target: USER },
    ]);
  });

  it('leaves unmatched marks and snake_case words alone', () => {
    expect(parseInline('a ** b and snake_case_name and 2*3')).toEqual([
      { t: 'text', text: 'a ** b and snake_case_name and 2*3' },
    ]);
  });

  it('never formats inside code, and never treats javascript: as a link', () => {
    expect(parseInline('`**not bold**` javascript:alert(1)')).toEqual([
      { t: 'code', text: '**not bold**' },
      { t: 'text', text: ' javascript:alert(1)' },
    ]);
  });

  it('splits code blocks, quotes and paragraphs', () => {
    expect(parseMessage('look:\n```\nconst a = 1;\n**x**\n```\n> quoted\nafter')).toEqual([
      { t: 'paragraph', children: [{ t: 'text', text: 'look:' }] },
      { t: 'codeblock', text: 'const a = 1;\n**x**' },
      { t: 'quote', children: [{ t: 'text', text: 'quoted' }] },
      { t: 'paragraph', children: [{ t: 'text', text: 'after' }] },
    ]);
  });

  it('shows an unclosed fence as text', () => {
    expect(parseMessage('```oops')).toEqual([{ t: 'paragraph', children: [{ t: 'text', text: '```oops' }] }]);
  });

  it('writes composer documents as message text that reads back the same', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'ship ' },
            { type: 'text', text: 'it ', marks: [{ type: 'bold' }] },
            { type: 'mention', attrs: { id: USER } },
            { type: 'hardBreak' },
            { type: 'text', text: 'now', marks: [{ type: 'italic' }] },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'npm run check' }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'wise' }] }] },
      ],
    };
    const text = toMessageText(doc);
    expect(text).toBe(`ship **it** <@${USER}>\n_now_\n\`\`\`\nnpm run check\n\`\`\`\n> wise`);
    expect(parseMessage(text).map((b) => b.t)).toEqual(['paragraph', 'codeblock', 'quote']);
  });

  it('makes one-line previews with names', () => {
    expect(plainText(`**hey** <@${USER}>\n\`code\``, () => 'Sam')).toBe('hey @Sam code');
  });
});

const msg = (seq: number, extra: Partial<MessageDto> = {}): MessageDto => ({
  id: `m${seq}`,
  conversationId: 'c1',
  seq,
  authorId: 'u1',
  body: `message ${seq}`,
  parentId: null,
  alsoInChannel: false,
  replyCount: 0,
  lastReplyAt: null,
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-11-23T08:00:00.000Z',
  clientMsgId: null,
  webhookId: null,
  reactions: [],
  ...extra,
});

const created = (m: MessageDto): ConversationEvent => ({
  type: 'message.created',
  conversationId: 'c1',
  seq: m.seq,
  at: m.createdAt,
  data: { message: m },
});

const feed = (lastSeq: number, messages: MessageDto[]): Feed => ({ messages, hasMore: false, lastSeq });

describe('live conversation feed', () => {
  it('applies the next event, ignores duplicates and reports gaps', () => {
    const start = feed(2, [msg(1), msg(2)]);
    const next = applyEvent(start, created(msg(3)));
    expect(next.kind === 'applied' && next.feed.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(applyEvent(start, created(msg(2))).kind).toBe('duplicate');
    expect(applyEvent(start, created(msg(5))).kind).toBe('gap');
  });

  it('applies a replayed batch in seq order, whatever order it arrived in', () => {
    const { feed: after, stop } = applyEvents(feed(1, [msg(1)]), [
      created(msg(3)),
      created(msg(2)),
      created(msg(2)),
    ]);
    expect(stop).toBeUndefined();
    expect(after.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(after.lastSeq).toBe(3);
  });

  it('replaces your sending copy with the server’s, whichever arrives first', () => {
    const sending = addPending(feed(1, [msg(1)]), { ...msg(0, { id: 'tmp', clientMsgId: 'abc12345' }) });
    const fromEvent = applyEvent(sending, created(msg(2, { clientMsgId: 'abc12345' })));
    expect(fromEvent.kind === 'applied' && fromEvent.feed.messages.map((m) => [m.id, m.pending])).toEqual([
      ['m1', undefined],
      ['m2', undefined],
    ]);

    // The send's response first, then the event: still one copy.
    const afterResponse = {
      ...sending,
      messages: upsertConfirmed(sending.messages, msg(2, { clientMsgId: 'abc12345' })),
    };
    const thenEvent = applyEvent(afterResponse, created(msg(2, { clientMsgId: 'abc12345' })));
    expect(thenEvent.kind === 'applied' && thenEvent.feed.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('keeps failed sends at the end until retried', () => {
    const sending = addPending(feed(1, [msg(1)]), msg(0, { id: 'tmp', clientMsgId: 'abc12345' }));
    const failed = markPending(sending, 'abc12345', 'failed');
    const next = applyEvent(failed, created(msg(2)));
    expect(next.kind === 'applied' && next.feed.messages.map((m) => m.pending ?? m.seq)).toEqual([
      1,
      2,
      'failed',
    ]);
  });

  it('edits, deletes and counts thread replies on the parent', () => {
    let f = feed(1, [msg(1)]);
    const steps: ConversationEvent[] = [
      {
        type: 'message.edited',
        conversationId: 'c1',
        seq: 2,
        at: '',
        data: { messageId: 'm1', body: 'fixed', editedAt: 'now' },
      },
      created(msg(3, { parentId: 'm1' })),
      {
        type: 'message.deleted',
        conversationId: 'c1',
        seq: 4,
        at: '',
        data: { messageId: 'm3', parentId: 'm1', deletedAt: 'now' },
      },
    ];
    f = applyEvents(f, steps).feed;
    expect(f.messages).toHaveLength(1); // the reply lives in the thread, not the channel
    expect(f.messages[0]).toMatchObject({ body: 'fixed', editedAt: 'now', replyCount: 0 });
  });

  it('adds and removes reactions once per person', () => {
    const r = (
      seq: number,
      type: 'reaction.added' | 'reaction.removed',
      userId: string,
    ): ConversationEvent => ({
      type,
      conversationId: 'c1',
      seq,
      at: '',
      data: { messageId: 'm1', userId, emoji: '🎉' },
    });
    const f = applyEvents(feed(1, [msg(1)]), [
      r(2, 'reaction.added', 'u1'),
      r(3, 'reaction.added', 'u2'),
      r(4, 'reaction.removed', 'u1'),
    ]).feed;
    expect(f.messages[0]?.reactions).toEqual([{ emoji: '🎉', count: 1, userIds: ['u2'] }]);
  });

  it('asks for a reload after an import, and merges older pages without repeats', () => {
    const imported: ConversationEvent = {
      type: 'history.imported',
      conversationId: 'c1',
      seq: 2,
      at: '',
      data: { fromSeq: 2, toSeq: 2, count: 1 },
    };
    expect(applyEvent(feed(1, [msg(1)]), imported).kind).toBe('reload');
    expect(
      prependOlder(feed(3, [msg(2), msg(3)]), [msg(1), msg(2)], false).messages.map((m) => m.seq),
    ).toEqual([1, 2, 3]);
  });
});
