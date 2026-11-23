import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveNote } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';
import { useMembers, type ConversationDetail } from '@/lib/queries';
import type { Me, SidebarConversation } from '@/lib/types';
import { cn } from '@/lib/utils';

type Note = { ok: boolean; text: string } | null;
const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'That didn’t work. Try again.');

/** A conversation's details: what it's about, your notifications, who's in it, leave or archive. */
export function ConversationDetails({
  open,
  onOpenChange,
  conversation: c,
  detail,
  label,
  me,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: SidebarConversation;
  detail: ConversationDetail | undefined;
  label: string;
  me: Me;
}) {
  const isChannel = c.kind === 'public' || c.kind === 'private';
  const isAdmin = me.role === 'owner' || me.role === 'admin';
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={isChannel ? `#${label}` : label} top>
      <div className="min-h-0 flex-1 space-y-6 relative overflow-y-auto px-6 pt-4 pb-6">
        {isChannel && <About conversation={c} />}
        {detail?.isMember && <Notifications conversation={c} />}
        <Members conversation={c} detail={detail} me={me} isChannel={isChannel} isAdmin={isAdmin} />
        {isChannel && detail?.isMember && (
          <Danger
            conversation={c}
            label={label}
            isGeneral={c.name === 'general'}
            onDone={() => onOpenChange(false)}
          />
        )}
      </div>
    </Dialog>
  );
}

function useRefresh(id: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['conversations'] }),
      client.invalidateQueries({ queryKey: ['conversation', id] }),
    ]);
}

function About({ conversation: c }: { conversation: SidebarConversation }) {
  const refresh = useRefresh(c.id);
  const [name, setName] = useState(c.name ?? '');
  const [topic, setTopic] = useState(c.topic ?? '');
  const [note, setNote] = useState<Note>(null);
  const changed = name.trim() !== (c.name ?? '') || topic.trim() !== (c.topic ?? '');

  async function save(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    try {
      await api(`/conversations/${c.id}`, {
        method: 'PATCH',
        json: {
          ...(name.trim() !== c.name ? { name: name.trim() } : {}),
          ...(topic.trim() !== (c.topic ?? '') ? { topic: topic.trim() || null } : {}),
        },
      });
      await refresh();
      setNote({ ok: true, text: 'Saved' });
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
    }
  }

  return (
    <section aria-labelledby="about-heading">
      <h3 id="about-heading" className="text-sm font-semibold">
        About
      </h3>
      <form onSubmit={(e) => void save(e)} className="mt-3 space-y-3">
        <div className="space-y-2">
          <Label htmlFor="conv-name">Name</Label>
          <Input
            id="conv-name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={c.name === 'general'}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="conv-topic">Topic</Label>
          <Input
            id="conv-topic"
            maxLength={250}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What this channel is for"
          />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={!changed || !name.trim()}>
            Save
          </Button>
          <SaveNote state={note} />
        </div>
      </form>
    </section>
  );
}

const LEVELS = [
  { value: 'all', title: 'Everything', text: 'Unread counts for every new message.' },
  { value: 'mentions', title: 'Mentions only', text: 'Only when someone mentions you.' },
  { value: 'muted', title: 'Muted', text: 'Dimmed in the sidebar, no emails.' },
] as const;

function Notifications({ conversation: c }: { conversation: SidebarConversation }) {
  const client = useQueryClient();
  const [level, setLevel] = useState(c.notifyLevel);
  const [note, setNote] = useState<Note>(null);
  async function choose(next: SidebarConversation['notifyLevel']) {
    const before = level;
    setLevel(next);
    setNote(null);
    try {
      await api(`/conversations/${c.id}/notifications`, { method: 'PATCH', json: { level: next } });
      client.setQueryData<SidebarConversation[]>(['conversations'], (list) =>
        list?.map((x) => (x.id === c.id ? { ...x, notifyLevel: next } : x)),
      );
    } catch (err) {
      setLevel(before);
      setNote({ ok: false, text: errorText(err) });
    }
  }
  return (
    <fieldset>
      <legend className="text-sm font-semibold">Notifications</legend>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {LEVELS.map((l) => (
          <label
            key={l.value}
            className={cn(
              'cursor-pointer rounded-lg p-3 edge has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-action',
              level === l.value && 'bg-active ring-1 ring-action/60',
            )}
          >
            <input
              type="radio"
              name="notify"
              className="sr-only"
              checked={level === l.value}
              onChange={() => void choose(l.value)}
            />
            <span className="block text-sm font-medium">{l.title}</span>
            <span className="block text-xs text-muted">{l.text}</span>
          </label>
        ))}
      </div>
      <SaveNote state={note} />
    </fieldset>
  );
}

