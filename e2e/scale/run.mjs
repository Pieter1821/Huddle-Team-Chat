/* eslint-disable no-console -- a command-line report */
// Many-people test: fills a fresh Huddle with a team and a long history, then measures what people
// feel: opening the app, switching and scrolling back, search, and live delivery while many people
// talk at once. Runs against the same local server as the end-to-end tests (port 8790, its own
// empty database), so it never touches your own data.
//
//   npm run test:scale                       50 people, 20 channels, 24,000 messages
//   SCALE_PEOPLE=20 SCALE_MESSAGES=5000 npm run test:scale
//
// Numbers from a laptop are not production numbers (Cloudflare's network adds its own latency and
// runs on different machines), but they show how Huddle behaves as a workspace grows, and where
// time goes. Results are printed and saved to .wrangler/e2e/scale-report.json.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const ORIGIN = 'http://localhost:8790';
const LOG = '.wrangler/e2e/server.log';
const PEOPLE = Number(process.env.SCALE_PEOPLE ?? 50);
const CHANNELS = Number(process.env.SCALE_CHANNELS ?? 20);
const MESSAGES = Number(process.env.SCALE_MESSAGES ?? 24_000);
const BIG_SHARE = 0.4; // #general gets this share of the history (the long scroll-back)
const WORDS =
  'release deploy budget design review customer invoice roadmap sprint launch meeting draft bug fix login search mobile pricing contract hiring onboarding standup demo feedback metrics'.split(
    ' ',
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const now = () => performance.now();
const stats = (samples) => {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const r = (x) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s.at(-1) ?? 0) };
};

/* ------------------------------------------------------------------ server and sign-in */

const server = spawn('node', ['e2e/server.mjs'], { stdio: 'ignore', shell: false });
// The server starts Vite in a child process: stop the whole tree, or Vite keeps the port.
const stop = () => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else server.kill('SIGTERM');
};
process.on('exit', stop);
process.on('SIGINT', () => process.exit(1));

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${ORIGIN}/api/health`)).ok) return;
    } catch {
      // still starting
    }
    await sleep(500);
  }
  throw new Error('server did not start');
}

/** A person with their own cookie jar and (so sign-in limits behave as for real people) own address. */
class Person {
  constructor(email, ip) {
    this.email = email;
    this.ip = ip;
    this.cookie = '';
  }
  async call(path, { method, json } = {}) {
    const headers = { origin: ORIGIN, 'cf-connecting-ip': this.ip };
    if (this.cookie) headers.cookie = this.cookie;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${ORIGIN}/api${path}`, {
      method: method ?? (json === undefined ? 'GET' : 'POST'),
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
    const set = res.headers.getSetCookie();
    if (set.length) {
      const jar = new Map(
        this.cookie
          .split('; ')
          .filter(Boolean)
          .map((c) => c.split(/=(.*)/s).slice(0, 2)),
      );
      for (const c of set) {
        const [pair] = c.split(';');
        const [k, v] = pair.split(/=(.*)/s);
        jar.set(k, v);
      }
      this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        `${method ?? (json === undefined ? 'GET' : 'POST')} ${path}: ${res.status} ${text.slice(0, 200)}`,
      );
    return text ? JSON.parse(text) : null;
  }
  async signIn() {
    const before = readFileSync(LOG, 'utf8').length;
    await this.call('/auth/email-otp/send-verification-otp', {
      json: { email: this.email, type: 'sign-in' },
    });
    let code;
    for (let i = 0; i < 100 && !code; i++) {
      await sleep(50);
      const blocks = readFileSync(LOG, 'utf8').slice(before).split('[email] to: ');
      code = /(\d{6}) is your .+ sign-in code/.exec(
        blocks.filter((b) => b.startsWith(this.email)).at(-1) ?? '',
      )?.[1];
    }
    if (!code) throw new Error(`no sign-in code for ${this.email}`);
    const { user } = await this.call('/auth/sign-in/email-otp', { json: { email: this.email, otp: code } });
    this.id = user.id;
  }
  /** Opens a live socket and records when each event arrives. */
  socket(path) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${ORIGIN.replace('http', 'ws')}/api/realtime${path}`, {
        headers: { origin: ORIGIN, cookie: this.cookie },
      });
      const events = [];
      ws.onmessage = (e) => events.push({ at: now(), event: JSON.parse(String(e.data)) });
      ws.onopen = () => resolve({ ws, events });
      ws.onerror = () => reject(new Error(`socket ${path} failed for ${this.email}`));
    });
  }
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function pool(items, limit, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

/* ------------------------------------------------------------------ build the workspace */

const report = { setup: { people: PEOPLE, channels: CHANNELS + 1, messages: MESSAGES }, results: {} };
// Results are saved after every step, so a run that's stopped part-way keeps what it measured.
const save = () => writeFileSync('.wrangler/e2e/scale-report.json', JSON.stringify(report, null, 2));
const step = (text) => {
  save();
  console.log(`
