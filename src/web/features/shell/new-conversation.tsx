import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Hash, Lock } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormError } from '@/features/auth/auth-layout';
import { ApiError, api } from '@/lib/api';
import { useMembers, useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** Channel names are lowercase words joined by dashes, like the server stores them. */
const channelSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export function NewChannelDialog({ open, onOpenChange }: DialogProps) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = channelSlug(name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await api<{ conversation: { id: string } }>('/conversations', {
        json: {
          name: slug,
          kind: isPrivate ? 'private' : 'public',
          ...(topic.trim() ? { topic: topic.trim() } : {}),
        },
      });
      await client.invalidateQueries({ queryKey: ['conversations'] });
      onOpenChange(false);
      setName('');
      setTopic('');
      setPrivate(false);
      void navigate(`/c/${conversation.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The channel wasn’t created. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New channel"
      description="Channels are where a topic, project or team talks."
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4 px-6 pt-5 pb-6" noValidate>
        <div className="space-y-2">
          <Label htmlFor="channel-name">Name</Label>
          <Input
            id="channel-name"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. launch-plans"
          />
          {slug && slug !== name && <p className="text-xs text-meta">Will be created as #{slug}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="channel-topic">Topic (optional)</Label>
          <Input
            id="channel-topic"
            maxLength={250}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What it’s for"
          />
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Who can find it</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {[
              { value: false, Icon: Hash, title: 'Public', text: 'Anyone on the team can find and join it.' },
              { value: true, Icon: Lock, title: 'Private', text: 'Only people you add can see it.' },
            ].map(({ value, Icon, title, text }) => (
              <label
                key={title}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg p-3 edge has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-action',
                  isPrivate === value && 'bg-active ring-1 ring-action/60',
                )}
              >
                <input
                  type="radio"
                  name="visibility"
                  className="sr-only"
                  checked={isPrivate === value}
                  onChange={() => setPrivate(value)}
                />
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-meta" />
                <span>
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs text-muted">{text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !slug}>
            Create channel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Browsable = { id: string; name: string; topic: string | null; members: number; joined: number };

/** Every public channel: join one, or open it to read first. */
export function BrowseChannelsDialog({
  open,
  onOpenChange,
  onCreate,
}: DialogProps & { onCreate: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [joining, setJoining] = useState<string | null>(null);
  const channels = useQuery({
    queryKey: ['browse'],
    queryFn: async () => (await api<{ channels: Browsable[] }>('/conversations/browse')).channels,
    enabled: open,
  });
  const shown = (channels.data ?? []).filter((c) => c.name.includes(channelSlug(filter)));

  const openChannel = (id: string) => {
    onOpenChange(false);
    void navigate(`/c/${id}`);
  };
  const join = async (id: string) => {
    setJoining(id);
    try {
      await api(`/conversations/${id}/join`, { json: {} });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['conversations'] }),
        client.invalidateQueries({ queryKey: ['browse'] }),
        client.invalidateQueries({ queryKey: ['conversation', id] }),
      ]);
      openChannel(id);
    } finally {
      setJoining(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Browse channels" top>
      <div className="flex gap-2 px-6 pt-4">
        <Input
          autoFocus
          aria-label="Filter channels"
          placeholder="Filter by name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button variant="ghost" className="shrink-0" onClick={onCreate}>
          Create a channel
        </Button>
      </div>
      <ul className="mt-3 min-h-0 flex-1 relative overflow-y-auto px-3 pb-4">
        {channels.isPending && <li className="px-3 py-6 text-center text-sm text-meta">Loading…</li>}
        {channels.data && !shown.length && (
          <li className="px-3 py-6 text-center text-sm text-meta">No channels match.</li>
        )}
        {shown.map((c) => (
          <li key={c.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-active">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openChannel(c.id)}>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Hash aria-hidden className="size-3.5 text-meta" />
                {c.name}
              </span>
              <span className="block truncate text-xs text-meta">
                {c.members} {c.members === 1 ? 'member' : 'members'}
                {c.topic ? ` · ${c.topic}` : ''}
              </span>
            </button>
            {c.joined ? (
              <span className="flex items-center gap-1 text-xs text-meta">
                <Check aria-hidden className="size-3.5" /> Joined
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={joining === c.id}
                onClick={() => void join(c.id)}
                aria-label={`Join #${c.name}`}
              >
                Join
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Pick one or more people (up to 8) and open your conversation with them. */
export function NewMessageDialog({ open, onOpenChange }: DialogProps) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const members = useMembers();
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const people = (members.data ?? []).filter(
    (m) => m.userId !== me?.user.id && m.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 8 ? [...p, id] : p));

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await api<{ conversation: { id: string } }>('/conversations/dm', {
        json: { userIds: picked.length ? picked : [me?.user.id ?? ''] },
      });
      await client.invalidateQueries({ queryKey: ['conversations'] });
      onOpenChange(false);
      setPicked([]);
      setFilter('');
      void navigate(`/c/${conversation.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That conversation couldn’t be opened.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New message"
      description="Pick up to 8 people."
      top
    >
      <div className="px-6 pt-4">
        <Input
          autoFocus
          aria-label="Find people"
          placeholder="Find people"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <ul aria-label="People" className="mt-3 min-h-0 flex-1 relative overflow-y-auto px-3">
        {people.map((p) => {
          const on = picked.includes(p.userId);
          return (
            <li key={p.userId}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(p.userId)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-active focus-visible:bg-active focus-visible:outline-none"
              >
                <span
                  aria-hidden
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-bronze text-sm font-semibold"
                >
                  {p.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                {p.role === 'guest' && <span className="text-xs text-meta">Guest</span>}
                <span
                  aria-hidden
                  className={cn(
                    'grid size-5 place-items-center rounded-md edge',
                    on && 'bg-action text-action-ink',
                  )}
                >
                  {on && <Check className="size-3.5" />}
                </span>
              </button>
            </li>
          );
        })}
        {members.data && !people.length && (
          <li className="px-3 py-6 text-center text-sm text-meta">Nobody matches.</li>
        )}
      </ul>
      <div className="flex items-center justify-between gap-3 px-6 pt-3 pb-5">
        <FormError message={error} />
        <Button disabled={busy || !picked.length} onClick={() => void start()}>
          {picked.length > 1 ? `Message ${picked.length} people` : 'Message'}
        </Button>
      </div>
    </Dialog>
  );
}
