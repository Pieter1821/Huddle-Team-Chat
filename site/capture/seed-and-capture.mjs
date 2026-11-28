// Seeds a believable demo workspace into a private copy of Huddle and captures the real app:
// screenshots (desktop and phone) for site/src/assets/screens and short clips for site/public/media,
// plus site/capture/manifest.json describing every file.
//
//   npm run site:capture
//
// It runs its own server (port 8791, state in .wrangler/capture, settings in .dev.vars.capture,
// which is deleted at the end), the same way e2e/server.mjs does for the tests, so your local data,
// your dev server on 8787 and your .dev.vars are never touched. Needs Chrome and ffmpeg.
import { execFileSync, execSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request as httpRequest } from '@playwright/test';
import {
  bookingMockupHtml,
  emptyStatesHtml,
  launchPlanHtml,
  logoHtml,
  renderPdf,
  renderPng,
  slackExportZip,
} from './assets.mjs';
import { CURSOR_SCRIPT, encode, human, record, sleep } from './media.mjs';
import {
  CHANNELS,
  CONVERSATIONS,
  DOMAIN,
  LEFT_UNREAD,
  PENDING_INVITE,
  PEOPLE,
  WEBHOOK,
  WORKSPACE,
} from './story.mjs';

/* ------------------------------------------------------------------------------------ settings */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(ROOT);

const PORT = 8791;
const ORIGIN = `http://localhost:${PORT}`;
const STATE_DIR = '.wrangler/capture';
const LOG_FILE = `${STATE_DIR}/server.log`;
const WORK_DIR = `${STATE_DIR}/work`;
const VARS_FILE = '.dev.vars.capture';
const SCREENS = 'site/src/assets/screens';
const MEDIA = 'site/public/media';
const MANIFEST = 'site/capture/manifest.json';
// The setup key is the server's BETTER_AUTH_SECRET: only this run knows it.
const SETUP_KEY = randomBytes(24).toString('hex');
const OWNER = PEOPLE[0];

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

// Pick a real time zone where it is mid-afternoon right now, so the seeded day (09:00 to 15:50)
// reads naturally and the clips' new messages land just after it.
const TIME_ZONE = pickTimeZone(16.5);

const manifest = [];
const ids = {}; // person key → user id
const api = {}; // person key → signed-in API client
const conv = {}; // channel name or "dm:a,b" → conversation id
const posted = []; // { id, at } for backdating
const seqOf = {}; // message id → seq
const story = {}; // named messages the capture needs: { conversationKey, id }

/* -------------------------------------------------------------------------------------- server */

let server = null;

function writeVars() {
  writeFileSync(
    VARS_FILE,
    [`APP_URL=${ORIGIN}`, `ADMIN_EMAIL=${OWNER.email}`, `BETTER_AUTH_SECRET=${SETUP_KEY}`, ''].join('\n'),
  );
}

const serverEnv = () => ({ ...process.env, CLOUDFLARE_ENV: 'capture', HUDDLE_STATE_DIR: STATE_DIR });

