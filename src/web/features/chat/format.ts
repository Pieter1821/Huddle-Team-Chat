// Huddle's message format: plain text with a few marks, written by the composer and read by
// renderMessage. Parsing happens here into plain data; the screen turns that data into React
// elements, so message text can never inject HTML or scripts.
//
//   **bold**   _italic_   ~~strike~~   `code`   ```code block```   > quote   <@USERID> mentions
//   http(s) links are detected automatically.
//
// No path aliases or DOM types here: the unit tests run this file directly.

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'bold' | 'italic' | 'strike'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'link'; href: string }
  | { t: 'mention'; target: string };

export type Block =
  | { t: 'paragraph'; children: Inline[] }
  | { t: 'quote'; children: Inline[] }
  | { t: 'codeblock'; text: string };

/** Splits a message into blocks: fenced code first (its contents are never formatted), then lines. */
export function parseMessage(body: string): Block[] {
  const blocks: Block[] = [];
  const parts = body.split(/```/);
  parts.forEach((part, i) => {
    // Odd parts sit between fences, unless the last fence was never closed (then it's literal).
    const isCode = i % 2 === 1 && i < parts.length - 1;
    if (isCode) {
      blocks.push({ t: 'codeblock', text: part.replace(/^\n/, '').replace(/\n$/, '') });
      return;
    }
    let text = i % 2 === 1 ? '```' + part : part;
    if (i > 0) text = text.replace(/^\n/, ''); // the newline right after a closing fence
    if (i < parts.length - 1) text = text.replace(/\n$/, ''); // the newline before an opening fence
    if (text === '') return;
    let quote: string[] = [];
    let para: string[] = [];
    const flush = () => {
      if (para.length) blocks.push({ t: 'paragraph', children: parseInline(para.join('\n')) });
      if (quote.length) blocks.push({ t: 'quote', children: parseInline(quote.join('\n')) });
      para = [];
      quote = [];
    };
    for (const line of text.split('\n')) {
      if (/^> ?/.test(line)) {
        if (para.length) flush();
        quote.push(line.replace(/^> ?/, ''));
      } else {
        if (quote.length) flush();
        para.push(line);
      }
    }
    flush();
  });
  return blocks.length ? blocks : [{ t: 'paragraph', children: [] }];
}

const MENTION = /^<@([0-9A-HJKMNP-TV-Z]{26}|channel|here)>/;
const LINK = /^https?:\/\/[^\s<>"]+/;
const PAIRS: { open: string; t: 'bold' | 'italic' | 'strike' }[] = [
  { open: '**', t: 'bold' },
  { open: '~~', t: 'strike' },
  { open: '_', t: 'italic' },
];

/** Inline marks. A mark needs a closing partner on the same text, otherwise it stays literal. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const push = (node: Inline) => {
    if (buf) out.push({ t: 'text', text: buf });
    buf = '';
    out.push(node);
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const prev = text[i - 1];
    const atWordStart = i === 0 || /[\s([{"'*~_]/.test(prev ?? '');

    if (rest[0] === '`') {
      const end = rest.indexOf('`', 1);
      if (end > 1) {
        push({ t: 'code', text: rest.slice(1, end) });
        i += end + 1;
        continue;
      }
    }
    const mention = MENTION.exec(rest);
    if (mention?.[1]) {
      push({ t: 'mention', target: mention[1] });
      i += mention[0].length;
      continue;
    }
    if (atWordStart) {
      const link = LINK.exec(rest);
      if (link) {
        // Trailing punctuation usually ends the sentence, not the URL.
        const href = link[0].replace(/[.,!?;:)\]'"]+$/, '');
        push({ t: 'link', href });
        i += href.length;
        continue;
      }
      const pair = PAIRS.find((p) => rest.startsWith(p.open));
      if (pair) {
        const close = findClose(rest, pair.open);
        if (close > pair.open.length) {
          push({ t: pair.t, children: parseInline(rest.slice(pair.open.length, close)) });
          i += close + pair.open.length;
          continue;
        }
      }
    }
    buf += text[i];
    i += 1;
  }
  if (buf) out.push({ t: 'text', text: buf });
  return out;
}

/** Where a mark closes: not followed by a word character, and not straight after a space. */
function findClose(rest: string, open: string): number {
  let from = open.length;
  while (from < rest.length) {
    const at = rest.indexOf(open, from);
    if (at < 0) return -1;
    const before = rest[at - 1] ?? '';
    const after = rest[at + open.length] ?? '';
    if (!/\s/.test(before) && !/\w/.test(after)) return at;
    from = at + 1;
  }
  return -1;
}

/** One-line plain text for previews, notifications and screen reader summaries. */
export function plainText(body: string, nameOf: (userId: string) => string): string {
  return body
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/<@([0-9A-HJKMNP-TV-Z]{26})>/g, (_, id: string) => `@${nameOf(id)}`)
    .replace(/<@(channel|here)>/g, '@$1')
    .replace(/(\*\*|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ composer → message text */

/** The parts of a Tiptap document the composer produces (kept minimal so tests need no editor). */
export type EditorNode = {
  type: string;
  text?: string;
  marks?: { type: string }[];
  content?: EditorNode[];
  attrs?: Record<string, unknown>;
};

const MARK_SYNTAX: Record<string, string> = { bold: '**', italic: '_', strike: '~~', code: '`' };

/** Turns the composer's document into message text. */
export function toMessageText(doc: EditorNode): string {
  const blocks = (doc.content ?? []).map(blockText);
  return blocks
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blockText(node: EditorNode): string {
  switch (node.type) {
    case 'codeBlock':
      return '```\n' + (node.content ?? []).map((n) => n.text ?? '').join('') + '\n```';
    case 'blockquote':
      return (node.content ?? [])
        .map(blockText)
        .join('\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    default:
      return inlineText(node.content ?? []);
  }
}

function inlineText(nodes: EditorNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '\n';
      if (n.type === 'mention') return `<@${typeof n.attrs?.id === 'string' ? n.attrs.id : ''}>`;
      let text = n.text ?? '';
      const marks = (n.marks ?? []).map((m) => m.type).filter((t) => t in MARK_SYNTAX);
      if (marks.includes('code')) return '`' + text + '`';
      // Spaces stay outside the marks ("**bold** ", not "**bold **"), so they parse back.
      const lead = /^\s*/.exec(text)?.[0] ?? '';
      const trail = /\s*$/.exec(text)?.[0] ?? '';
      const core = text.trim();
      if (!core) return text;
      text = core;
      for (const m of marks) text = MARK_SYNTAX[m] + text + MARK_SYNTAX[m];
      return lead + text + trail;
    })
    .join('');
}
