import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertDialog } from 'radix-ui';
import { MessageSquare, Pencil, SmilePlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { FeedMessage } from './feed-state';
import { MessageText } from './message-text';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

export type MessageActions = {
  react: (m: FeedMessage, emoji: string, on: boolean) => void;
  edit: (m: FeedMessage, body: string) => Promise<void>;
  remove: (m: FeedMessage) => Promise<void>;
  retry: (m: FeedMessage) => void;
  discard: (m: FeedMessage) => void;
};

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

/** One message: author line (unless grouped with the one before), text, reactions and actions. */
export function MessageItem({
  message: m,
  authorName,
  isApp,
  grouped,
  myId,
  canDelete,
  editing,
  onEditingChange,
  nameOf,
  actions,
}: {
  message: FeedMessage;
  authorName: string;
  isApp: boolean;
  grouped: boolean;
  myId: string;
  canDelete: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  nameOf: (userId: string) => string;
  actions: MessageActions;
}) {
  const mine = m.authorId === myId;
  const created = new Date(m.createdAt);

  if (m.deletedAt) {
    // Deleted messages only keep a placeholder when replies still hang off them.
    if (!m.replyCount) return null;
    return <div className="px-5 py-1.5 pl-[68px] text-sm italic text-meta">This message was deleted.</div>;
  }

  return (
    <article
      aria-label={`${authorName}, ${full.format(created)}`}
      // Focusable so touch and keyboard users can reach the actions that appear on hover.
      tabIndex={0}
      className={cn(
        'group relative flex gap-3 px-5 transition-colors duration-100 outline-none hover:bg-raised/60 focus-within:bg-raised/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-action',
        grouped ? 'py-0.5' : 'pt-3 pb-0.5',
        m.pending && 'opacity-70',
      )}
    >
      <div className="w-9 shrink-0">
        {grouped ? (
          <time
            dateTime={m.createdAt}
            className="invisible block pt-1 text-right text-[11px] leading-5 text-meta group-hover:visible group-focus-within:visible"
          >
            {time.format(created)}
          </time>
        ) : (
          <span
            aria-hidden
            className={cn(
              'mt-0.5 grid size-9 place-items-center rounded-lg text-sm font-semibold',
              isApp ? 'bg-action text-action-ink' : 'bg-bronze',
            )}
          >
            {authorName.charAt(0).toUpperCase()}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <header className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold">{authorName}</span>
            {isApp && (
              <span className="rounded bg-active px-1.5 text-[11px] font-medium text-muted">App</span>
            )}
            <time dateTime={m.createdAt} title={full.format(created)} className="text-xs text-meta">
              {time.format(created)}
            </time>
          </header>
        )}

        {editing ? (
          <EditBox
            initial={m.body}
            onCancel={() => onEditingChange(false)}
            onSave={async (body) => {
              await actions.edit(m, body);
              onEditingChange(false);
            }}
          />
        ) : (
          <>
            {m.body && <MessageText body={m.body} nameOf={nameOf} myId={myId} />}
            {m.editedAt && <span className="text-xs text-meta"> (edited)</span>}
          </>
        )}

        {!!m.files?.length && (
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {m.files.map((f) => (
              <li key={f.id}>
                <a
                  href={`/api/files/${f.id}`}
                  className="inline-flex max-w-64 items-center gap-2 rounded-lg px-3 py-2 text-sm edge hover:bg-active"
                >
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-xs text-meta">{formatSize(f.size)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}

        {!!m.reactions?.length && (
          <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Reactions">
            {m.reactions.map((r) => {
              const reacted = r.userIds.includes(myId);
              const who = r.userIds.map((id) => (id === myId ? 'you' : nameOf(id))).join(', ');
              return (
                <li key={r.emoji}>
                  <button
                    type="button"
                    aria-pressed={reacted}
                    aria-label={`${r.emoji} ${r.count}, from ${who}. ${reacted ? 'Remove your reaction' : 'React too'}`}
                    title={who}
                    disabled={!!m.pending}
                    onClick={() => actions.react(m, r.emoji, !reacted)}
                    className={cn(
                      'flex h-7 items-center gap-1.5 rounded-pill px-2.5 text-sm transition-colors duration-100',
                      reacted
                        ? 'bg-action/15 text-ink ring-1 ring-action/60'
                        : 'bg-active text-muted hover:text-ink',
                    )}
                  >
                    <span>{r.emoji}</span>
                    <span className="tabular-nums">{r.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {m.replyCount > 0 && (
          <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-action">
            <MessageSquare aria-hidden className="size-3.5" />
            {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
          </p>
        )}

        {m.pending === 'sending' && <p className="text-xs text-meta">Sending…</p>}
        {m.pending === 'failed' && (
          <p role="alert" className="flex items-center gap-3 text-xs text-attention">
            Not sent.
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() => actions.retry(m)}
            >
              Try again
            </button>
            <button
              type="button"
              className="text-meta underline underline-offset-2"
              onClick={() => actions.discard(m)}
            >
              Discard
            </button>
          </p>
        )}
      </div>

      {!m.pending && !editing && (
        <Toolbar
          mine={mine}
          canDelete={canDelete}
          onReact={(e) => actions.react(m, e, true)}
          onEdit={() => onEditingChange(true)}
          onDelete={() => actions.remove(m)}
        />
      )}
    </article>
  );
}

/** Hover (or keyboard focus) actions in the top-right corner of a message. */
function Toolbar({
  mine,
  canDelete,
  onReact,
  onEdit,
  onDelete,
}: {
  mine: boolean;
  canDelete: boolean;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className="absolute -top-3 right-4 hidden items-center gap-0.5 rounded-lg bg-raised p-0.5 shadow-lg edge group-hover:flex group-focus-within:flex"
    >
      {picking ? (
        QUICK_REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            aria-label={`React with ${e}`}
            className="grid size-8 place-items-center rounded-md text-base hover:bg-active"
            onClick={() => {
              onReact(e);
              setPicking(false);
            }}
          >
            {e}
          </button>
        ))
      ) : (
        <Button
          variant="quiet"
          size="icon"
          aria-label="Add reaction"
          title="Add reaction"
          className="size-8"
          onClick={() => setPicking(true)}
        >
          <SmilePlus aria-hidden className="size-4" />
        </Button>
      )}
      {mine && !picking && (
        <Button
          variant="quiet"
          size="icon"
          aria-label="Edit message"
          title="Edit"
          className="size-8"
          onClick={onEdit}
        >
          <Pencil aria-hidden className="size-4" />
        </Button>
      )}
      {canDelete && !picking && <DeleteButton onConfirm={onDelete} />}
    </div>
  );
}

function DeleteButton({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <Button
          variant="quiet"
          size="icon"
          aria-label="Delete message"
          title="Delete"
          className="size-8 hover:text-attention"
        >
          <Trash2 aria-hidden className="size-4" />
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-ground/70" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-32px)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-card bg-raised p-6 edge">
          <AlertDialog.Title className="text-lg font-semibold">Delete this message?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[15px] text-muted">
            It disappears for everyone. This can’t be undone.
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost">Keep it</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onConfirm().finally(() => setBusy(false));
                }}
              >
                Delete
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Editing in place: Enter saves, Shift+Enter adds a line, Escape cancels. */
function EditBox({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const save = () => {
    const body = value.trim();
    if (!body || body === initial.trim()) return onCancel();
    setError(null);
    onSave(body).catch(() => setError('That didn’t save. Try again.'));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    }
  };
  return (
    <div className="mt-1">
      <label className="sr-only" htmlFor="edit-message">
        Edit message
      </label>
      <textarea
        id="edit-message"
        ref={ref}
        rows={1}
        value={value}
        maxLength={8000}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-none rounded-lg bg-ground px-3 py-2 text-[15px] leading-relaxed outline-none edge focus-visible:ring-2 focus-visible:ring-action"
      />
      {error && (
        <p role="alert" className="text-xs text-attention">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs text-meta">Enter to save · Esc to cancel</p>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
