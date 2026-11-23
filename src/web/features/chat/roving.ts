import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Keyboard movement through a list of messages (<article> elements) with ONE tab stop: Tab enters
 * the list at the message you were last on (the newest by default) and the next Tab leaves it, so a
 * long history never sits between you and the message box. Inside the list:
 * ArrowUp/ArrowDown (or PageUp/PageDown) move one message, Home/End jump to the ends, and Escape
 * goes back to the message box. Tab from a message reaches its own buttons.
 *
 * The tab stop is moved directly on the DOM, so moving through a long history never re-renders it.
 * Messages render with tabIndex={-1}; React leaves the attribute alone while that prop is unchanged.
 * Returns a ref callback for the element holding the messages (it may appear after loading).
 */
export function useRovingMessages() {
  const rootRef = useRef<HTMLElement | null>(null);
  const detach = useRef<(() => void) | null>(null);

  // After every render: make sure exactly one message is reachable with Tab.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const items = root.querySelectorAll<HTMLElement>('article');
    if (!items.length) return;
    if (![...items].some((a) => a.tabIndex === 0)) items[items.length - 1]!.tabIndex = 0;
  });

  return useCallback((root: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    rootRef.current = root;
    if (!root) return;

    // Whichever message gets focus (keyboard or click) becomes the tab stop.
    const onFocusIn = (e: FocusEvent) => {
      const article = (e.target as HTMLElement).closest('article');
      if (!article || !root.contains(article)) return;
      for (const other of root.querySelectorAll<HTMLElement>('article[tabindex="0"]')) {
        if (other !== article) other.tabIndex = -1;
      }
      article.tabIndex = 0;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const current = e.target as HTMLElement;
      // Only when a message itself has focus: keys inside its buttons or edit box stay theirs.
      if (current.tagName !== 'ARTICLE' || e.altKey || e.ctrlKey || e.metaKey) return;
      const items = [...root.querySelectorAll<HTMLElement>('article')];
      const i = items.indexOf(current);
      let next: HTMLElement | undefined;
      switch (e.key) {
        case 'ArrowUp':
        case 'PageUp':
          next = items[i - 1];
          break;
        case 'ArrowDown':
        case 'PageDown':
          next = items[i + 1];
          break;
        case 'Home':
          next = items[0];
          break;
        case 'End':
          next = items.at(-1);
          break;
        case 'Escape': {
          const pane = root.closest('aside') ?? root.closest('main');
          pane?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
          e.preventDefault();
          return;
        }
        default:
          return;
      }
      e.preventDefault();
      next?.focus();
      next?.scrollIntoView({ block: 'nearest' });
    };

    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('keydown', onKeyDown);
    detach.current = () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
