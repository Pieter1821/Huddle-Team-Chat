import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Hash, Lock, Users } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import type { QueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { conversationLabel, useConversation, useMembers, type Member } from '@/lib/queries';
import type { Me, SidebarConversation } from '@/lib/types';
import { Composer, type Mentionable } from './composer';
import { toggleReaction, type Feed, type FeedMessage, type Thread } from './feed-state';
import type { MessageActions } from './message-item';
import { MessageList } from './message-list';
import { ThreadPanel } from './thread-panel';
import { discardFailed, feedKey, retryMessage, useFeed } from './use-feed';

/** An open channel or direct message: header, live history, typing line, composer, and a thread. */
export function ConversationView({
  conversation: c,
  me,
  threadId,
}: {
  conversation: SidebarConversation;
  me: Me;
  threadId?: string | undefined;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const myId = me.user.id;
  const { feed, connection, typingUserIds, sendTyping, send, loadOlder, loadingOlder } = useFeed(c.id, myId);
  const detail = useConversation(c.id);
  const members = useMembers();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const label = conversationLabel(c, myId);
  const isChannel = c.kind === 'public' || c.kind === 'private';
  const isAdmin = me.role === 'owner' || me.role === 'admin';

  // Where "New" goes: the first message after what you had read when you opened the conversation.
  // (The view remounts per conversation, so this is captured once.)
  const [readAtOpen] = useState(c.lastReadSeq);
  const messages = useMemo(() => feed.data?.messages ?? [], [feed.data]);
  const firstUnreadSeq = useMemo(
    () => messages.find((m) => !m.pending && m.seq > readAtOpen && m.authorId !== myId)?.seq ?? null,
    [messages, myId, readAtOpen],
  );

  const nameOf = useCallback(
    (userId: string | null, m?: FeedMessage) => {
      if (m?.webhookId) return m.webhookName ?? 'Webhook';
      if (!userId) return 'Huddle';
      if (userId === myId) return me.user.name;
      return members.byId.get(userId)?.name || (members.isPending ? '…' : 'Former member');
    },
    [members.byId, members.isPending, me.user.name, myId],
  );

  useMarkRead(c, feed.data?.lastSeq ?? 0, atBottom && feed.isSuccess);

  const actions: MessageActions = useMemo(
    () => ({
      react: (m, emoji, on) => {
        // Optimistic: the socket event that follows is ignored if it changes nothing.
        const patch = (add: boolean) =>
          patchMessage(client, c.id, m.id, (x) => ({
            ...x,
            reactions: toggleReaction(x.reactions ?? [], emoji, myId, add),
          }));
        patch(on);
        const path = `/conversations/${c.id}/messages/${m.id}/reactions`;
        const req = on
          ? api(path, { json: { emoji } })
          : api(`${path}?emoji=${encodeURIComponent(emoji)}`, { method: 'DELETE' });
        req.catch((err: unknown) => {
          patch(!on);
          setError(err instanceof ApiError ? err.message : 'That reaction didn’t save.');
        });
      },
      edit: async (m, body) => {
        await api(`/conversations/${c.id}/messages/${m.id}`, { method: 'PATCH', json: { body } });
      },
      remove: async (m) => {
        try {
          await api(`/conversations/${c.id}/messages/${m.id}`, { method: 'DELETE' });
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'That message wasn’t deleted.');
        }
      },
      retry: (m) => retryMessage(client, m, myId),
      discard: (m) => discardFailed(client, m),
      openThread: (m) => void navigate(`/c/${c.id}/t/${m.id}`),
    }),
    [client, c.id, myId, navigate],
  );

  // Who @ can suggest: the people in this conversation, plus everyone-at-once in channels.
  const mentionables = useMemo<Mentionable[]>(() => {
    const people = (detail.data?.members ?? [])
      .filter((m) => m.userId !== myId)
      .map((m) => ({
        id: m.userId,
        label: m.name || 'Someone',
        ...(m.role === 'guest' ? { hint: 'Guest' } : {}),
      }));
    return isChannel
      ? [
          ...people,
          { id: 'here', label: 'here', hint: 'Everyone online' },
          { id: 'channel', label: 'channel', hint: 'Everyone in this channel' },
        ]
      : people;
  }, [detail.data, isChannel, myId]);

  const editLast = () => {
    const last = [...messages].reverse().find((m) => m.authorId === myId && !m.pending && !m.deletedAt);
    if (!last) return false;
    setEditingId(last.id);
    return true;
  };

  const typingNames = typingUserIds.map((id) => nameOf(id));
  const canPost = detail.data ? detail.data.isMember : true;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-rule px-4">
          <Link
            to="/"
            aria-label="Back to conversations"
            className="-ml-1 rounded-lg p-1 text-muted hover:text-ink md:hidden"
          >
            <ArrowLeft aria-hidden className="size-5" />
          </Link>
          {c.kind === 'private' ? (
            <Lock aria-hidden className="size-4 text-meta" />
          ) : c.kind === 'public' ? (
            <Hash aria-hidden className="size-4 text-meta" />
          ) : null}
          <h1 className="truncate text-[15px] font-semibold">{label}</h1>
          {c.topic && <p className="hidden min-w-0 truncate text-sm text-meta sm:block">{c.topic}</p>}
          {detail.data && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-sm text-meta" title="Members">
              <Users aria-hidden className="size-4" />
              <span className="sr-only">Members:</span>
              {detail.data.members.length}
            </span>
          )}
        </header>

        {detail.data && detail.data.guestCount > 0 && (
          <p className="border-b border-rule bg-raised px-5 py-2 text-[13px] text-muted">
            {detail.data.guestCount === 1
              ? 'A guest from outside your team is'
              : `${detail.data.guestCount} guests from outside your team are`}{' '}
            in this conversation.
          </p>
        )}

        {feed.isPending ? (
          <div className="flex-1" role="status" aria-label="Loading messages" />
        ) : feed.isError ? (
          <div className="grid flex-1 place-items-center text-center">
            <div>
              <p className="text-[15px] text-muted">Messages didn’t load.</p>
              <Button variant="ghost" className="mt-3" onClick={() => void feed.refetch()}>
                Try again
              </Button>
            </div>
          </div>
        ) : (
          <MessageList
            messages={messages}
            hasMore={feed.data.hasMore}
            loadingOlder={loadingOlder}
            loadOlder={loadOlder}
            firstUnreadSeq={firstUnreadSeq}
            myId={myId}
            isAdmin={isAdmin}
            editingId={editingId}
            setEditingId={setEditingId}
            nameOf={nameOf}
            isAppMessage={(m) => Boolean(m.webhookId)}
            actions={actions}
            onAtBottomChange={setAtBottom}
            intro={
              <Intro
                conversation={c}
                label={label}
                members={detail.data?.members ?? []}
                myId={myId}
                isChannel={isChannel}
              />
            }
          />
        )}

        <div className="min-h-6 px-5 text-xs text-meta" aria-live="polite">
          {connection === 'closed' ? (
            <span className="text-attention">Reconnecting… your messages will still send.</span>
          ) : error ? (
            <span role="alert" className="text-attention">
              {error}
            </span>
          ) : typingNames.length ? (
            <span>
              {typingNames.length > 2
                ? 'Several people are typing…'
                : `${typingNames.join(' and ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…`}
            </span>
          ) : null}
        </div>

        {canPost ? (
          <Composer
            conversationId={c.id}
            placeholder={isChannel ? `Message #${label}` : `Message ${label}`}
            mentionables={mentionables}
            autoFocus={!threadId}
            onSend={({ body, files }) => {
              setError(null);
              send({ body, files }).catch(() => undefined);
            }}
            onTyping={sendTyping}
            onEditLast={editLast}
          />
        ) : (
          <JoinBar conversationId={c.id} label={label} />
        )}
      </div>
      {threadId && (
        <ThreadPanel
          key={threadId}
          conversationId={c.id}
          parentId={threadId}
          channelLabel={isChannel ? `#${label}` : null}
          myId={myId}
          isAdmin={isAdmin}
          nameOf={nameOf}
          actions={actions}
          mentionables={mentionables}
          onTyping={sendTyping}
        />
      )}
    </div>
  );
}

