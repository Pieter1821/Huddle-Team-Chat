import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { MessageDto } from '../../../shared/events';
import { Composer, type Mentionable } from './composer';
import type { FeedMessage, Thread } from './feed-state';
import { MessageItem, type MessageActions } from './message-item';
import { useRovingMessages } from './roving';
import { newClientMsgId, sendMessage, threadKey } from './use-feed';

/**
 * A thread beside the conversation (full screen on phones). Replies arrive through the
 * conversation's live socket, which updates this thread's cache as well.
 */
export function ThreadPanel({
  conversationId,
  parentId,
  channelLabel,
  myId,
  isAdmin,
  nameOf,
  actions,
  mentionables,
  onTyping,
}: {
  conversationId: string;
  parentId: string;
  /** "#design" for channels; null for direct messages (no "also send" option there). */
  channelLabel: string | null;
  myId: string;
  isAdmin: boolean;
  nameOf: (userId: string | null, m?: FeedMessage) => string;
  actions: MessageActions;
  mentionables: Mentionable[];
  onTyping: () => void;
}) {
  const client = useQueryClient();
  const thread = useQuery({
    queryKey: threadKey(conversationId, parentId),
    queryFn: () =>
      api<{ parent: MessageDto; replies: MessageDto[] }>(
        `/conversations/${conversationId}/messages/${parentId}/thread`,
      ).then((r): Thread => r),
    staleTime: Infinity,
    retry: false,
  });
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRovingMessages();
  const back = `/c/${conversationId}`;
  const replies = thread.data?.replies ?? [];

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [replies.length]);

  return (
    <aside
      aria-label="Thread"
      className="fixed inset-0 z-30 flex flex-col bg-ground md:static md:z-auto md:w-[400px] md:shrink-0 md:border-l md:border-rule"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-rule px-4">
        <Link
          to={back}
          aria-label="Back to the conversation"
          className="-ml-1 rounded-lg p-1 text-muted hover:text-ink md:hidden"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <h2 className="text-[15px] font-semibold">Thread</h2>
        {channelLabel && <span className="truncate text-sm text-meta">{channelLabel}</span>}
        <Link
          to={back}
          aria-label="Close thread"
          className="ml-auto hidden rounded-lg p-1 text-muted hover:text-ink md:block"
        >
          <X aria-hidden className="size-5" />
        </Link>
      </header>

      {thread.isPending ? (
        <div className="flex-1" role="status" aria-label="Loading thread" />
      ) : !thread.data ? (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <p className="text-[15px] text-muted">
            This thread isn’t available. Its message may have been deleted.
          </p>
        </div>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
          <ThreadMessage
            m={thread.data.parent}
            {...{ myId, isAdmin, nameOf, actions, editingId, setEditingId }}
          />
          <p className="flex items-center gap-3 px-5 py-2 text-xs text-meta">
            <span>
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </span>
            <span className="h-px flex-1 bg-rule" />
          </p>
          <div role="log" aria-label="Replies" aria-relevant="additions">
            {replies.map((r, i) => {
              const prev = replies[i - 1];
              const grouped =
                !!prev &&
                prev.authorId === r.authorId &&
                new Date(r.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
              return (
                <ThreadMessage
                  key={r.clientMsgId ?? r.id}
                  m={r}
                  grouped={grouped}
                  {...{ myId, isAdmin, nameOf, actions, editingId, setEditingId }}
                />
              );
            })}
          </div>
          <div ref={bottom} />
        </div>
      )}

      {thread.data && !thread.data.parent.deletedAt && (
        <Composer
          conversationId={conversationId}
          draftKey={`${conversationId}:${parentId}`}
          placeholder="Reply…"
          mentionables={mentionables}
          onTyping={onTyping}
          onSend={({ body, files }) => {
            void sendMessage(client, {
              conversationId,
              myId,
              clientMsgId: newClientMsgId(),
              body,
              files,
              parentId,
              alsoInChannel,
            }).catch(() => undefined);
          }}
          footer={
            channelLabel && (
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted select-none">
                <input
                  type="checkbox"
                  checked={alsoInChannel}
                  onChange={(e) => setAlsoInChannel(e.target.checked)}
                  className="m-0.5 size-5 shrink-0 accent-[var(--color-action)]"
                />
                Also send to {channelLabel}
              </label>
            )
          }
        />
      )}
    </aside>
  );
}

function ThreadMessage({
  m,
  grouped = false,
  myId,
  isAdmin,
  nameOf,
  actions,
  editingId,
  setEditingId,
}: {
  m: FeedMessage;
  grouped?: boolean;
  myId: string;
  isAdmin: boolean;
  nameOf: (userId: string | null, m?: FeedMessage) => string;
  actions: MessageActions;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
}) {
  if (m.deletedAt) {
    return <p className="px-5 py-2 text-sm text-meta italic">This message was deleted.</p>;
  }
  // No thread actions inside a thread.
  const inThread: MessageActions = { ...actions, openThread: undefined };
  return (
    <MessageItem
      message={m}
      authorName={nameOf(m.authorId, m)}
      isApp={Boolean(m.webhookId)}
      grouped={grouped}
      myId={myId}
      canDelete={m.authorId === myId || isAdmin}
      editing={editingId === m.id}
      onEditingChange={(on) => setEditingId(on ? m.id : null)}
      nameOf={(id) => nameOf(id)}
      actions={inThread}
    />
  );
}
