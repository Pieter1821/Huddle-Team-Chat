import { Hash, Lock, LogOut } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { conversationLabel, useConversations, useMe, useSignOut } from '@/lib/queries';
import type { SidebarConversation } from '@/lib/types';
import { cn } from '@/lib/utils';

/** The left column: the team, its channels, your direct messages, and you. */
export function Sidebar({ className }: { className?: string }) {
  const { data: me } = useMe();
  const conversations = useConversations(Boolean(me));
  const channels = conversations.data?.filter((c) => c.kind === 'public' || c.kind === 'private') ?? [];
  const dms = conversations.data?.filter((c) => c.kind === 'dm' || c.kind === 'group_dm') ?? [];

  return (
    <nav aria-label="Conversations" className={cn('flex h-full flex-col bg-raised', className)}>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-rule px-4">
        <img src="/brand/huddle-mark-64.png" alt="" className="size-7 rounded-md" />
        <span className="truncate text-[15px] font-semibold">{me?.workspace?.name ?? 'Huddle'}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
        {conversations.isPending ? (
          <SkeletonList />
        ) : conversations.error ? (
          <p role="alert" className="px-3 text-sm text-attention">
            Conversations didn’t load.{' '}
            <button className="underline underline-offset-4" onClick={() => void conversations.refetch()}>
              Try again
            </button>
          </p>
        ) : (
          <>
            <Section
              title="Channels"
              items={channels}
              myId={me?.user.id}
              empty="You haven’t joined any channels yet."
            />
            <Section title="Direct messages" items={dms} myId={me?.user.id} empty="No direct messages yet." />
          </>
        )}
      </div>

      {me && <YouCard name={me.user.name} email={me.user.email} />}
    </nav>
  );
}

function Section({
  title,
  items,
  myId,
  empty,
}: {
  title: string;
  items: SidebarConversation[];
  myId: string | undefined;
  empty: string;
}) {
  const id = `section-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="mb-6">
      <h2 id={id} className="px-3 pb-1.5 text-[13px] font-medium text-meta">
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="px-3 text-[13px] text-meta">{empty}</p>
      ) : (
        <ul>
          {items.map((c) => (
            <li key={c.id}>
              <ConversationLink conversation={c} label={conversationLabel(c, myId)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConversationLink({ conversation: c, label }: { conversation: SidebarConversation; label: string }) {
  const unread = c.unread > 0 && c.notifyLevel !== 'muted';
  const Icon = c.kind === 'private' ? Lock : c.kind === 'public' ? Hash : null;
  const announce = [
    label,
    c.mentions ? `${c.mentions} mention${c.mentions === 1 ? '' : 's'}` : unread ? 'unread' : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <NavLink
      to={`/c/${c.id}`}
      aria-label={announce}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center gap-2.5 rounded-lg px-3 text-[15px] transition-colors duration-150',
          isActive ? 'bg-active text-ink' : 'text-muted hover:bg-active/60 hover:text-ink',
          unread && 'font-semibold text-ink',
          c.notifyLevel === 'muted' && 'opacity-60',
        )
      }
    >
      {Icon ? (
        <Icon aria-hidden className="size-4 shrink-0 text-meta" strokeWidth={2} />
      ) : (
        <span
          aria-hidden
          className="grid size-4 shrink-0 place-items-center rounded-full bg-bronze text-[10px] font-semibold text-ink"
        >
          {label.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="truncate">{label}</span>
      {c.mentions > 0 && (
        <span
          aria-hidden
          className="ml-auto min-w-5 rounded-pill bg-attention px-1.5 text-center text-xs font-semibold leading-5 text-ground"
        >
          {c.mentions > 99 ? '99+' : c.mentions}
        </span>
      )}
    </NavLink>
  );
}

function YouCard({ name, email }: { name: string; email: string }) {
  const signOut = useSignOut();
  const navigate = useNavigate();
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-rule px-4 py-3">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-full bg-bronze text-sm font-semibold"
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs text-meta">{email}</span>
      </span>
      <Button
        variant="quiet"
        size="icon"
        aria-label="Sign out"
        title="Sign out"
        disabled={signOut.isPending}
        onClick={() =>
          signOut.mutate(undefined, { onSettled: () => void navigate('/signin', { replace: true }) })
        }
      >
        <LogOut aria-hidden className="size-4" />
      </Button>
    </footer>
  );
}

function SkeletonList() {
  return (
    <div aria-hidden className="space-y-2 px-3">
      {[70, 55, 80, 60].map((w) => (
        <div
          key={w}
          className="h-4 animate-pulse rounded bg-active motion-reduce:animate-none"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}
