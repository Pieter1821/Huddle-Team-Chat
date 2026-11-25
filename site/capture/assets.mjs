// Files the demo team shares: a design mockup, a second mockup for the upload clip, a launch plan
// PDF, the studio's logo and a small Slack export. All drawn here from HTML, so nothing is borrowed.
import { strToU8, zipSync } from 'fflate';

const font = `font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;`;

/** One phone screen of the booking app, for the mockups. */
const phone = (title, body) => `
  <div class="phone"><div class="bar"><span>9:41</span><span>●●●</span></div>
    <div class="title">${title}</div>${body}</div>`;

const mockupCss = `
  * { box-sizing: border-box; margin: 0; }
  body { ${font} width: 1600px; height: 1000px; background: #eef1ee; color: #1d2421; padding: 56px 72px; }
  h1 { font-size: 30px; font-weight: 650; letter-spacing: -0.01em; }
  .sub { color: #66736d; font-size: 18px; margin-top: 6px; }
  .row { display: flex; gap: 48px; margin-top: 44px; justify-content: center; }
  .phone { width: 380px; height: 760px; background: #fff; border-radius: 44px; padding: 22px 24px;
    box-shadow: 0 24px 60px rgba(20,40,30,.14), 0 0 0 10px #1d2421; }
  .bar { display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; color: #1d2421; }
  .title { font-size: 24px; font-weight: 650; margin: 26px 0 18px; }
  .label { font-size: 13px; color: #66736d; text-transform: uppercase; letter-spacing: .06em; margin: 18px 0 10px; }
  .svc { border: 1.5px solid #e1e6e2; border-radius: 16px; padding: 14px 16px; margin-bottom: 10px; }
  .svc b { display: block; font-size: 16px; } .svc span { color: #66736d; font-size: 14px; }
  .svc.on { border-color: #1f7a5c; background: #f0f8f4; }
  .cal { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; text-align: center; font-size: 14px; }
  .cal i { font-style: normal; color: #8a958f; font-size: 12px; }
  .cal span { padding: 8px 0; border-radius: 10px; }
  .cal .on { background: #1f7a5c; color: #fff; font-weight: 600; }
  .slots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .slots span { border: 1.5px solid #e1e6e2; border-radius: 12px; min-height: 44px; display: grid; place-items: center; font-size: 15px; }
  .slots .on { border-color: #1f7a5c; background: #f0f8f4; font-weight: 600; }
  .slots .off { color: #b8c0bb; text-decoration: line-through; }
  .btn { margin-top: 22px; background: #1f7a5c; color: #fff; border-radius: 999px; text-align: center; padding: 15px; font-weight: 600; }
  .line { display: flex; justify-content: space-between; padding: 10px 0; font-size: 15px; border-bottom: 1px solid #eef1ee; }
  .muted { color: #8a958f; } .total { font-weight: 700; font-size: 18px; border: 0; }
  .policy { background: #fff7e6; border-radius: 14px; padding: 14px; font-size: 14px; line-height: 1.45; color: #6b4e12; margin-top: 16px; }
  .note { position: absolute; font-size: 15px; background: #ffd84d; padding: 10px 14px; border-radius: 4px; box-shadow: 0 6px 16px rgba(0,0,0,.12); width: 210px; line-height: 1.35; transform: rotate(-2deg); }
`;

export const bookingMockupHtml = `<style>${mockupCss}</style>
  <h1>Booking flow v3</h1><p class="sub">Service → date and time (one step) → confirm. Priya, 25 Nov</p>
  <div class="row">
  ${phone(
    'Choose a service',
    `<div class="svc on"><b>Haircut and style</b><span>45 min · €48</span></div>
     <div class="svc"><b>Colour refresh</b><span>90 min · €85</span></div>
     <div class="svc"><b>Beard trim</b><span>20 min · €18</span></div>
     <div class="svc"><b>Consultation</b><span>15 min · free</span></div>
     <div class="btn">Continue</div>`,
  )}
  ${phone(
    'Pick a date and time',
    `<div class="label">December</div>
     <div class="cal"><i>M</i><i>T</i><i>W</i><i>T</i><i>F</i><i>S</i><i>S</i>
       <span>1</span><span>2</span><span>3</span><span class="on">4</span><span>5</span><span>6</span><span>7</span>
       <span>8</span><span>9</span><span>10</span><span>11</span><span>12</span><span>13</span><span>14</span></div>
     <div class="label">Thursday 4 December</div>
     <div class="slots"><span class="off">9:00</span><span>9:45</span><span>10:30</span><span>11:15</span>
       <span class="on">13:00</span><span>13:45</span><span class="off">14:30</span><span>15:15</span><span>16:00</span></div>
     <div class="btn">Continue</div>`,
  )}
  ${phone(
    'Confirm',
    `<div class="line"><span>Haircut and style</span><span>€48.00</span></div>
     <div class="line"><span>Thu 4 Dec, 13:00</span><span class="muted">45 min</span></div>
     <div class="line muted"><span>Deposit today</span><span>€10.00</span></div>
     <div class="line total"><span>Total</span><span>€48.00</span></div>
     <div class="policy"><b>Free cancellation</b> until 24 hours before. After that the deposit is kept.</div>
     <div class="btn">Book for €48</div>`,
  )}
  </div>
  <div class="note" style="left:1270px; top:140px">Policy moved up from the last screen ✓</div>`;

