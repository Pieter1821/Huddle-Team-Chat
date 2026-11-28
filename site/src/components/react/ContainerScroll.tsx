/**
 * Container scroll, adapted from Aceternity UI (ui.aceternity.com, container-scroll-animation):
 * the product screen starts tilted back and settles flat as you scroll, like a laptop lid opening.
 * Huddle's version keeps the motion and drops the grey border: the bezel is a tone step.
 */
import { useRef, type ReactNode } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';

export default function ContainerScroll({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  // Flat by the time the screen's middle reaches the middle of the window.
  const rotate = useTransform(scrollYProgress, [0.1, 0.5], [reduce ? 0 : 24, 0], { clamp: true });
  const scale = useTransform(scrollYProgress, [0.1, 0.5], [reduce ? 1 : 0.94, 1], { clamp: true });
  const y = useTransform(scrollYProgress, [0.1, 0.5], [reduce ? 0 : 40, 0], { clamp: true });

  return (
    <div ref={ref} className="cs-wrap">
      <motion.div className="cs-card" style={{ rotateX: rotate, scale, y }}>
        <div className="cs-screen">{children}</div>
      </motion.div>
    </div>
  );
}
