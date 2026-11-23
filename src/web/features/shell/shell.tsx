import { lazy, Suspense } from 'react';
import { Link, Route, Routes, useMatch, useParams } from 'react-router';
import { ErrorBoundary } from '@/components/error-boundary';
import { useConversation, useConversations, useMe } from '@/lib/queries';
import type { SidebarConversation } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Sidebar } from './sidebar';
import { useWorkspaceLive } from './use-workspace-live';

// The chat view carries the editor (Tiptap/ProseMirror), the heaviest code in the app: it loads
// on first use, so sign-in and setup stay small.
const ConversationView = lazy(() =>
  import('@/features/chat/conversation-view').then((m) => ({ default: m.ConversationView })),
);

/**
 * The signed-in app: sidebar plus the open conversation. On a phone only one shows at a time:
 * the list at "/", the conversation at "/c/:id" (with a back link to the list).
 */
export function Shell() {
  const match = useMatch('/c/:id/*');
  const inConversation = Boolean(match);
  const { data: me } = useMe();
  useWorkspaceLive(me?.user.id, match?.params.id);
  return (
    <div className="flex h-dvh">
      <Sidebar
        className={cn(
          'w-full md:w-[272px] md:shrink-0 md:border-r md:border-rule',
          inConversation && 'hidden md:flex',
        )}
      />
      <main className={cn('min-w-0 flex-1 flex-col', inConversation ? 'flex' : 'hidden md:flex')}>
        <Routes>
          <Route path="/c/:id" element={<ConversationPane />} />
          <Route path="/c/:id/t/:threadId" element={<ConversationPane />} />
          <Route path="*" element={<NothingOpen />} />
        </Routes>
      </main>
    </div>
  );
}

function NothingOpen() {
  return (
    <div className="grid flex-1 place-items-center px-6 text-center">
      <div>
        <h1 className="text-lg font-semibold">Pick a conversation</h1>
        <p className="mt-1 text-[15px] text-muted">Choose a channel or a direct message on the left.</p>
      </div>
    </div>
  );
}

/**
 * The conversation in the address bar: one of yours from the sidebar, or a public channel you're
 * only reading (opened from search or browse), which shows a Join bar instead of the composer.
 */
function ConversationPane() {
  const { id = '', threadId } = useParams();
  const { data: me } = useMe();
  const { data: conversations, isPending } = useConversations();
  const mine = conversations?.find((x) => x.id === id);
  const other = useConversation(id, !isPending && !mine);

  const c: SidebarConversation | undefined =
    mine ??
    (other.data && {
      id: other.data.conversation.id,
      kind: other.data.conversation.kind,
      name: other.data.conversation.name,
      topic: other.data.conversation.topic,
      lastSeq: other.data.conversation.lastSeq,
      lastReadSeq: other.data.conversation.lastSeq,
      notifyLevel: 'all',
      unread: 0,
      mentions: 0,
    });

  if (isPending || !me || (!mine && other.isPending)) return null;
  if (!c) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <h1 className="text-lg font-semibold">Conversation not found</h1>
          <p className="mt-1 text-[15px] text-muted">
            It may have been archived, or you’re no longer a member.
          </p>
          <Link to="/" className="mt-4 inline-block text-sm text-action underline-offset-4 hover:underline">
            Back to your conversations
          </Link>
        </div>
      </div>
    );
  }
  // Keyed by id: switching conversations starts fresh (scroll position, "New" marker, editing).
  return (
    <ErrorBoundary resetKey={c.id} label="This conversation couldn’t be shown.">
      <Suspense fallback={null}>
        <ConversationView key={c.id} conversation={c} me={me} threadId={threadId} />
      </Suspense>
    </ErrorBoundary>
  );
}
