/**
 * Timeline, adapted from Aceternity UI (ui.aceternity.com, timeline): each step's title holds its
 * place while its content scrolls past, and a line fills in as you read down. Huddle's version uses
 * the brand teal (no gradient), real recordings of the app and plain words.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';

export type Step = {
  title: string;
  text: string;
  clip?: { name: string; label: string };
  checklist?: string[];
};

function Clip({ name, label }: { name: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting && !reduce) {
          v.preload = 'auto';
          void v.play().catch(() => {});
        } else v.pause();
      },
      { threshold: 0.4 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [reduce]);
  return (
    <video ref={ref} className="tl-clip" muted loop playsInline preload="none" poster={`/media/${name}.jpg`} aria-label={label}>
      <source src={`/media/${name}.webm`} type="video/webm" />
      <source src={`/media/${name}.mp4`} type="video/mp4" />
    </video>
  );
}

export default function Timeline({ steps }: { steps: Step[] }) {
  const list = useRef<HTMLOListElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { scrollYProgress } = useScroll({ target: list, offset: ['start 40%', 'end 60%'] });
  const fill = useTransform(scrollYProgress, [0, 1], [0, height]);

  return (
    <div className="tl">
      <ol ref={list} className="tl-list" role="list">
        {steps.map((s, i) => (
          <li key={s.title} className="tl-step">
            <div className="tl-head">
              <span className="tl-dot" aria-hidden="true">
                <span />
              </span>
              <h3 className="tl-title">{s.title}</h3>
            </div>
            <div className="tl-body">
              <h3 className="tl-title tl-title-sm" aria-hidden="true">
                {s.title}
              </h3>
              <p className="tl-text">{s.text}</p>
              {s.clip && <Clip {...s.clip} />}
              {s.checklist && (
                <ul className="tl-check" role="list">
                  {s.checklist.map((c, j) => (
                    <motion.li
                      key={c}
                      initial={{ opacity: 0, x: -12 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true, margin: '-15% 0px' }}
                      transition={{ delay: 0.12 * j, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <span className="tick" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      {c}
                    </motion.li>
                  ))}
                </ul>
              )}
              {i === steps.length - 1 && <div className="tl-end" />}
            </div>
          </li>
        ))}
      </ol>
      <div className="tl-rail" style={{ height }} aria-hidden="true">
        <motion.div className="tl-fill" style={{ height: fill }} />
      </div>
    </div>
  );
}