/** Changes one message wherever it's shown: the conversation and any open thread. */
function patchMessage(
  client: QueryClient,
  conversationId: string,
  id: string,
  change: (m: FeedMessage) => FeedMessage,
) {
  client.setQueryData<Feed>(feedKey(conversationId), (f) =>
    f ? { ...f, messages: f.messages.map((x) => (x.id === id ? change(x) : x)) } : f,
  );
  client.setQueriesData<Thread>({ queryKey: ['thread', conversationId] }, (t) =>
    t
      ? {
          parent: t.parent.id === id ? change(t.parent) : t.parent,
          replies: t.replies.map((x) => (x.id === id ? change(x) : x)),
        }
      : t,
  );
}

/** What you see at the very top of a conversation's history. */
function Intro({
  conversation: c,
  label,
  members,
  myId,
  isChannel,
}: {
  conversation: SidebarConversation;
  label: string;
  members: Pick<Member, 'userId' | 'name'>[];
  myId: string;
  isChannel: boolean;
}) {
  const others = members.filter((m) => m.userId !== myId).map((m) => m.name);
  return (
    <div className="px-5 pt-10 pb-4">
      <h2 className="text-xl font-semibold">{isChannel ? `#${label}` : label}</h2>
      <p className="mt-1 text-[15px] text-muted">
        {isChannel
          ? c.topic || `This is the very beginning of #${label}.`
          : others.length
            ? `The start of your conversation with ${others.join(', ')}.`
            : 'Your own space: notes, drafts and reminders.'}
      </p>
    </div>
  );
}

