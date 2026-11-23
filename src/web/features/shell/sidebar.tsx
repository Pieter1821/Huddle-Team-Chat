import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Hash, Lock, LogOut, Plus, Search, ShieldCheck } from 'lucide-react';
import { Link, NavLink, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { conversationLabel, useConversations, useMe, useSignOut } from '@/lib/queries';
import type { SidebarConversation } from '@/lib/types';
import { cn } from '@/lib/utils';

// Dialogs load the first time they're opened, keeping the first page load small.
const SearchDialog = lazy(() => import('./search-dialog').then((m) => ({ default: m.SearchDialog })));
const NewChannelDialog = lazy(() =>
  import('./new-conversation').then((m) => ({ default: m.NewChannelDialog })),
);
const BrowseChannelsDialog = lazy(() =>
  import('./new-conversation').then((m) => ({ default: m.BrowseChannelsDialog })),
);
const NewMessageDialog = lazy(() =>
  import('./new-conversation').then((m) => ({ default: m.NewMessageDialog })),
);

type Open = 'search' | 'new-channel' | 'browse' | 'new-message' | null;

/** The left column: the team, its channels, your direct messages, and you. */
export function Sidebar({ className }: { className?: string }) {
  const { data: me } = useMe();
  const conversations = useConversations(Boolean(me));
  const channels = conversations.data?.filter((c) => c.kind === 'public' || c.kind === 'private') ?? [];
  const dms = conversations.data?.filter((c) => c.kind === 'dm' || c.kind === 'group_dm') ?? [];
  const [open, setOpen] = useState<Open>(null);
  const dialog = (name: Exclude<Open, null>) => ({
    open: open === name,
    onOpenChange: (o: boolean) => setOpen(o ? name : null),
  });
  const isGuest = me?.role === 'guest';

  // Ctrl+K (Cmd+K on a Mac) opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <nav aria-label="Conversations" className={cn('flex h-full flex-col bg-raised', className)}>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-rule px-4">
        <img src="/brand/huddle-mark-64.png" alt="" className="size-7 rounded-md" />
        <span className="truncate text-[15px] font-semibold">{me?.workspace?.name ?? 'Huddle'}</span>
      </header>

      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={() => setOpen('search')}
          className="flex h-9 w-full items-center gap-2 rounded-pill bg-ground px-3 text-sm text-meta edge hover:text-ink"
        >
          <Search aria-hidden className="size-4" />
          Search
          <kbd className="ml-auto hidden font-sans text-xs text-meta sm:block">Ctrl K</kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 relative overflow-y-auto px-2 py-4">
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
              action={isGuest ? null : <AddButton label="Add a channel" onClick={() => setOpen('browse')} />}
            />
            <Section
              title="Direct messages"
              items={dms}
              myId={me?.user.id}
              empty="No direct messages yet."
              action={<AddButton label="New message" onClick={() => setOpen('new-message')} />}
            />
          </>
        )}
      </div>

      {me && (
        <YouCard
          name={me.user.name}
          email={me.user.email}
          isAdmin={me.role === 'owner' || me.role === 'admin'}
        />
      )}

      <Suspense fallback={null}>
        {open === 'search' && <SearchDialog {...dialog('search')} />}
        {open === 'new-channel' && <NewChannelDialog {...dialog('new-channel')} />}
        {open === 'browse' && (
          <BrowseChannelsDialog {...dialog('browse')} onCreate={() => setOpen('new-channel')} />
        )}
        {open === 'new-message' && <NewMessageDialog {...dialog('new-message')} />}
      </Suspense>
    </nav>
  );
}

function Section({
  title,
  items,
  myId,
  empty,
  action,
}: {
  title: string;
  items: SidebarConversation[];
  myId: string | undefined;
  empty: string;
  action?: ReactNode;
}) {
  const id = `section-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="mb-6">
      <div className="flex items-center justify-between pr-1 pb-1.5 pl-3">
        <h2 id={id} className="text-[13px] font-medium text-meta">
          {title}
        </h2>
        {action}
      </div>
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
  // Heard after the name (the visible name stays the start of the link's name, so voice control
  // users can say what they see).
  const status = c.mentions ? `${c.mentions} mention${c.mentions === 1 ? '' : 's'}` : unread ? 'unread' : '';
  return (
    <NavLink
      to={`/c/${c.id}`}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center gap-2.5 rounded-lg px-3 text-[15px] transition-colors duration-150',
          isActive ? 'bg-active text-ink' : 'text-muted hover:bg-active/60 hover:text-ink',
          unread && 'font-semibold text-ink',
          c.notifyLevel === 'muted' && 'text-meta', // quieter, still 4.5:1
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
      {status && <span className="sr-only">({status})</span>}
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

function YouCard({ name, email, isAdmin }: { name: string; email: string; isAdmin: boolean }) {
  const signOut = useSignOut();
  const navigate = useNavigate();
  return (
    <footer className="flex shrink-0 items-center gap-1 border-t border-rule px-2 py-2">
      {/* You: opens your settings. */}
      <Link
        to="/settings"
        title="Your settings"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-active"
      >
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
        <span className="sr-only">, your settings</span>
      </Link>
      {isAdmin && (
        <Link to="/admin" aria-label="Admin" title="Admin" className={iconLink}>
          <ShieldCheck aria-hidden className="size-4" />
        </Link>
      )}
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

function AddButton({ label, ...props }: { label: string } & React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className="grid size-6 place-items-center rounded-md text-meta hover:bg-active hover:text-ink"
    >
      <Plus aria-hidden className="size-4" />
    </button>
  );
}

const iconLink =
  'grid size-9 shrink-0 place-items-center rounded-pill text-muted hover:bg-active hover:text-ink';