async function startServer() {
  const log = createWriteStream(LOG_FILE, { flags: 'a' });
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { env: serverEnv(), shell: true });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => log.write(chunk));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`The server stopped; see ${LOG_FILE}`);
    try {
      if ((await fetch(`${ORIGIN}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error('The server did not start within 2 minutes');
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  // On Windows, killing the shell leaves Vite running: end the whole process tree.
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // already gone
    }
  } else server.kill('SIGTERM');
  await Promise.race([exited, sleep(10_000)]);
  server = null;
}

/* ----------------------------------------------------------------------------- time and codes */

function localMinutes(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date)
    .reduce((acc, p) => ({ ...acc, [p.type]: Number(p.value) }), {});
  return parts.hour * 60 + parts.minute;
}

function pickTimeZone(targetHour) {
  const zones = [
    'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago',
    'America/New_York', 'America/Halifax', 'America/Sao_Paulo', 'Atlantic/South_Georgia', 'Atlantic/Azores',
    'Europe/London', 'Europe/Amsterdam', 'Africa/Johannesburg', 'Europe/Istanbul', 'Asia/Dubai',
    'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo',
    'Asia/Yangon', 'Australia/Darwin', 'Australia/Brisbane', 'Pacific/Noumea', 'Pacific/Fiji', 'Pacific/Auckland',
    'Pacific/Tongatapu', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Atlantic/Cape_Verde', 'America/St_Johns',
  ];
  const off = (z) => Math.abs(localMinutes(z) - targetHour * 60);
  return zones.reduce((best, z) => (off(z) < off(best) ? z : best));
}

/** "HH:MM" today in the capture time zone, as epoch ms (never later than 5 minutes ago). */
function at(hhmm, jitterS = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = Date.now();
  const minuteStart = now - (now % 60_000) - (localMinutes(TIME_ZONE) - (h * 60 + m)) * 60_000;
  return Math.min(minuteStart + jitterS * 1000, now - 5 * 60_000);
}

/** The newest emailed sign-in code for an address (printed to the server log locally). */
async function codeFor(email, after) {
  for (let i = 0; i < 60; i++) {
    const blocks = readFileSync(LOG_FILE, 'utf8').slice(after).split('[email] to: ');
    const mine = blocks.filter((b) => b.startsWith(email));
    const code = /(\d{6}) is your .+ sign-in code/.exec(mine.at(-1) ?? '')?.[1];
    if (code) return code;
    await sleep(250);
  }
  throw new Error(`No sign-in code for ${email}`);
}

/** What an authenticator app shows (RFC 6238), like e2e/08-authenticator.spec.ts. */
function totp(key, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of key.replace(/\s+/g, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', bytes).update(counter).digest();
  const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

let ownerSecret = '';
let lastStep = 0;
/** A code the server hasn't seen yet (each 30-second code works once). */
async function nextOwnerCode() {
  let step = Math.floor(Date.now() / 30_000);
  while (step <= lastStep) {
    await sleep(1000);
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep = step;
  return totp(ownerSecret, step);
}

/* -------------------------------------------------------------------------------- browser bits */

let browser;

const fakeIp = (email) => {
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) % 250;
  return `198.51.100.${h + 1}`; // a documentation range, never a real address
};

async function apiClient(email, storageState) {
  // Each person gets their own address, as real people would: sign-in limits count per IP.
  return httpRequest.newContext({
    baseURL: ORIGIN,
    storageState,
    extraHTTPHeaders: { origin: ORIGIN, 'cf-connecting-ip': fakeIp(email) },
  });
}

async function call(client, method, path, data, headers) {
  const res = await client.fetch(path, { method, data, headers });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

const base = () => ({ baseURL: ORIGIN, locale: 'en-US', timezoneId: TIME_ZONE, colorScheme: 'dark' });

// What a visitor would see on a real install: links on the team's own address, not this test
// server's, and the Email page as it reads in production (not "printed in the terminal").
const PUBLIC_ORIGIN = 'https://chat.northwind.studio';
const LINK_ROUTES = /\/api\/(invitations|members\/[^/]+\/authenticator-reset|conversations\/[^/]+\/webhooks|admin\/email)(\?|$)/;
async function asProduction(context) {
  await context.route(LINK_ROUTES, async (route) => {
    const res = await route.fetch();
    let body = (await res.text()).replaceAll(ORIGIN, PUBLIC_ORIGIN);
    if (/\/api\/admin\/email(\?|$)/.test(route.request().url())) body = body.replace('"local":true', '"local":false');
    await route.fulfill({ response: res, body });
  });
  return context;
}

/** Contexts for screenshots (sharp, no pointer), phones, and recordings (with a pointer). */
async function desktop(storageState) {
  return asProduction(await browser.newContext({ ...base(), storageState, viewport: DESKTOP, deviceScaleFactor: 2 }));
}
async function phone(storageState) {
  return asProduction(
    await browser.newContext({
      ...base(),
      storageState,
      viewport: PHONE,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: PHONE_UA,
    }),
  );
}
async function film(storageState, viewport = DESKTOP) {
  const context = await browser.newContext({ ...base(), storageState, viewport, deviceScaleFactor: 1 });
  await context.addInitScript({ content: CURSOR_SCRIPT });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  return asProduction(context);
}

const nav = (page) => page.getByRole('navigation', { name: 'Conversations' });
const messages = (page) => page.getByRole('region', { name: 'Messages', exact: true });

/** Waits for the open conversation to finish loading its messages and images. */
async function settled(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 10_000 })
    .catch(() => {});
  await sleep(500);
}

/** Scrolls the panel holding `locator` to 'top', 'bottom' or a pixel offset. */
async function scrollPanel(locator, to) {
  await locator.evaluate((el, to) => {
    let box = el;
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY)))
      box = box.parentElement;
    if (box) box.scrollTop = to === 'top' ? 0 : to === 'bottom' ? box.scrollHeight : to;
  }, to);
  await sleep(300);
}

async function openConversation(page, key, path = '') {
  await page.goto(`/c/${conv[key]}${path}`);
  await messages(page).waitFor();
  await settled(page);
  // Images that load late can leave the list short of the newest message.
  await scrollPanel(messages(page), 'bottom');
  if (path.includes('/t/')) {
    const replies = page.getByRole('complementary', { name: 'Thread' }).getByRole('log', { name: 'Replies' });
    await replies.waitFor();
    await scrollPanel(replies, 'top'); // start from the post the thread hangs off
  }
}

/** A clean screenshot: nothing focused or hovered, animations finished. */
async function shot(page, name, { feature, alt, device = 'desktop', keepFocus = false, fullPage = false }) {
  if (!keepFocus) await page.evaluate(() => document.activeElement?.blur?.());
  const vp = page.viewportSize();
  if (device === 'desktop' && !keepFocus) await page.mouse.move(vp.width - 2, vp.height - 2);
  await settled(page);
  const path = `${SCREENS}/${name}-${device}.png`;
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', fullPage });
  manifest.push({
    name: `${name}-${device}`,
    type: 'screenshot',
    path,
    alt,
    viewport: device === 'desktop' ? '1440x900 @2x' : '390x844 @3x (phone)',
    feature,
  });
  console.log(`  screenshot ${path}`);
}

/** Records `fn` and encodes it to site/public/media/<name>.{mp4,webm,jpg}. */
async function clip(name, pages, fn, { feature, alt, trim = [0.3, 0.2], poster = 1, viewport, speed = 1 }) {
  const takes = [];
  for (const [i, page] of pages.entries()) takes.push(await record(page, `${WORK_DIR}/${name}-${i}`));
  await sleep(400);
  await fn();
  await sleep(900);
  const results = [];
  for (const t of takes) results.push(await t.stop());
  const out = `${MEDIA}/${name}`;
  const { seconds, crf } = encode(results, out, { trim, poster, speed, workDir: `${WORK_DIR}/${name}-0` });
  for (const ext of ['mp4', 'webm', 'jpg']) {
    manifest.push({
      name: `${name}.${ext}`,
      type: ext === 'jpg' ? 'poster' : 'video',
      path: `${out}.${ext}`,
      alt,
      viewport: viewport ?? '1440x900',
      feature,
      ...(ext === 'jpg' ? {} : { seconds: Math.round(seconds * 10) / 10 }),
    });
  }
  console.log(`  clip ${out}.mp4 (${seconds.toFixed(1)} s, crf ${crf})`);
}

/* --------------------------------------------------------------------------------------- seed */

const assets = {};

async function makeAssets() {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  assets.booking = { name: 'booking-flow-v3.png', mime: 'image/png', bytes: await renderPng(page, bookingMockupHtml) };
  assets.empty = { name: 'empty-states-v1.png', mime: 'image/png', bytes: await renderPng(page, emptyStatesHtml) };
  assets.plan = { name: 'Booking v2 beta launch plan.pdf', mime: 'application/pdf', bytes: await renderPdf(page, launchPlanHtml) };
  await context.close();
  const transparent = await browser.newContext({ deviceScaleFactor: 2 });
  const logoPage = await transparent.newPage();
  assets.logo = await renderPng(logoPage, logoHtml, { width: 600, height: 120, selector: '.logo' });
  await transparent.close();
  assets.slackZip = slackExportZip(PEOPLE);
}

async function upload(client, conversationId, file) {
  const res = await call(client, 'POST', `/api/conversations/${conversationId}/files`, file.bytes, {
    'content-type': file.mime,
    'x-file-name': encodeURIComponent(file.name),
  });
  return res.file.id;
}

const mentionText = (text) => text.replace(/@\{(\w+)\}/g, (_, key) => `<@${ids[key]}>`);
let clientMsg = 0;
const clientMsgId = () => `capture-${Date.now().toString(36)}-${(clientMsg++).toString(36)}`;

async function seed(ownerState) {
  console.log('Seeding the demo team…');
  api.maya = await apiClient(OWNER.email, ownerState);
  ids.maya = (await call(api.maya, 'GET', '/api/me')).user.id;

  // Everyone else: invited by Maya, then signed in with an emailed code, then named.
  for (const person of PEOPLE.slice(1)) {
    await call(api.maya, 'POST', '/api/invitations', { email: person.email, role: person.role });
    const client = await apiClient(person.email);
    const before = readFileSync(LOG_FILE, 'utf8').length;
    await call(client, 'POST', '/api/auth/email-otp/send-verification-otp', { email: person.email, type: 'sign-in' });
    const otp = await codeFor(person.email, before);
    await call(client, 'POST', '/api/auth/sign-in/email-otp', { email: person.email, otp });
    await call(client, 'PATCH', '/api/me', { name: person.name });
    ids[person.key] = (await call(client, 'GET', '/api/me')).user.id;
    api[person.key] = client;
  }

  // Channels (#general already exists) and who is in them.
  const existing = (await call(api.maya, 'GET', '/api/conversations')).conversations;
  for (const ch of CHANNELS) {
    let id = existing.find((c) => c.name === ch.name)?.id;
    if (!id) {
      id = (await call(api.maya, 'POST', '/api/conversations', { name: ch.name, kind: ch.kind, topic: ch.topic }))
        .conversation.id;
    }
    conv[ch.name] = id;
    const others = ch.members.filter((k) => k !== 'maya').map((k) => ids[k]);
    if (others.length) await call(api.maya, 'POST', `/api/conversations/${id}/members`, { userIds: others });
  }

  // The CI webhook, posting into #engineering.
  const hook = await call(api.maya, 'POST', `/api/conversations/${conv[WEBHOOK.channel]}/webhooks`, {
    name: WEBHOOK.name,
  });
  const hookPath = new URL(hook.url).pathname;

  // Messages, conversation by conversation, in time order (thread replies interleaved).
  for (const c of CONVERSATIONS) {
    const key = c.channel ?? `dm:${c.dm.join(',')}`;
    if (c.dm) {
      const starter = c.messages[0].by;
      const others = c.dm.filter((k) => k !== starter).map((k) => ids[k]);
      conv[key] = (await call(api[starter], 'POST', '/api/conversations/dm', { userIds: others })).conversation.id;
    }
    const id = conv[key];
    const timeline = c.messages.flatMap((m, i) => [
      { ...m, top: i },
      ...(m.replies ?? []).map((r) => ({ ...r, parentOf: i })),
    ]);
    timeline.sort((a, b) => a.at.localeCompare(b.at));
    const topIds = {};
    for (const [n, m] of timeline.entries()) {
      let message;
      if (m.by === 'bot') {
        await call(api.maya, 'POST', hookPath, { text: m.text });
        const page = await call(api.maya, 'GET', `/api/conversations/${id}/messages?limit=1`);
        message = page.messages.at(-1);
      } else {
        const fileIds = m.file ? [await upload(api[m.by], id, assets[m.file])] : undefined;
        message = (
          await call(api[m.by], 'POST', `/api/conversations/${id}/messages`, {
            body: mentionText(m.text),
            clientMsgId: clientMsgId(),
            ...(m.parentOf !== undefined ? { parentId: topIds[m.parentOf] } : {}),
            ...(fileIds ? { fileIds } : {}),
          })
        ).message;
      }
      if (m.top !== undefined) topIds[m.top] = message.id;
      posted.push({ id: message.id, at: at(m.at, (n * 7) % 50) });
      seqOf[message.id] = message.seq;
      if (m.readMarker) story[`marker:${key}`] = message.id;
      if (m.replies?.length) story[`thread:${key}`] ??= message.id;
      for (const [emoji, who] of Object.entries(m.reactions ?? {})) {
        for (const k of who) {
          await call(api[k], 'POST', `/api/conversations/${id}/messages/${message.id}/reactions`, { emoji });
        }
      }
    }
  }

  // Unread state: everyone has read everything, except what Maya should find waiting for her.
  for (const person of PEOPLE) {
    const list = (await call(api[person.key], 'GET', '/api/conversations')).conversations;
    for (const c of list) {
      const key = Object.keys(conv).find((k) => conv[k] === c.id);
      const unreadForMaya = person.key === 'maya' && LEFT_UNREAD.includes(key);
      const seq = unreadForMaya ? seqOf[story[`marker:${key}`]] : c.lastSeq;
      if (seq) await call(api[person.key], 'POST', `/api/conversations/${c.id}/read`, { seq });
    }
  }

  // An invitation still waiting, Maya's email summary settings, and her time zone.
  const pending = await call(api.maya, 'POST', '/api/invitations', PENDING_INVITE);
  story.inviteLink = new URL(pending.link).pathname;
  await call(api.maya, 'PATCH', '/api/me/preferences', { digest: 'daily', timezone: TIME_ZONE });
}

/** Moves every seeded message to its time of day (the API always stamps "now"). */
async function backdate() {
  console.log('Spreading the messages over the day…');
  const sql = [
    ...posted.map((p) => `UPDATE message SET created_at = ${p.at} WHERE id = '${p.id}';`),
    `UPDATE message SET last_reply_at = (SELECT max(r.created_at) FROM message r WHERE r.parent_id = message.id) WHERE reply_count > 0;`,
    `UPDATE file SET created_at = (SELECT m.created_at FROM message m WHERE m.id = file.message_id) WHERE message_id IS NOT NULL;`,
    // The setup and invitations happened before work started, 45 seconds apart from 08:20.
    `CREATE TABLE capture_order AS SELECT id, row_number() OVER (ORDER BY created_at) AS n FROM audit_log;`,
    `UPDATE audit_log SET created_at = ${at('08:20')} + 45000 * (SELECT n FROM capture_order o WHERE o.id = audit_log.id);`,
    `DROP TABLE capture_order;`,
  ].join('\n');
  const file = `${WORK_DIR}/backdate.sql`;
  writeFileSync(file, sql);
  await stopServer();
  execSync(`npx wrangler d1 execute DB --local --persist-to ${STATE_DIR} --file ${file}`, {
    env: serverEnv(),
    stdio: 'ignore',
  });
  await startServer();
}

/* ------------------------------------------------------------------------------------- capture */

/** First run, filmed: the owner proves it's them with the setup key, adds the app, names the team. */
async function captureOwnerSetup() {
  console.log('Owner setup…');
  // Stills first, from a context that stops before finishing.
  {
    const context = await desktop();
    const page = await context.newPage();
    await page.goto('/signin?owner=recover');
    await page.getByLabel('Your email').waitFor();
    await shot(page, 'owner-setup', {
      feature: 'First-run owner setup',
      alt: 'The first screen of a new Huddle: the owner enters their email and the setup key to start.',
    });
    await page.getByLabel('Your email').fill(OWNER.email);
    await page.getByLabel('Setup key').fill(SETUP_KEY);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('img', { name: /QR code/ }).waitFor();
    await shot(page, 'owner-setup-authenticator', {
      fullPage: true, // taller than the window
      feature: 'Authenticator app sign-in',
      alt: 'Setting up an authenticator app: a QR code to scan and a box for the 6-digit code it shows.',
    });
    await context.close();
  }

  const context = await film();
  const page = await context.newPage();
  const h = human(page);
  await page.goto('/signin?owner=recover');
  await page.getByLabel('Your email').waitFor();
  await settled(page);
  let state;
  await clip(
    'owner-setup',
    [page],
    async () => {
      await h.show();
      await h.click(page.getByLabel('Your email'));
      await h.type(OWNER.email);
      // A keystroke lost while the page was still settling would leave Continue disabled.
      if ((await page.getByLabel('Your email').inputValue()) !== OWNER.email) {
        await page.getByLabel('Your email').fill(OWNER.email);
      }
      await h.click(page.getByLabel('Setup key'));
      await sleep(250);
      await page.getByLabel('Setup key').fill(SETUP_KEY); // pasted from the deploy notes
      await sleep(400);
      const started = page.waitForResponse((r) => r.url().includes('/api/auth/authenticator/start'));
      const go = page.getByRole('button', { name: 'Continue' });
      await go.waitFor();
      await h.click(go);
      ownerSecret = (await (await started).json()).secret;
      await page.getByRole('img', { name: /QR code/ }).waitFor();
      await sleep(1600); // scanning with the phone
      await h.click(page.getByLabel('6-digit code'));
      await h.type(await nextOwnerCode(), { min: 90, max: 160 });
      await sleep(300);
      await h.click(page.getByRole('button', { name: 'Confirm' }));
      await page.getByLabel('Workspace name').waitFor();
      await sleep(500);
      await h.click(page.getByLabel('Workspace name'));
      await h.type(WORKSPACE);
      await h.click(page.getByLabel('Your name'));
      await h.type(OWNER.name);
      await sleep(250);
      await h.click(page.getByRole('button', { name: 'Create workspace' }));
      await nav(page).getByRole('link', { name: 'general' }).waitFor();
      await sleep(700);
      await h.click(nav(page).getByRole('link', { name: 'general' }));
      await page.getByRole('textbox', { name: 'Message #general' }).waitFor();
      await sleep(1200);
      state = await context.storageState();
    },
    {
      feature: 'First-run owner setup',
      alt: 'Setting up a new Huddle: the owner enters the setup key, adds an authenticator app, names the workspace and lands in #general.',
      poster: 3.8, // the QR code
      speed: 1.75, // the real thing takes 20 s; shown faster
    },
  );
  await context.close();
  return state;
}

async function capturePhone(state) {
  console.log('Phone screens…');
  const context = await phone(state);
  const page = await context.newPage();
  await page.goto('/');
  await nav(page).getByRole('link', { name: 'design' }).waitFor();
  await shot(page, 'sidebar', {
    device: 'phone',
    feature: 'Channels, direct messages and unread badges',
    alt: 'Huddle on a phone: the list of channels and direct messages, with unread conversations in bold and a mention count.',
  });
  await openConversation(page, 'design');
  await shot(page, 'channel', {
    device: 'phone',
    feature: 'Channels, messages, reactions and files',
    alt: 'A channel on a phone: messages with reactions, a shared design image and the message box.',
  });
  await openConversation(page, 'design', `/t/${story['thread:design']}`);
  await page.getByRole('complementary', { name: 'Thread' }).getByRole('log', { name: 'Replies' }).waitFor();
  await shot(page, 'thread', {
    device: 'phone',
    feature: 'Threads',
    alt: 'A thread on a phone: the original post with its image and five replies underneath.',
  });
  await page.goto('/settings');
  await page.getByRole('heading', { name: 'Authenticator app' }).waitFor();
  await shot(page, 'settings', {
    device: 'phone',
    feature: 'Personal settings',
    alt: 'Your settings on a phone: profile, authenticator app and notifications for this device.',
  });
  await context.close();

  const signedOut = await phone();
  const p = await signedOut.newPage();
  await p.goto('/signin');
  await p.getByLabel('Work email').waitFor();
  await shot(p, 'signin', {
    device: 'phone',
    feature: 'Passwordless sign-in',
    alt: 'Signing in on a phone: a work email box and a button that emails a one-time code.',
  });
  await signedOut.close();
}

/** Push needs a real push service; like the e2e tests, the browser's part is stood in for. */
const PUSH_STUB = `
  let current = null;
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
  Notification.requestPermission = () => Promise.resolve('granted');
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  PushManager.prototype.getSubscription = () => Promise.resolve(current);
  PushManager.prototype.subscribe = async (options) => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
    const auth = b64(crypto.getRandomValues(new Uint8Array(16)).buffer);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/capture-device';
    current = { endpoint, options: { applicationServerKey: options.applicationServerKey, userVisibleOnly: true },
      toJSON: () => ({ endpoint, keys: { p256dh, auth } }), unsubscribe: () => { current = null; return Promise.resolve(true); } };
    return current;
  };`;

async function captureDesktop(state) {
  console.log('Desktop screens…');
  const context = await desktop(state);
  const page = await context.newPage();

  await openConversation(page, 'design');
  await shot(page, 'channel', {
    feature: 'Channels, messages, reactions and files',
    alt: 'Huddle on a desktop: the #design channel with a shared mockup, reactions and a thread, next to the list of channels and direct messages.',
  });

  await openConversation(page, 'design', `/t/${story['thread:design']}`);
  await page.getByRole('complementary', { name: 'Thread' }).getByRole('log', { name: 'Replies' }).waitFor();
  await shot(page, 'thread', {
    feature: 'Threads',
    alt: 'A thread open beside the channel: feedback on a booking flow mockup, with a mention.',
  });

  // The @ list while writing a message.
  await openConversation(page, 'design');
  await page.getByRole('textbox', { name: 'Message #design' }).click();
  await page.keyboard.type('Looks great, thanks @pr', { delay: 20 });
  await page.getByRole('option', { name: 'Priya Raman' }).waitFor();
  await shot(page, 'mentions', {
    keepFocus: true,
    feature: '@mentions',
    alt: 'Writing a message and typing @pr: a list suggests Priya Raman to mention.',
  });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');

  // Search across messages, files, channels and people.
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Search' });
  await search.getByRole('searchbox').fill('staging');
  await search.locator('mark').first().waitFor();
  await shot(page, 'search', {
    keepFocus: true,
    feature: 'Search',
    alt: 'Search open over the app: results for “staging” from several channels, with the matching word highlighted.',
  });
  await page.keyboard.press('Escape');

  // Channel details: topic, notification level and members.
  await page.getByRole('button', { name: /^Details: \d+ members$/ }).click();
  await page.getByRole('dialog', { name: '#design' }).waitFor();
  await shot(page, 'channel-details', {
    feature: 'Channel details and notification levels',
    alt: 'The details of #design: its topic, how much it notifies you, and the people in it.',
  });
  await page.keyboard.press('Escape');

  await nav(page).getByRole('button', { name: 'Add a channel' }).click();
  await page.getByRole('dialog', { name: 'Browse channels' }).waitFor();
  await shot(page, 'browse-channels', {
    feature: 'Public and private channels',
    alt: 'Browsing the workspace’s public channels, each with its topic and member count.',
  });
  await page.keyboard.press('Escape');

  await nav(page).getByRole('button', { name: 'New message' }).click();
  await page.getByRole('dialog', { name: 'New message' }).waitFor();
  await shot(page, 'new-message', {
    feature: 'Direct messages',
    alt: 'Starting a direct message: a list of everyone in the workspace to pick from.',
  });
  await page.keyboard.press('Escape');

  await openConversation(page, 'leadership');
  await shot(page, 'private-channel', {
    feature: 'Public and private channels',
    alt: 'A private channel, marked with a lock, where four people plan hiring and budget.',
  });

  await openConversation(page, 'dm:maya,aiko,leila');
  await shot(page, 'group-dm', {
    feature: 'Direct messages',
    alt: 'A group direct message between three people planning a surprise for a colleague.',
  });

  // Settings, with this device's notifications turned on (as e2e/06 does) and the browser's
  // install offer present (Chrome only makes that offer to a visible window).
  await page.addInitScript({ content: PUSH_STUB });
  await page.goto('/settings');
  await page.getByRole('heading', { name: 'Authenticator app' }).waitFor();
  await page.evaluate(() => {
    const offer = new Event('beforeinstallprompt', { cancelable: true });
    offer.prompt = () => Promise.resolve();
    offer.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(offer);
  });
  const toggle = page.getByRole('switch', { name: /Notifications on this device/ });
  await toggle.click();
  await page.getByRole('button', { name: 'Send a test notification' }).waitFor();
  await scrollPanel(page.getByRole('heading', { name: 'Profile' }), 40); // the whole device card in view
  await shot(page, 'settings', {
    feature: 'Personal settings: authenticator app, notifications, install as an app',
    alt: 'Your settings: profile, authenticator app turned on, notifications on this device and an Install Huddle button.',
  });
  await page.mouse.wheel(0, 900);
  await shot(page, 'settings-email', {
    feature: 'Email summaries and do not disturb',
    alt: 'Email notification settings: a daily summary of missed mentions and messages, the wait before emailing, the time zone and a pause button.',
  });
  await toggle.click(); // leave no push subscription behind
  await page.getByRole('button', { name: 'Send a test notification' }).waitFor({ state: 'hidden' });

  // Admin.
  await page.goto('/admin/people');
  await page.getByRole('heading', { name: 'Invite people' }).waitFor();
  await shot(page, 'admin-people', {
    feature: 'Admin: people, roles and invitations',
    alt: 'Admin › People: invite someone by email with a role, a pending invitation, and the members with their roles.',
  });
  await page.mouse.wheel(0, 900);
  await shot(page, 'admin-members', {
    feature: 'Admin: people, roles and invitations',
    alt: 'The member list in Admin › People: each person’s role, with options to change it or deactivate them.',
  });

  await page.goto('/admin/webhooks');
  await page.getByLabel('Channel', { exact: true }).selectOption({ label: '#' + WEBHOOK.channel });
  await page.getByText(WEBHOOK.name).first().waitFor();
  await shot(page, 'admin-webhooks', {
    feature: 'Incoming webhooks',
    alt: 'Admin › Webhooks: a Deploy bot webhook posting build results into #engineering, and a form to add another.',
  });

  await page.goto('/admin/security');
  await page.getByRole('table').waitFor();
  await shot(page, 'admin-security-log', {
    feature: 'Security log',
    alt: 'Admin › Security log: who invited whom, created webhooks and changed settings, and when.',
  });

  await page.goto('/admin/usage');
  await page.getByRole('meter').first().waitFor();
  await shot(page, 'admin-usage', {
    feature: 'Usage against the free tier',
    alt: 'Admin › Usage: how much of the database and file storage the workspace uses.',
  });

  await page.goto('/admin/email');
  await page.getByText('Not set up. Invitations are shared as links').waitFor();
  await page.getByText('Set up email (about 5 minutes)').click();
  await page.getByText('myaccount.google.com/apppasswords').waitFor();
  await shot(page, 'admin-email', {
    feature: 'Optional email through Gmail',
    alt: 'Admin › Email: step-by-step instructions for sending invitations and summaries from a Gmail account with an app password.',
  });

  await page.goto('/admin/import');
  await page
    .getByLabel('Slack export zip')
    .setInputFiles({ name: 'northwind-slack-export.zip', mimeType: 'application/zip', buffer: assets.slackZip });
  await page.getByRole('heading', { name: 'Ready to import' }).waitFor();
  await shot(page, 'admin-import', {
    feature: 'Import from Slack',
    alt: 'Admin › Import: a Slack export checked before importing, with counts of the people, channels and messages it holds.',
  });

  await page.goto('/admin/export');
  await page.getByRole('button', { name: 'Download export' }).waitFor();
  await shot(page, 'admin-export', {
    feature: 'Export your data',
    alt: 'Admin › Export: download everything in the workspace as a zip file.',
  });

  // #engineering last: opening it clears the mention badge the other screens show.
  await openConversation(page, 'engineering');
  await shot(page, 'engineering', {
    feature: 'Code formatting and webhook messages',
    alt: 'The #engineering channel: build results posted by a webhook, a SQL snippet in a code block, and a mention.',
  });

  // Huddle's own offline page, from its service worker.
  await context.setOffline(true);
  await page.reload().catch(() => {});
  await page.getByRole('heading', { name: 'You’re offline' }).waitFor();
  await shot(page, 'offline', {
    feature: 'Installable app (service worker)',
    alt: 'Huddle’s offline page, shown instead of the browser’s error when there is no connection.',
  });
  await context.setOffline(false);
  await context.close();

  // Signed out.
  const out = await desktop();
  const p = await out.newPage();
  await p.goto('/signin');
  await p.getByLabel('Work email').waitFor();
  await shot(p, 'signin', {
    feature: 'Passwordless sign-in',
    alt: 'The sign-in page: enter your work email to get a one-time code, or use an authenticator app.',
  });
  await p.getByRole('button', { name: 'Use an authenticator app instead' }).click();
  await p.getByLabel('Code from your authenticator app').waitFor();
  await shot(p, 'signin-authenticator', {
    feature: 'Authenticator app sign-in',
    alt: 'Signing in with an authenticator app: work email and the 6-digit code from the app.',
  });
  await p.goto(story.inviteLink);
  await p.getByRole('heading', { name: `Join ${WORKSPACE}` }).waitFor();
  await shot(p, 'invitation', {
    feature: 'Invitations',
    alt: `An invitation link opened: “Join ${WORKSPACE}”, with who sent it and the invited email filled in.`,
  });
  await out.close();
}

async function captureClips(state) {
  console.log('Clips…');

  // Sharing an image in #design.
  {
    const context = await film(state);
    const page = await context.newPage();
    const h = human(page);
    await openConversation(page, 'design');
    await clip(
      'share-a-file',
      [page],
      async () => {
        await h.show();
        const chooser = page.waitForEvent('filechooser');
        await h.click(page.getByRole('button', { name: 'Attach files' }));
        await (await chooser).setFiles({ name: assets.empty.name, mimeType: 'image/png', buffer: assets.empty.bytes });
        await page.getByText('Ready').waitFor();
        await sleep(500);
        await h.click(page.getByRole('textbox', { name: 'Message #design' }));
        await h.type('First pass at the empty states for tomorrow’s crit. Rough, be gentle 🙂');
        await sleep(300);
        await page.keyboard.press('Enter');
        await messages(page).getByRole('img', { name: assets.empty.name }).waitFor();
        await settled(page);
        await sleep(1200);
      },
      {
        feature: 'Sharing files',
        alt: 'Attaching an image in #design, writing a caption and sending it: the image appears in the channel.',
        poster: 7,
      },
    );
    await context.close();
  }

  // Replying in a thread, with an @mention picked from the list.
  {
    const context = await film(state);
    const page = await context.newPage();
    const h = human(page);
    await openConversation(page, 'design');
    const post = messages(page).getByRole('article').filter({ hasText: 'Booking flow v3 is ready' });
    await post.scrollIntoViewIfNeeded();
    await clip(
      'reply-in-thread',
      [page],
      async () => {
        await h.show();
        await h.hover(post, { dx: 120, dy: -20 });
        await sleep(500);
        await h.click(post.getByRole('button', { name: /^\d+ replies$/ }));
        const thread = page.getByRole('complementary', { name: 'Thread' });
        await thread.getByRole('log', { name: 'Replies' }).waitFor();
        await sleep(900);
        await h.click(thread.getByRole('textbox', { name: 'Reply…' }));
        await h.type('Lovely work @Pri');
        await page.getByRole('option', { name: 'Priya Raman' }).waitFor();
        await sleep(450);
        await page.keyboard.press('Enter');
        await h.type(' v3.1 is good to go. Handing it to Aiko 🚀');
        await sleep(300);
        await page.keyboard.press('Enter');
        await thread.getByRole('log', { name: 'Replies' }).getByText('Handing it to Aiko').waitFor();
        await sleep(1400);
      },
      {
        feature: 'Threads and @mentions',
        alt: 'Opening the replies under a post, mentioning Priya from the @ list and sending a reply in the thread.',
        poster: 8,
      },
    );
    await context.close();
  }

  // Search with Ctrl+K, then jump to the message.
  {
    const context = await film(state);
    const page = await context.newPage();
    const h = human(page);
    await openConversation(page, 'random');
    await clip(
      'search',
      [page],
      async () => {
        await h.show();
        await sleep(300);
        await page.keyboard.press('Control+k');
        const search = page.getByRole('dialog', { name: 'Search' });
        await search.getByRole('searchbox').waitFor();
        await sleep(400);
        await h.type('safari');
        await search.locator('mark').first().waitFor();
        await sleep(1300);
        await h.click(search.getByRole('button', { name: /Safari 17/ }).first());
        await page.getByRole('heading', { level: 1, name: 'engineering' }).waitFor();
        await settled(page);
        await sleep(1300);
      },
      {
        feature: 'Search',
        alt: 'Pressing Ctrl+K, searching for “safari” and opening the matching message in #engineering.',
        poster: 3,
      },
    );
    await context.close();
  }

  // Inviting someone from Admin › People and copying the link.
  {
    const context = await film(state);
    const page = await context.newPage();
    const h = human(page);
    await page.goto('/admin/people');
    await page.getByRole('heading', { name: 'Invite people' }).waitFor();
    await settled(page);
    await clip(
      'invite-someone',
      [page],
      async () => {
        await h.show();
        await h.click(page.getByLabel('Email', { exact: true }));
        await h.type(`kofi@${DOMAIN}`);
        await sleep(300);
        await h.click(page.getByRole('button', { name: 'Send invitation' }));
        await page.getByLabel('Invitation link').waitFor();
        await sleep(900);
        await h.click(page.getByRole('button', { name: 'Copy', exact: true }));
        await page.getByRole('button', { name: 'Copied' }).waitFor();
        await sleep(1500);
      },
      {
        feature: 'Invitations',
        alt: 'Inviting a new teammate by email from Admin › People and copying their one-time invitation link.',
        poster: 5,
      },
    );
    await context.close();
  }

  // Real time: Samuel writes in #launch-q1 while Maya watches it arrive, then reacts.
  {
    const size = { width: 952, height: 800 };
    const maya = await film(state, size);
    const samuel = await film(await api.samuel.storageState(), size);
    const left = await maya.newPage();
    const right = await samuel.newPage();
    const hl = human(left);
    const hr = human(right);
    await openConversation(left, 'launch-q1');
    await openConversation(right, 'launch-q1');
    const text = 'Go/no-go moves to Friday 1pm so Ruth can join 👍';
    await clip(
      'real-time',
      [left, right],
      async () => {
        await hl.show();
        await hr.show();
        await hr.click(right.getByRole('textbox', { name: 'Message #launch-q1' }));
        await hr.type(text, { min: 30, max: 75 });
        await sleep(250);
        await right.keyboard.press('Enter');
        const arrived = messages(left).getByRole('article').filter({ hasText: 'Go/no-go moves to Friday' });
        await arrived.waitFor();
        await sleep(900);
        await hl.hover(arrived, { dx: 150 });
        await sleep(350);
        await hl.click(arrived.getByRole('button', { name: 'Add reaction' }));
        await sleep(300);
        await hl.click(arrived.getByRole('button', { name: 'React with ✅' }));
        await messages(right).getByRole('button', { name: /✅ 1/ }).waitFor();
        await hl.moveTo(600, 27, 500); // off the messages, so no action bar shows
        await sleep(1600);
      },
      {
        feature: 'Real-time messages, typing indicator and reactions',
        alt: 'Two people in #launch-q1 side by side: one types (the other sees “is typing…”), the message appears live, and the reaction shows up on both screens.',
        viewport: '2 × 952x800, side by side',
        poster: -1.2, // the reaction showing on both screens
      },
    );
    await maya.close();
    await samuel.close();
  }

  // Signing in with an authenticator app.
  {
    const context = await film();
    const page = await context.newPage();
    const h = human(page);
    await page.goto('/signin');
    await page.getByLabel('Work email').waitFor();
    await settled(page);
    await clip(
      'authenticator-sign-in',
      [page],
      async () => {
        await h.show();
        await sleep(300);
        await h.click(page.getByRole('button', { name: 'Use an authenticator app instead' }));
        await page.getByLabel('Code from your authenticator app').waitFor();
        await sleep(400);
        await h.click(page.getByLabel('Work email'));
        await h.type(OWNER.email);
        await h.click(page.getByLabel('Code from your authenticator app'));
        await sleep(500); // reading the code off the phone
        await h.type(await nextOwnerCode(), { min: 110, max: 180 });
        await sleep(300);
        await h.click(page.getByRole('button', { name: 'Sign in' }));
        await nav(page).waitFor();
        await settled(page);
        await sleep(1400);
      },
      {
        feature: 'Authenticator app sign-in',
        alt: 'Signing in with an email address and the 6-digit code from an authenticator app, then landing in the workspace.',
        poster: 4,
      },
    );
    await context.close();
  }
}

/** Branding last, so every other capture shows Huddle's own look. */
async function captureBranding(state) {
  console.log('Branding…');
  await call(api.maya, 'PUT', '/api/workspace/logo', assets.logo, { 'content-type': 'image/png' });
  await call(api.maya, 'PATCH', '/api/workspace', { accent: '#ffb86b' });
  const context = await desktop(state);
  const page = await context.newPage();
  await page.goto('/admin/workspace');
  await page.getByAltText('Current logo').waitFor();
  await shot(page, 'admin-branding', {
    feature: 'Branding: logo and accent colour',
    alt: 'Admin › Workspace: the workspace name, an uploaded logo and a custom accent colour applied across the app.',
  });
  await context.close();
  const out = await desktop();
  const p = await out.newPage();
  await p.goto('/signin');
  await p.getByLabel('Work email').waitFor();
  await shot(p, 'signin-branded', {
    feature: 'Branding: logo and accent colour',
    alt: 'The sign-in page with the team’s own logo and accent colour.',
  });
  await out.close();
}

/* --------------------------------------------------------------------------------------- main */

async function main() {
  for (const dir of [SCREENS, MEDIA, WORK_DIR]) mkdirSync(dir, { recursive: true });
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('ffmpeg is needed on the PATH to encode the clips');
  }
  console.log(`Capturing in ${TIME_ZONE} (local time ${Math.floor(localMinutes(TIME_ZONE) / 60)}:${String(localMinutes(TIME_ZONE) % 60).padStart(2, '0')})`);

  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  writeVars();
  execSync(`npx wrangler d1 migrations apply DB --local --persist-to ${STATE_DIR}`, {
    env: serverEnv(),
    stdio: 'ignore',
  });
  writeFileSync(LOG_FILE, '');
  await startServer();

  browser = await chromium.launch({ channel: 'chrome' });
  await makeAssets();
  const ownerState = await captureOwnerSetup();
  await seed(ownerState);
  await backdate();
  // Sessions live in the database, so they survive the restart.
  await capturePhone(ownerState);
  await captureDesktop(ownerState);
  await captureClips(ownerState);
  await captureBranding(ownerState);

  manifest.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(
    MANIFEST,
    JSON.stringify({ generatedAt: new Date().toISOString(), workspace: WORKSPACE, files: manifest }, null, 2) + '\n',
  );
  const bytes = manifest.reduce((n, f) => n + statSync(f.path).size, 0);
  console.log(`Done: ${manifest.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB. See ${MANIFEST}`);
}

async function cleanUp() {
  for (const client of Object.values(api)) await client.dispose().catch(() => {});
  await browser?.close().catch(() => {});
  await stopServer();
  rmSync(VARS_FILE, { force: true });
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
}

process.on('SIGINT', () => void cleanUp().then(() => process.exit(130)));
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanUp);
