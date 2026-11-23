import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FeedMessage } from './feed-state';
import { MessageItem, type MessageActions } from './message-item';

const GROUP_WITHIN_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 120;
const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/**
 * The scrolling history. Sticks to the bottom while you're there, keeps your place when older
 * messages load above, marks where new messages start, and offers a jump back down.
 */
export function MessageList({
  messages,
  hasMore,
  loadingOlder,
  loadOlder,
  firstUnreadSeq,
  myId,
  isAdmin,
  editingId,
  setEditingId,
  nameOf,
  isAppMessage,
  actions,
  onAtBottomChange,
  intro,
}: {
  messages: FeedMessage[];
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  firstUnreadSeq: number | null;
  myId: string;
  isAdmin: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  nameOf: (userId: string | null, m?: FeedMessage) => string;
  isAppMessage: (m: FeedMessage) => boolean;
  actions: MessageActions;
  onAtBottomChange: (atBottom: boolean) => void;
  intro: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const prevFirstId = useRef<string | undefined>(undefined);
  const prevHeight = useRef(0);

  // Older page arrived above: keep the same message under your eyes. Otherwise stay pinned.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const firstId = messages[0]?.id;
    if (prevFirstId.current && firstId !== prevFirstId.current && prevHeight.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setShowJump(true);
    }
    prevFirstId.current = firstId;
    prevHeight.current = el.scrollHeight;
  }, [messages]);

  // Reaching the top loads the page before.
  useEffect(() => {
    const el = top.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          prevHeight.current = scroller.current?.scrollHeight ?? 0;
          void loadOlder();
        }
      },
      { root: scroller.current, rootMargin: '400px 0px 0px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadOlder]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (near !== atBottom.current) {
      atBottom.current = near;
      onAtBottomChange(near);
    }
    if (near) setShowJump(false);
    prevHeight.current = el.scrollHeight;
  };

  const jump = () => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
    setShowJump(false);
  };

  const rows: ReactNode[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const created = new Date(m.createdAt);
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== created.toDateString();
    const unreadStart = firstUnreadSeq !== null && !m.pending && m.seq === firstUnreadSeq;
    if (newDay) rows.push(<Divider key={`d-${m.id}`} label={day.format(created)} />);
    if (unreadStart) rows.push(<Divider key={`n-${m.id}`} label="New" accent />);
    const grouped =
      !newDay &&
      !unreadStart &&
      !!prev &&
      !prev.deletedAt &&
      prev.authorId === m.authorId &&
      prev.webhookId === m.webhookId &&
      created.getTime() - new Date(prev.createdAt).getTime() < GROUP_WITHIN_MS;
    rows.push(
      <MessageItem
        key={m.clientMsgId ?? m.id}
        message={m}
        authorName={nameOf(m.authorId, m)}
        isApp={isAppMessage(m)}
        grouped={grouped}
        myId={myId}
        canDelete={m.authorId === myId || isAdmin}
        editing={editingId === m.id}
        onEditingChange={(on) => setEditingId(on ? m.id : null)}
        nameOf={(id) => nameOf(id)}
        actions={actions}
      />,
    );
  });

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
        <div ref={top} aria-hidden className="h-px" />
        {hasMore ? (
          <p className="py-4 text-center text-sm text-meta" role="status">
            {loadingOlder ? 'Loading earlier messages…' : ''}
          </p>
        ) : (
          intro
        )}
        <div role="log" aria-label="Messages" aria-relevant="additions" className="pb-4">
          {rows}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-pill bg-action px-4 py-2 text-sm font-semibold text-action-ink shadow-lg"
        >
          <ArrowDown aria-hidden className="size-4" />
          New messages
        </button>
      )}
    </div>
  );
}

function Divider({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 px-5 py-2">
      <span className={cn('h-px flex-1', accent ? 'bg-attention/60' : 'bg-rule')} />
      <span className={cn('text-xs font-medium', accent ? 'text-attention' : 'text-meta')}>{label}</span>
      <span className={cn('h-px flex-1', accent ? 'bg-attention/60' : 'bg-rule')} />
    </div>
  );
}
