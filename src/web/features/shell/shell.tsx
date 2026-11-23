import { ArrowLeft, Hash, Lock } from 'lucide-react';
import { Link, Route, Routes, useMatch, useParams } from 'react-router';
import { conversationLabel, useConversations, useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Sidebar } from './sidebar';

/**
 * The signed-in app: sidebar plus the open conversation. On a phone only one shows at a time:
 * the list at "/", the conversation at "/c/:id" (with a back link to the list).
 */
export function Shell() {
  const inConversation = Boolean(useMatch('/c/:id'));
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

/** Header of the open conversation. The message list and composer arrive with the chat piece. */
function ConversationPane() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data: conversations, isPending } = useConversations();
  const c = conversations?.find((x) => x.id === id);

  if (isPending) return null;
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
  const Icon = c.kind === 'private' ? Lock : c.kind === 'public' ? Hash : null;
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-rule px-4">
        <Link
          to="/"
          aria-label="Back to conversations"
          className="-ml-1 rounded-lg p-1 text-muted hover:text-ink md:hidden"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        {Icon && <Icon aria-hidden className="size-4 text-meta" />}
        <h1 className="truncate text-[15px] font-semibold">{conversationLabel(c, me?.user.id)}</h1>
        {c.topic && <p className="hidden truncate text-sm text-meta sm:block">{c.topic}</p>}
      </header>
      <div className="flex-1" />
    </>
  );
}
