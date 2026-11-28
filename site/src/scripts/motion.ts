/**
 * The site's motion layer. Every move is transform or opacity, every one has a reduced-motion
 * fallback, and nothing here is needed to read the page: without script, everything is visible.
 */
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

/** Parts of a section rise in, staggered, once, as the section enters. */
function reveals() {
  const items = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (reduced() || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -12% 0px' },
  );
  items.forEach((el) => io.observe(el));
}

/** Buttons marked data-magnetic lean a little toward the pointer. */
function magnetic() {
  if (reduced() || !fine()) return;
  document.querySelectorAll<HTMLElement>('[data-magnetic]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left - r.width / 2) * 0.22;
      const y = (e.clientY - r.top - r.height / 2) * 0.32;
      el.style.transform = `translate(${x}px, ${y}px)`;
    });
    el.addEventListener('pointerleave', () => {
      el.style.transform = '';
    });
  });
}

/** Figures marked data-count run up to their value the first time they're seen. */
function counters() {
  const els = document.querySelectorAll<HTMLElement>('[data-count]');
  if (reduced()) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const el = e.target as HTMLElement;
        const end = Number(el.dataset.count);
        const fmt = new Intl.NumberFormat('en-US');
        const t0 = performance.now();
        const step = (t: number) => {
          const p = Math.min(1, (t - t0) / 1400);
          const eased = 1 - Math.pow(1 - p, 4);
          el.textContent = fmt.format(Math.round(end * eased));
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    },
    { threshold: 0.6 },
  );
  els.forEach((el) => io.observe(el));
}

/** The navigation bar picks up a tone step once the page has scrolled. */
function navTone() {
  const nav = document.querySelector<HTMLElement>('[data-nav]');
  if (!nav) return;
  const set = () => nav.toggleAttribute('data-scrolled', scrollY > 8);
  addEventListener('scroll', set, { passive: true });
  set();
}

export function initMotion() {
  reveals();
  magnetic();
  counters();
  navTone();
}