▸ ${text}`);
};

await waitForServer();
step(`Team of ${PEOPLE}`);
const owner = new Person('owner@e2e.test', '198.51.100.1');
await owner.signIn();
await owner.call('/setup', { json: { workspaceName: 'Scale Test Co', yourName: 'Olive Owner' } });

const channels = [];
for (let i = 1; i <= CHANNELS; i++) {
  const { conversation } = await owner.call('/conversations', {
    json: { name: `${pick(WORDS)}-${i}`, kind: 'public' },
  });
  channels.push(conversation.id);
}
const general = (await owner.call('/conversations')).conversations.find((c) => c.name === 'general').id;

const people = [owner];
await pool(
  Array.from({ length: PEOPLE - 1 }, (_, i) => i + 1),
  8,
  async (i) => {
    const p = new Person(`person${i}@scale.test`, `198.51.${100 + Math.floor(i / 250)}.${(i % 250) + 2}`);
    await owner.call('/invitations', { json: { email: p.email, role: 'member' } });
    await p.signIn();
    await p.call('/me', { method: 'PATCH', json: { name: `Person ${i}` } });
    for (const c of channels) await p.call(`/conversations/${c}/join`, { json: {} });
    people.push(p);
  },
);
console.log(`  ${people.length} people signed in, ${CHANNELS + 1} channels`);

step(`History: ${MESSAGES.toLocaleString()} messages`);
// #general gets a long history (the scroll-back test); the rest is spread over the other channels.
const plan = [];
const bigCount = Math.round(MESSAGES * BIG_SHARE);
for (let i = 0; i < MESSAGES; i++) plan.push(i < bigCount ? general : channels[i % channels.length]);
const byChannel = new Map();
for (const c of plan) byChannel.set(c, (byChannel.get(c) ?? 0) + 1);
const recent = new Map(); // channel → recent top-level message ids (for thread replies)
let sent = 0;
let n = 0;
const postTimes = [];
const started = now();
// One sender per channel at a time (each channel has one ordered writer), all channels in parallel.
await Promise.all(
  [...byChannel].map(async ([channel, count]) => {
    for (let i = 0; i < count; i++) {
      const author = pick(people);
      const words = Array.from({ length: 4 + Math.floor(Math.random() * 18) }, () => pick(WORDS)).join(' ');
      const mention = Math.random() < 0.08 ? `<@${pick(people).id}> ` : '';
      const parents = recent.get(channel) ?? [];
      const parentId = parents.length && Math.random() < 0.06 ? pick(parents) : undefined;
      const t = now();
      const { message } = await author.call(`/conversations/${channel}/messages`, {
        json: {
          body: `${mention}${words}`,
          clientMsgId: `scale-${String(n++).padStart(6, '0')}`,
          ...(parentId ? { parentId } : {}),
        },
      });
      postTimes.push(now() - t);
      if (!parentId) recent.set(channel, [...parents.slice(-30), message.id]);
      if (++sent % 2000 === 0) {
        const rate = sent / ((now() - started) / 1000);
        console.log(`  ${sent.toLocaleString()} sent (${Math.round(rate)}/s)`);
      }
    }
  }),
);
report.results.sendWhileFilling = {
  ...stats(postTimes),
  perSecond: Math.round(sent / ((now() - started) / 1000)),
};

/* ------------------------------------------------------------------ measure the API */

async function timed(times, fn) {
  const samples = [];
  for (let i = 0; i < times; i++) {
    const t = now();
    await fn(i);
    samples.push(now() - t);
  }
  return stats(samples);
}

step('Opening the app and a conversation');
const someone = people[7] ?? owner;
report.results.sidebar = await timed(30, () => someone.call('/conversations'));
report.results.members = await timed(30, () => someone.call('/members'));
report.results.openGeneral = await timed(30, () =>
  someone.call(`/conversations/${general}/messages?limit=50`),
);

step('Scrolling back through #general');
const pageTimes = [];
let before;
let pages = 0;
for (;;) {
  const t = now();
  const page = await someone.call(
    `/conversations/${general}/messages?limit=50${before ? `&before=${before}` : ''}`,
  );
  pageTimes.push(now() - t);
  pages++;
  if (!page.hasMore || !page.messages.length) break;
  before = page.messages[0].seq;
}
report.results.scrollBackPage = { ...stats(pageTimes), pages };

step('Search');
const queries = [
  ...WORDS.slice(0, 10),
  'release deploy',
  'budget review customer',
  'zzznothing',
  'lau',
  'Person',
];
report.results.search = await timed(queries.length * 2, (i) =>
  someone.call(`/search?q=${encodeURIComponent(queries[i % queries.length])}`),
);
report.results.mentions = await timed(20, () => someone.call('/activity/mentions'));

/* ------------------------------------------------------------------ live delivery */

step(`Live: ${people.length} people connected, half of them talking at once`);
// Everyone has the app open: the workspace socket (presence, badges) and #general, from now on.
const latest = (await owner.call(`/conversations/${general}/messages?limit=1`)).messages.at(-1).seq;
const hubs = await Promise.all(people.map((p) => p.socket('/socket')));
const rooms = await Promise.all(
  people.map((p) => p.socket(`/conversations/${general}/socket?after=${latest}`)),
);
await sleep(500);
const talkers = people.slice(0, Math.ceil(people.length / 2));
const sentAt = new Map();
await Promise.all(
  talkers.map(async (p, i) => {
    for (let k = 0; k < 4; k++) {
      const id = `live-msg-${i}-${k}`;
      sentAt.set(id, now());
      await p.call(`/conversations/${general}/messages`, {
        json: { body: `live ${pick(WORDS)}`, clientMsgId: id },
      });
    }
  }),
);
const expected = talkers.length * 4;
const deadline = now() + 15_000;
while (now() < deadline) {
  const done = rooms.every(
    (r) => r.events.filter((e) => e.event.type === 'message.created').length >= expected,
  );
  if (done) break;
  await sleep(100);
}
const delivery = [];
let missing = 0;
let outOfOrder = 0;
for (const r of rooms) {
  const created = r.events.filter((e) => e.event.type === 'message.created');
  missing += Math.max(0, expected - created.length);
  const seqs = r.events.map((e) => e.event.seq).filter((s) => typeof s === 'number');
  for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) outOfOrder++;
  for (const e of created) {
    const t = sentAt.get(e.event.data?.message?.clientMsgId);
    if (t) delivery.push(e.at - t);
  }
}
report.results.liveDelivery = {
  ...stats(delivery),
  receivers: rooms.length,
  perReceiver: expected,
  missing,
  outOfOrder,
};
for (const r of rooms) r.ws.close();
for (const h of hubs) h.ws.close();

/* ------------------------------------------------------------------ in the browser */

step('In the browser: open #general and scroll back 20 pages');
const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
const context = await browser.newContext({ baseURL: ORIGIN });
await context.addCookies(
  owner.cookie.split('; ').map((c) => {
    const [name, value] = c.split(/=(.*)/s);
    return { name, value, domain: 'localhost', path: '/' };
  }),
);
const page = await context.newPage();
let t = now();
await page.goto(`/c/${general}`);
await page.getByRole('region', { name: 'Messages' }).getByRole('article').last().waitFor();
const firstPaint = now() - t;
const scroll = [];
for (let i = 0; i < 20; i++) {
  const count = await page.locator('section[aria-label="Messages"] article').count();
  t = now();
  await page.evaluate(
    'document.querySelector(\'section[aria-label="Messages"]\').parentElement.scrollTop = 0',
  );
  await page
    .waitForFunction(
      (c) => document.querySelectorAll('section[aria-label="Messages"] article').length > c,
      count,
      {
        timeout: 10_000,
      },
    )
    .catch(() => undefined);
  scroll.push(now() - t);
}
const articles = await page.locator('section[aria-label="Messages"] article').count();
const heapMb = await page.evaluate(
  'performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null',
);
const box = page.getByRole('textbox', { name: 'Message #general' });
await box.click();
t = now();
await page.keyboard.type('Typing with a long history loaded above', { delay: 0 });
const typing = now() - t;
// One real send, with the history loaded: from Enter to the message showing as sent.
t = now();
await page.keyboard.press('Enter');
await page.getByRole('article').filter({ hasText: 'Typing with a long history' }).last().waitFor();
const ownSend = now() - t;
report.results.browser = {
  openConversationMs: Math.round(firstPaint),
  loadOlderPage: stats(scroll),
  messagesInPage: articles,
  jsHeapMb: heapMb,
  type40CharsMs: Math.round(typing),
  sendToShownMs: Math.round(ownSend),
};
await browser.close();

/* ------------------------------------------------------------------ report */

save();
console.log('\n=== Results (milliseconds) ===');
for (const [k, v] of Object.entries(report.results)) console.log(k.padEnd(18), JSON.stringify(v));
process.exit(0);
