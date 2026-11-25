/**
 * Cards carousel, adapted from Aceternity UI (ui.aceternity.com, apple-cards-carousel): a row of
 * real screens you can swipe or step through; choosing one opens it full size. Phone screens are
 * tall cards, desktop screens wide ones.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

export type Card = {
  title: string;
  kind: string;
  alt: string;
  thumb: string;
  full: string;
  phone?: boolean;
};

export default function Carousel({ cards }: { cards: Card[] }) {
  const row = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const reduce = useReducedMotion();
  const closeBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const update = () => {
    const el = row.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
  };
  useEffect(update, []);
  const step = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * row.current.clientWidth * 0.8, behavior: reduce ? 'auto' : 'smooth' });

  useEffect(() => {
    if (open === null) return;
    document.body.style.overflow = 'hidden';
    closeBtn.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
      if (e.key === 'ArrowRight') setOpen((i) => (i === null ? i : (i + 1) % cards.length));
      if (e.key === 'ArrowLeft') setOpen((i) => (i === null ? i : (i - 1 + cards.length) % cards.length));
    };
    addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = '';
      removeEventListener('keydown', key);
      opener.current?.focus();
    };
  }, [open, cards.length]);

  const card = open === null ? null : cards[open];

  return (
    <div className="cc">
      <div className="cc-row" ref={row} onScroll={update}>
        {cards.map((c, i) => (
          <motion.button
            key={c.title}
            type="button"
            className={`cc-card${c.phone ? ' phone' : ''}`}
            onClick={(e) => {
              opener.current = e.currentTarget;
              setOpen(i);
            }}
            initial={reduce ? false : { opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '0px -5% 0px 0px' }}
            transition={{ duration: 0.6, delay: Math.min(i, 5) * 0.06, ease: [0.22, 1, 0.36, 1] }}
            aria-label={`${c.title}: open full size`}
          >
            <span className="cc-text">
              <span className="cc-kind">{c.kind}</span>
              <span className="cc-title">{c.title}</span>
            </span>
            <img src={c.thumb} alt={c.alt} loading="lazy" decoding="async" />
          </motion.button>
        ))}
      </div>
      <div className="cc-nav">
        <button type="button" onClick={() => step(-1)} disabled={edges.start} aria-label="Previous screens">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M11 19l-7-7 7-7" />
          </svg>
        </button>
        <button type="button" onClick={() => step(1)} disabled={edges.end} aria-label="More screens">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <AnimatePresence>
        {card && (
          <motion.div
            className="cc-modal"
            role="dialog"
            aria-modal="true"
            aria-label={card.title}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(null)}
          >
            <motion.figure
              key={card.title}
              className={`cc-full${card.phone ? ' phone' : ''}`}
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <img src={card.full} alt={card.alt} />
              <figcaption>
                <b>{card.title}</b>
                <span>{card.alt}</span>
              </figcaption>
            </motion.figure>
            <button ref={closeBtn} type="button" className="cc-close" onClick={() => setOpen(null)} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
