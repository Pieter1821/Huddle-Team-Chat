import { lazy, Suspense, useEffect } from 'react';
import { Link, Route, Routes, useMatch, useNavigate, useParams } from 'react-router';
import { ErrorBoundary } from '@/components/error-boundary';
import { clearNotifications, onNotificationOpen } from '@/lib/pwa';
import { conversationLabel, useBranding, useConversation, useConversations, useMe } from '@/lib/queries';
import type { SidebarConversation } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Sidebar } from './sidebar';
import { useWorkspaceLive } from './use-workspace-live';

// The chat view carries the editor (Tiptap/ProseMirror), the heaviest code in the app: it loads
// on first use, so sign-in and setup stay small.
const SettingsPage = lazy(() =>
  import('@/features/settings/settings-page').then((m) => ({ default: m.SettingsPage })),
);
const AdminPage = lazy(() => import('@/features/admin/admin-page').then((m) => ({ default: m.AdminPage })));
const InvitePage = lazy(() =>
  import('@/features/invite/invite-page').then((m) => ({ default: m.InvitePage })),
);
const ConversationView = lazy(() =>
  import('@/features/chat/conversation-view').then((m) => ({ default: m.ConversationView })),
);

/**
 * The signed-in app: sidebar plus the open conversation. On a phone only one shows at a time:
 * the list at "/", the conversation at "/c/:id" (with a back link to the list).
 */
export function Shell() {
  const match = useMatch('/c/:id/*');
  const onSettings = useMatch('/settings');
  const onAdmin = useMatch('/admin/*');
  const onInvite = useMatch('/invite');
  // On phones the main pane replaces the sidebar whenever something is open in it.
  const inConversation = Boolean(match || onSettings || onAdmin || onInvite);
  const { data: me } = useMe();
  useWorkspaceLive(me?.user.id, match?.params.id);
  const navigate = useNavigate();
  useEffect(() => {
    onNotificationOpen((url) => void navigate(url));
    return () => onNotificationOpen(null);
  }, [navigate]);
  useDocumentTitle(
    match?.params.id,
    onSettings ? 'Your settings' : onAdmin ? 'Admin' : onInvite ? 'Invite people' : null,
  );
  return (
    // The app never scrolls as a whole: each panel scrolls itself. overflow-hidden also stops any
    // hidden (screen-reader-only) text placed by the browser below a panel from stretching the page.
    <div className="relative flex h-dvh overflow-hidden">
      {/* The first thing Tab reaches: past the sidebar, straight to what's open. */}
      <a
        href="#main"
        className="sr-only z-50 rounded-pill bg-action px-4 py-2 text-sm font-semibold text-action-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to {match ? 'conversation' : 'main content'}
      </a>
      <Sidebar
        className={cn(
          'w-full md:w-[272px] md:shrink-0 md:border-r md:border-rule',
          inConversation && 'hidden md:flex',
        )}
      />
      <main
        id="main"
        tabIndex={-1}
        className={cn('min-w-0 flex-1 flex-col outline-none', inConversation ? 'flex' : 'hidden md:flex')}
      >
        <Routes>
          <Route path="/c/:id" element={<ConversationPane />} />
          <Route path="/c/:id/t/:threadId" element={<ConversationPane />} />
          {/* Links from notification emails and pushes point at one message. */}
          <Route path="/c/:id/m/:messageId" element={<ConversationPane />} />
          <Route
            path="/settings"
            element={
              <Suspense fallback={null}>
                <SettingsPage />
              </Suspense>
            }
          />
          <Route
            path="/admin/*"
            element={
              <Suspense fallback={null}>
                <AdminPage />
              </Suspense>
            }
          />
          <Route
            path="/invite"
            element={
              <Suspense fallback={null}>
                <InvitePage />
              </Suspense>
            }
          />
          <Route path="*" element={<NothingOpen />} />
        </Routes>
      </main>
    </div>
  );
}

/**
 * The browser tab names what's open (screen readers announce it when you move between
 * conversations) and counts unread mentions and direct messages, so a background tab shows them.
 */
function useDocumentTitle(conversationId: string | undefined, page: string | null) {
  const { data: me } = useMe();
  const { data: conversations } = useConversations();
  const { data: branding } = useBranding();
  const workspace = branding?.name ?? 'Huddle';
  const open = conversations?.find((c) => c.id === conversationId);
  const where = open
    ? open.kind === 'public' || open.kind === 'private'
      ? `#${conversationLabel(open, me?.user.id)}`
      : conversationLabel(open, me?.user.id)
    : page;
  const waiting = (conversations ?? []).reduce(
    (n, c) => n + (c.kind === 'dm' || c.kind === 'group_dm' ? c.unread : c.mentions),
    0,
  );
  const title = `${waiting ? `(${waiting}) ` : ''}${where ? `${where} · ` : ''}${workspace}`;
  useEffect(() => {
    document.title = title;
  }, [title]);
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
  useEffect(() => clearNotifications(id), [id]);

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
