/**
 * Sticky scroll reveal, adapted from Aceternity UI (ui.aceternity.com, sticky-scroll-reveal): the
 * steps of a story scroll by on one side while the picture for the step you're reading holds still
 * on the other and changes with it. Huddle's version follows the page's own scroll (no inner
 * scrolling box), uses real screenshots and no gradients. On phones each picture sits under its step.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

export type Moment = {
  time: string;
  title: string;
  text: string;
  img: string;
  alt: string;
  phone?: boolean;
};

export default function StickyScroll({ moments }: { moments: Moment[] }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  const reduce = useReducedMotion();

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
        }
      },
      { rootMargin: '-48% 0px -48% 0px' },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  const m = moments[active]!;

  return (
    <div className="ss">
      <ol className="ss-steps" role="list">
        {moments.map((s, i) => (
          <li
            key={s.title}
            ref={(el) => {
              refs.current[i] = el;
            }}
            data-i={i}
            className={`ss-step${i === active ? ' on' : ''}`}
          >
            <h3 className="ss-title">
              <span className="ss-time">{s.time}</span> {s.title}
            </h3>
            <p className="ss-text">{s.text}</p>
            <img className={`ss-inline${s.phone ? ' phone' : ''}`} src={s.img} alt={s.alt} loading="lazy" decoding="async" />
          </li>
        ))}
      </ol>
      <div className="ss-stage" aria-hidden="true">
        <div className="ss-frame">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.img
              key={m.img}
              className={`ss-img${m.phone ? ' phone' : ''}`}
              src={m.img}
              alt=""
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -16, scale: 0.99 }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            />
          </AnimatePresence>
        </div>
        <div className="ss-dots">
          {moments.map((s, i) => (
            <span key={s.title} className={i === active ? 'on' : ''} />
          ))}
        </div>
      </div>
    </div>
  );
}