function Members({
  conversation: c,
  detail,
  me,
  isChannel,
  isAdmin,
}: {
  conversation: SidebarConversation;
  detail: ConversationDetail | undefined;
  me: Me;
  isChannel: boolean;
  isAdmin: boolean;
}) {
  const refresh = useRefresh(c.id);
  const everyone = useMembers();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState<Note>(null);
  const inside = new Set((detail?.members ?? []).map((m) => m.userId));
  const canAdd = isChannel && me.role !== 'guest' && detail?.isMember;
  const candidates = (everyone.data ?? []).filter(
    (m) => !inside.has(m.userId) && (isAdmin || m.role !== 'guest'),
  );

  async function add() {
    setNote(null);
    try {
      await api(`/conversations/${c.id}/members`, { json: { userIds: picked } });
      await refresh();
      setPicked([]);
      setAdding(false);
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
    }
  }

  return (
    <section aria-labelledby="members-heading">
      <div className="flex items-center justify-between">
        <h3 id="members-heading" className="text-sm font-semibold">
          Members <span className="font-normal text-meta">{detail?.members.length ?? ''}</span>
        </h3>
        {canAdd && !adding && candidates.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            Add people
          </Button>
        )}
      </div>

      {adding && (
        <div className="mt-3 rounded-lg bg-ground p-3 edge">
          <ul aria-label="People to add" className="max-h-48 relative overflow-y-auto">
            {candidates.map((m) => {
              const on = picked.includes(m.userId);
              return (
                <li key={m.userId}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-active">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setPicked((p) => (on ? p.filter((x) => x !== m.userId) : [...p, m.userId]))
                      }
                      className="m-0.5 size-5 shrink-0 accent-[var(--color-action)]"
                    />
                    <span className="text-sm">{m.name}</span>
                    {m.role === 'guest' && <span className="text-xs text-meta">Guest</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" disabled={!picked.length} onClick={() => void add()}>
              Add {picked.length || ''}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <SaveNote state={note} />

      <ul className="mt-2 divide-y divide-rule">
        {(detail?.members ?? []).map((m) => (
          <li key={m.userId} className="flex items-center gap-3 py-2">
            <span
              aria-hidden
              className="grid size-8 shrink-0 place-items-center rounded-full bg-bronze text-sm font-semibold"
            >
              {(m.name || '?').charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {m.name}
              {m.userId === me.user.id && <span className="text-meta"> (you)</span>}
              {m.role === 'guest' && <span className="text-meta"> · Guest</span>}
            </span>
            {isChannel && isAdmin && m.userId !== me.user.id && c.name !== 'general' && (
              <ConfirmButton
                className="hover:text-attention"
                aria-label={`Remove ${m.name}`}
                title={`Remove ${m.name}?`}
                description="They stop seeing new messages here. They can be added back later."
                confirmLabel="Remove"
                onConfirm={async () => {
                  await api(`/conversations/${c.id}/members/${m.userId}`, { method: 'DELETE' });
                  await refresh();
                }}
              >
                Remove
              </ConfirmButton>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Danger({
  conversation: c,
  label,
  isGeneral,
  onDone,
}: {
  conversation: SidebarConversation;
  label: string;
  isGeneral: boolean;
  onDone: () => void;
}) {
  const refresh = useRefresh(c.id);
  const navigate = useNavigate();
  const [note, setNote] = useState<Note>(null);
  const leaveAndGo = async (path: string) => {
    setNote(null);
    try {
      await api(`/conversations/${c.id}/${path}`, { json: {} });
      await refresh();
      onDone();
      void navigate('/');
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
    }
  };
  if (isGeneral) return null;
  return (
    <section className="flex flex-wrap items-center gap-2 border-t border-rule pt-4">
      <ConfirmButton
        variant="ghost"
        title={`Leave #${label}?`}
        description={
          c.kind === 'private'
            ? 'It’s private: someone inside will have to add you back.'
            : 'You can join again any time.'
        }
        confirmLabel="Leave"
        onConfirm={() => leaveAndGo('leave')}
      >
        Leave channel
      </ConfirmButton>
      <ConfirmButton
        variant="ghost"
        className="hover:text-attention"
        title={`Archive #${label}?`}
        description="It disappears from everyone’s sidebar and nobody can post. History stays searchable and it can be restored."
        confirmLabel="Archive"
        onConfirm={() => leaveAndGo('archive')}
      >
        Archive channel
      </ConfirmButton>
      <SaveNote state={note} />
    </section>
  );
}