function JoinBar({ conversationId, label }: { conversationId: string; label: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center justify-between gap-4 border-t border-rule px-5 py-4">
      <p className="text-[15px] text-muted">
        You’re reading #{label}. Join to post and get its notifications.
      </p>
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api(`/conversations/${conversationId}/join`, { json: {} })
            .then(() =>
              Promise.all([
                client.invalidateQueries({ queryKey: ['conversation', conversationId] }),
                client.invalidateQueries({ queryKey: ['conversations'] }),
              ]),
            )
            .finally(() => setBusy(false));
        }}
      >
        Join channel
      </Button>
    </div>
  );
}

/**
 * Tells the server what you've read: whenever you're at the bottom of the conversation with the tab
 * visible. The sidebar badge clears at once; the server hears at most about once a second, and a
 * pending update is still sent (keepalive) if you leave straight away.
 */
function useMarkRead(c: SidebarConversation, lastSeq: number, ready: boolean) {
  const client = useQueryClient();
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const sentSeq = useRef(c.lastReadSeq);
  const pendingSeq = useRef<number | null>(null);
  const lastSentAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(
    (keepalive = false) => {
      clearTimeout(timer.current);
      const seq = pendingSeq.current;
      if (seq === null || seq <= sentSeq.current) return;
      pendingSeq.current = null;
      sentSeq.current = seq;
      lastSentAt.current = Date.now();
      void api(`/conversations/${c.id}/read`, { json: { seq }, keepalive }).catch(() => undefined);
    },
    [c.id],
  );

  useEffect(() => {
    if (!ready || !visible || lastSeq <= sentSeq.current) return;
    client.setQueryData<SidebarConversation[]>(['conversations'], (list) =>
      list?.map((x) =>
        x.id === c.id
          ? { ...x, lastReadSeq: lastSeq, lastSeq: Math.max(x.lastSeq, lastSeq), unread: 0, mentions: 0 }
          : x,
      ),
    );
    pendingSeq.current = lastSeq;
    const wait = 1000 - (Date.now() - lastSentAt.current);
    if (wait <= 0) flush();
    else {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(), wait);
    }
  }, [client, c.id, lastSeq, ready, visible, flush]);

  // Leaving the conversation (or the page) sends what's still waiting.
  useEffect(() => {
    const onHide = () => flush(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flush(true);
    };
  }, [flush]);
}
