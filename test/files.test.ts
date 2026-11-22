import { beforeEach, describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { APP_URL, addMember, api, resetDb, setupWorkspace } from './helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.7\nfake pdf body');
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 3, 0, 0, 0]); // "MZ": a Windows program
const CSV = new TextEncoder().encode('room,area\nkitchen,18\n');
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');

async function upload(
  cookie: string,
  conversationId: string,
  bytes: Uint8Array,
  name: string,
  length?: number,
) {
  const res = await exports.default.fetch(`${APP_URL}/api/conversations/${conversationId}/files`, {
    method: 'POST',
    body: bytes,
    headers: {
      cookie,
      origin: APP_URL,
      'content-type': 'application/octet-stream',
      'content-length': String(length ?? bytes.byteLength),
      'x-file-name': encodeURIComponent(name),
    },
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const download = (cookie: string, fileId: string, inline = false) =>
  exports.default.fetch(`${APP_URL}/api/files/${fileId}${inline ? '?inline=1' : ''}`, {
    headers: { cookie },
  });

let n = 0;
const post = (cookie: string, id: string, body: string, fileIds?: string[]) =>
  api(`/api/conversations/${id}/messages`, {
    body: { body, clientMsgId: `f-${Date.now()}-${n++}`, ...(fileIds ? { fileIds } : {}) },
    cookie,
  });

async function team() {
  const owner = await setupWorkspace();
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  const ch = (
    await api('/api/conversations', { body: { name: 'drawings', kind: 'public' }, cookie: owner.cookie })
  ).json.conversation.id as string;
  await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
  return { owner, jaco, ch };
}

beforeEach(resetDb);

describe('uploads', () => {
  it('detects the real type from the bytes, not the name', async () => {
    const { owner, ch } = await team();
    expect((await upload(owner.cookie, ch, PNG, 'plan.png')).json.file.mime).toBe('image/png');
    expect((await upload(owner.cookie, ch, PDF, 'section.pdf')).json.file.mime).toBe('application/pdf');
    expect((await upload(owner.cookie, ch, CSV, 'areas.csv')).json.file.mime).toBe('text/csv');
    // A program renamed to .jpg, and HTML pretending to be text, are stored as opaque downloads.
    expect((await upload(owner.cookie, ch, EXE, 'photo.jpg')).json.file.mime).toBe(
      'application/octet-stream',
    );
    expect((await upload(owner.cookie, ch, HTML, 'notes.txt')).json.file.mime).toBe(
      'application/octet-stream',
    );
  });

  it('refuses files over 25 MB before reading them, and empty files', async () => {
    const { owner, ch } = await team();
    expect((await upload(owner.cookie, ch, PNG, 'huge.png', 26 * 1024 * 1024)).status).toBe(413);
    expect((await upload(owner.cookie, ch, new Uint8Array(), 'empty.txt', 0)).status).toBe(411);
  });

  it('strips paths and unsafe characters from file names', async () => {
    const { owner, ch } = await team();
    const res = await upload(owner.cookie, ch, CSV, '../../etc/pass"wd<1>.csv');
    expect(res.json.file.name).toBe('passwd1.csv');
  });

  it('only lets people who can post upload: 404 for private outsiders, 403 before joining a public channel', async () => {
    const { owner, ch } = await team();
    const aisha = await addMember(owner.cookie, 'aisha@example.com', 'member');
    const secret = (
      await api('/api/conversations', { body: { name: 'secret', kind: 'private' }, cookie: owner.cookie })
    ).json.conversation.id as string;
    expect((await upload(aisha.cookie, secret, PNG, 'x.png')).status).toBe(404);
    expect((await upload(aisha.cookie, ch, PNG, 'x.png')).status).toBe(403);
  });
});

describe('attaching files to messages', () => {
  it('attaches uploaded files and shows them in history and the Files view', async () => {
    const { owner, ch } = await team();
    const f = (await upload(owner.cookie, ch, PDF, 'VW-section-B-B.pdf')).json.file;
    const sent = await post(owner.cookie, ch, 'Kitchen section is up', [f.id]);
    expect(sent.status).toBe(201);
    expect(sent.json.message.files.map((x: { name: string }) => x.name)).toEqual(['VW-section-B-B.pdf']);

    const history = await api(`/api/conversations/${ch}/messages`, { cookie: owner.cookie });
    expect(history.json.messages[0].files[0].id).toBe(f.id);
    const files = await api(`/api/conversations/${ch}/files`, { cookie: owner.cookie });
    expect(files.json.files.map((x: { id: string }) => x.id)).toEqual([f.id]);
  });

  it('allows a files-only message but not an empty one', async () => {
    const { owner, ch } = await team();
    const f = (await upload(owner.cookie, ch, PNG, 'plan.png')).json.file;
    expect((await post(owner.cookie, ch, '', [f.id])).status).toBe(201);
    expect((await post(owner.cookie, ch, '')).status).toBe(400);
  });

  it('refuses to attach someone else’s file, a used file, or a file from another conversation', async () => {
    const { owner, jaco, ch } = await team();
    const other = (
      await api('/api/conversations', { body: { name: 'other', kind: 'public' }, cookie: owner.cookie })
    ).json.conversation.id as string;
    const jacos = (await upload(jaco.cookie, ch, PNG, 'jaco.png')).json.file;
    expect((await post(owner.cookie, ch, 'stealing', [jacos.id])).status).toBe(404);

    const mine = (await upload(owner.cookie, ch, PNG, 'mine.png')).json.file;
    await post(owner.cookie, ch, 'first', [mine.id]);
    expect((await post(owner.cookie, ch, 'again', [mine.id])).status).toBe(404);
    expect(
      (
        await post(owner.cookie, other, 'moved', [
          (await upload(owner.cookie, ch, PNG, 'y.png')).json.file.id,
        ])
      ).status,
    ).toBe(404);
  });
});

describe('downloads', () => {
  it('serves files to members with safe headers', async () => {
    const { owner, jaco, ch } = await team();
    const f = (await upload(owner.cookie, ch, CSV, 'areas.csv')).json.file;
    await post(owner.cookie, ch, 'areas', [f.id]);
    const res = await download(jaco.cookie, f.id);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CSV);
    expect(res.headers.get('content-type')).toBe('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="areas\.csv"/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });

  it('shows images and PDFs inline only when asked, and never anything else', async () => {
    const { owner, ch } = await team();
    const png = (await upload(owner.cookie, ch, PNG, 'plan.png')).json.file;
    const exe = (await upload(owner.cookie, ch, EXE, 'photo.jpg')).json.file;
    await post(owner.cookie, ch, 'two files', [png.id, exe.id]);
    expect((await download(owner.cookie, png.id, true)).headers.get('content-disposition')).toMatch(
      /^inline/,
    );
    expect((await download(owner.cookie, exe.id, true)).headers.get('content-disposition')).toMatch(
      /^attachment/,
    );
  });

  it('hides files from anyone who cannot read the conversation', async () => {
    const { owner, ch } = await team();
    const secret = (
      await api('/api/conversations', { body: { name: 'secret', kind: 'private' }, cookie: owner.cookie })
    ).json.conversation.id as string;
    const f = (await upload(owner.cookie, secret, PDF, 'salaries.pdf')).json.file;
    await post(owner.cookie, secret, 'confidential', [f.id]);
    const aisha = await addMember(owner.cookie, 'aisha@example.com', 'member');
    expect((await download(aisha.cookie, f.id)).status).toBe(404);
    expect((await download('', f.id)).status).toBe(401);

    const guestChannel = (
      await api('/api/conversations', { body: { name: 'client', kind: 'private' }, cookie: owner.cookie })
    ).json.conversation.id as string;
    const guest = await addMember(owner.cookie, 'henk@example.com', 'guest', [guestChannel]);
    const pub = (await upload(owner.cookie, ch, PNG, 'public.png')).json.file;
    await post(owner.cookie, ch, 'public file', [pub.id]);
    expect((await download(guest.cookie, pub.id)).status).toBe(404);
  });

  it('keeps an unsent upload private to its uploader', async () => {
    const { owner, jaco, ch } = await team();
    const pending = (await upload(owner.cookie, ch, PNG, 'draft.png')).json.file;
    expect((await download(owner.cookie, pending.id)).status).toBe(200);
    expect((await download(jaco.cookie, pending.id)).status).toBe(404);
  });

  it('stops serving a file once its message is deleted', async () => {
    const { owner, jaco, ch } = await team();
    const f = (await upload(owner.cookie, ch, PNG, 'oops.png')).json.file;
    const msg = (await post(owner.cookie, ch, 'wrong file', [f.id])).json.message;
    await api(`/api/conversations/${ch}/messages/${msg.id}`, { method: 'DELETE', cookie: owner.cookie });
    expect((await download(jaco.cookie, f.id)).status).toBe(404);
    expect((await api(`/api/conversations/${ch}/files`, { cookie: owner.cookie })).json.files).toEqual([]);
  });
});
