// Recording and encoding the clips. Frames come from Chrome's own screencast (sharper than
// Playwright's built-in video), are timed by when Chrome painted them, and ffmpeg turns them into
// a steady 30 fps H.264 MP4, a VP9 WebM and a poster JPEG.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A visible mouse pointer for recordings: headless Chrome draws none, so clicks would look like
 * things happening by themselves. It only follows real mouse events and never takes clicks.
 */
export const CURSOR_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById('__capture_cursor')) return;
    const c = document.createElement('div');
    c.id = '__capture_cursor';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2.5v17l4.6-4.2 3.1 6.7 2.9-1.3-3.1-6.6h6.3z" fill="#fff" stroke="#151515" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    const x = window.__captureCursor || { x: -50, y: -50 };
    Object.assign(c.style, { position: 'fixed', left: x.x - 4 + 'px', top: x.y - 2 + 'px', zIndex: 2147483647,
      pointerEvents: 'none', transition: 'transform 90ms ease-out', transformOrigin: '4px 2px',
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))' });
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX - 4 + 'px'; c.style.top = e.clientY - 2 + 'px'; }, true);
    addEventListener('mousedown', () => (c.style.transform = 'scale(0.82)'), true);
    addEventListener('mouseup', () => (c.style.transform = ''), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();`;

/** Human-paced pointer and keyboard for one page: eased moves, short pauses, uneven typing. */
export function human(page) {
  let pos = { x: 820, y: 28 }; // rests on the header bar, where hovering changes nothing
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const self = {
    async moveTo(x, y, ms = 550) {
      const from = { ...pos };
      const steps = Math.max(10, Math.round(ms / 16));
      for (let i = 1; i <= steps; i++) {
        const t = ease(i / steps);
        await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
        await sleep(ms / steps / 2);
      }
      pos = { x, y };
    },
    /** Puts the pointer back on screen after a page load (the overlay starts hidden). */
    async show() {
      await page.mouse.move(pos.x + 1, pos.y);
      await page.mouse.move(pos.x, pos.y);
    },
    async hover(locator, { dx = 0, dy = 0, ms } = {}) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) throw new Error('Nothing to hover');
      await self.moveTo(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, ms);
    },
    async click(locator, opts = {}) {
      await self.hover(locator, opts);
      await sleep(140);
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();
    },
    async type(text, { min = 38, max = 105 } = {}) {
      const graphemes = [...new Intl.Segmenter().segment(text)].map((s) => s.segment);
      for (const ch of graphemes) {
        await page.keyboard.type(ch);
        let wait = min + Math.random() * (max - min);
        if (/[\s,.]/.test(ch)) wait += 40 + Math.random() * 60;
        await sleep(wait);
      }
    },
  };
  return self;
}

/** Starts Chrome's screencast for a page; stop() writes the frames and their timings to `dir`. */
export async function record(page, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const { width, height } = page.viewportSize();
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: width, maxHeight: height });
  const startedAt = Date.now() / 1000;
  return {
    startedAt,
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      return { frames, startedAt, endedAt: Date.now() / 1000, width, height };
    },
  };
}

/** An ffconcat list holding each frame for as long as it was on screen, from `from` to `to`. */
function concatList(take, from, to, listFile, speed = 1) {
  const { frames } = take;
  if (!frames.length) throw new Error('No frames were recorded');
  const lines = ['ffconcat version 1.0'];
  // Absolute paths: ffconcat resolves relative ones against the list's own folder.
  const path = (f) => resolve(f.file).replaceAll('\\', '/');
  const kept = frames.filter((f) => f.t < to);
  // The frame showing at `from` is the last one painted before it.
  let first = 0;
  for (let i = 0; i < kept.length; i++) if (kept[i].t <= from) first = i;
  for (let i = first; i < kept.length; i++) {
    const start = Math.max(kept[i].t, from);
    const end = i + 1 < kept.length ? kept[i + 1].t : to;
    if (end <= start) continue;
    lines.push(`file '${path(kept[i])}'`, `duration ${((end - start) / speed).toFixed(4)}`);
  }
  lines.push(`file '${path(kept.at(-1))}'`); // ffconcat needs the last file twice
  writeFileSync(listFile, lines.join('\n'));
}

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/**
 * Encodes one or two takes (two are placed side by side, in step) into <out>.mp4, .webm and .jpg.
 * `trim` = [seconds after start, seconds before end] to cut; `poster` = seconds into the clip (negative: from the end).
 */
export function encode(takes, out, { trim = [0, 0], poster = 1, workDir, gap = 16, speed = 1 }) {
  const from = Math.max(...takes.map((t) => t.frames[0].t)) + trim[0];
  const to = Math.min(...takes.map((t) => t.endedAt)) - trim[1];
  const inputs = takes.flatMap((take, i) => {
    const list = join(workDir, `take-${i}.ffconcat`);
    concatList(take, from, to, list, speed);
    return ['-f', 'concat', '-safe', '0', '-i', list];
  });
  const filter =
    takes.length === 1
      ? '[0:v]fps=30,format=yuv420p[v]'
      : `[0:v]fps=30,pad=iw+${gap}:ih:0:0:color=0x0b0b0b[l];[1:v]fps=30[r];[l][r]hstack=inputs=2,format=yuv420p[v]`;
  const duration = ((to - from) / speed).toFixed(3);
  const mp4 = `${out}.mp4`;
  const encodeMp4 = (crf) =>
    ff([...inputs, '-filter_complex', filter, '-map', '[v]', '-t', duration, '-an', '-c:v', 'libx264',
      '-preset', 'slow', '-crf', String(crf), '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  let crf = 23;
  encodeMp4(crf);
  // Keep each MP4 under about 3 MB for the site.
  while (statSync(mp4).size > 3 * 1024 * 1024 && crf < 33) encodeMp4((crf += 3));
  ff(['-i', mp4, '-an', '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', '-deadline', 'good',
    '-cpu-used', '3', `${out}.webm`]);
  const at = poster < 0 ? Number(duration) + poster : Math.min(poster, Number(duration) - 0.1);
  ff(['-ss', String(at), '-i', mp4, '-frames:v', '1', '-q:v', '3', `${out}.jpg`]);
  return { seconds: Number(duration), crf };
}