export const emptyStatesHtml = `<style>${mockupCss}
  .card { width: 440px; height: 560px; background: #fff; border-radius: 28px; padding: 40px; text-align: center;
    box-shadow: 0 18px 44px rgba(20,40,30,.10); }
  .art { height: 220px; display: grid; place-items: center; }
  .card h2 { font-size: 22px; margin-top: 18px; } .card p { color: #66736d; margin-top: 10px; line-height: 1.5; font-size: 16px; }
  .ghost { margin-top: 26px; display: inline-block; border: 1.5px solid #1f7a5c; color: #1f7a5c; padding: 12px 22px; border-radius: 999px; font-weight: 600; }
</style>
  <h1>Empty states, first pass</h1><p class="sub">Rough. For Thursday’s crit. Leila and Maya</p>
  <div class="row">
    <div class="card"><div class="art"><svg width="190" height="170"><rect x="20" y="30" width="150" height="120" rx="18" fill="#e3f1ea"/><rect x="20" y="30" width="150" height="34" rx="18" fill="#1f7a5c"/><circle cx="62" cy="100" r="9" fill="#9cc9b4"/><circle cx="95" cy="100" r="9" fill="#9cc9b4"/><circle cx="128" cy="100" r="9" fill="#ffd84d"/></svg></div>
      <h2>No bookings yet</h2><p>Share your booking link and new appointments will show up here.</p><span class="ghost">Copy booking link</span></div>
    <div class="card"><div class="art"><svg width="190" height="170"><circle cx="95" cy="85" r="64" fill="#fff1cc"/><circle cx="95" cy="70" r="22" fill="#f2b84b"/><rect x="58" y="98" width="74" height="40" rx="20" fill="#f2b84b"/></svg></div>
      <h2>No staff added</h2><p>Add the people who take bookings, and set the hours they work.</p><span class="ghost">Add a team member</span></div>
    <div class="card"><div class="art"><svg width="190" height="170"><rect x="40" y="26" width="110" height="130" rx="14" fill="#e8ecf6"/><rect x="58" y="52" width="74" height="10" rx="5" fill="#9aa8cf"/><rect x="58" y="76" width="56" height="10" rx="5" fill="#c3cbe4"/><rect x="58" y="100" width="66" height="10" rx="5" fill="#c3cbe4"/></svg></div>
      <h2>No reviews to show</h2><p>After their first visit, customers can leave a short review.</p><span class="ghost">Preview the email</span></div>
  </div>`;

export const launchPlanHtml = `<style>
  * { box-sizing: border-box; margin: 0; }
  body { ${font} color: #1d2421; padding: 56px 64px; font-size: 14px; line-height: 1.55; }
  h1 { font-size: 28px; letter-spacing: -0.01em; } .sub { color: #66736d; margin: 4px 0 28px; }
  h2 { font-size: 16px; margin: 26px 0 8px; color: #1f7a5c; }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e1e6e2; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #66736d; }
  li { margin: 4px 0 4px 18px; }
</style>
  <h1>Booking v2 beta: launch plan</h1><p class="sub">Northwind Studio · Owner: Samuel Mensah · Updated 25 November</p>
  <h2>Goal</h2><p>Put Booking v2 in front of 40 existing customers on Monday, learn what breaks, and fix it before the public launch in January.</p>
  <h2>Timeline</h2>
  <table><tr><th>When</th><th>What</th><th>Owner</th></tr>
    <tr><td>Wed 26 Nov</td><td>Feature freeze, staging build for review</td><td>Tomás</td></tr>
    <tr><td>Thu 27 Nov</td><td>Help centre complete (5 articles)</td><td>Elena</td></tr>
    <tr><td>Fri 28 Nov, 2pm</td><td>Go/no-go call</td><td>Samuel</td></tr>
    <tr><td>Mon 1 Dec, 9am</td><td>Beta invitations sent to 40 customers</td><td>Ruth</td></tr>
    <tr><td>Mon 1 Dec – Fri 12 Dec</td><td>Daily feedback review, fixes shipped same day</td><td>Everyone</td></tr></table>
  <h2>Go/no-go criteria</h2>
  <ul><li>No open P1 bugs; P2s have an owner and a date</li><li>All 214 regression tests green on the release build</li>
    <li>Booking, rescheduling and cancelling tested on iOS, Android and desktop</li><li>Rollback plan rehearsed once on staging</li></ul>
  <h2>Risks</h2>
  <ul><li>Safari date picker bug (fix in review)</li><li>Email deliverability for the beta invitations: send list cleaned, warm-up started</li></ul>`;

export const logoHtml = `<style>
  * { margin: 0; } body { background: transparent; }
  .logo { display: inline-flex; align-items: center; gap: 14px; height: 64px; padding: 0 4px; ${font} }
  .word { color: #fffbeb; font-size: 34px; font-weight: 650; letter-spacing: -0.01em; }
  .word span { color: #ffb86b; font-weight: 500; }
</style>
<div class="logo"><svg width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="none" stroke="#ffb86b" stroke-width="3"/>
  <path d="M24 8 L30 24 L24 40 L18 24 Z" fill="#fffbeb"/><path d="M24 8 L30 24 L18 24 Z" fill="#ffb86b"/></svg>
  <div class="word">Northwind <span>Studio</span></div></div>`;

/** Renders HTML to a PNG (or a transparent PNG cropped to `selector`). */
export async function renderPng(page, html, { width = 1600, height = 1000, selector } = {}) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><meta charset="utf-8">${html}`);
  await page.evaluate(() => document.fonts.ready);
  if (selector) return page.locator(selector).screenshot({ omitBackground: true });
  return page.screenshot();
}

export async function renderPdf(page, html) {
  await page.setContent(`<!doctype html><meta charset="utf-8">${html}`);
  return page.pdf({ format: 'A4', printBackground: true });
}

/** A small Slack export (Slack's documented layout) from the studio's old workspace, for Admin › Import. */
export function slackExportZip(people) {
  const json = (v) => strToU8(JSON.stringify(v));
  const root = 'Northwind Studio Slack export Jan 1 2024 - Nov 20 2026/';
  const users = people.map((p, i) => ({
    id: `U0${i + 1}${p.key.toUpperCase()}`,
    name: p.key,
    real_name: p.name,
    profile: { email: p.email },
  }));
  const id = (key) => users.find((u) => u.name === key).id;
  const ts = (year, month, day, h, m) => String(Date.UTC(year, month - 1, day, h, m) / 1000) + '.000100';
  return Buffer.from(
    zipSync({
      [`${root}users.json`]: json(users),
      [`${root}channels.json`]: json([
        { id: 'C01CRIT', name: 'design-crit', members: users.map((u) => u.id), topic: { value: 'Weekly crit' } },
        { id: 'C02OPS', name: 'studio-ops', members: users.map((u) => u.id), topic: { value: 'Office and admin' } },
      ]),
      [`${root}dms.json`]: json([{ id: 'D01MT', members: [id('maya'), id('tomas')] }]),
      [`${root}design-crit/2024-01-12.json`]: json([
        { ts: ts(2024, 1, 12, 15, 0), user: id('maya'), text: 'First crit in the new space! Bring sketches, not slides' },
        { ts: ts(2024, 1, 12, 15, 9), user: id('priya'), text: 'Sketches it is' },
      ]),
      [`${root}design-crit/2025-06-03.json`]: json([
        { ts: ts(2025, 6, 3, 14, 30), user: id('leila'), text: 'Logo refresh options are pinned in the board' },
      ]),
      [`${root}design-crit/2026-11-18.json`]: json([
        { ts: ts(2026, 11, 18, 15, 0), user: id('priya'), text: 'Crit notes from today are in the doc' },
        { ts: ts(2026, 11, 18, 15, 4), user: id('maya'), text: 'Thanks <@' + id('priya') + '>, great session' },
      ]),
      [`${root}studio-ops/2024-03-20.json`]: json([
        { ts: ts(2024, 3, 20, 9, 0), user: id('ruth'), text: 'Wifi password is on the fridge, please stop asking Jonas' },
      ]),
      [`${root}studio-ops/2026-11-19.json`]: json([
        { ts: ts(2026, 11, 19, 9, 12), user: id('ruth'), text: 'The new desks arrive on Thursday' },
        { ts: ts(2026, 11, 19, 9, 30), user: id('samuel'), text: 'I can help build them' },
        { ts: ts(2026, 11, 19, 9, 31), user: id('jonas'), text: 'Same, I have opinions about allen keys' },
      ]),
      [`${root}D01MT/2025-09-01.json`]: json([
        { ts: ts(2025, 9, 1, 8, 45), user: id('tomas'), text: 'Running 10 minutes late, train stuck outside the station' },
      ]),
    }),
  );
}
