import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Card, SaveNote, Select } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';
import { useConversations, type Member } from '@/lib/queries';
import type { Me, Role } from '@/lib/types';
import { cn } from '@/lib/utils';

type AdminMember = Member & {
  email?: string;
  status?: 'active' | 'deactivated';
  guestExpiresAt?: string | null;
};
type Invitation = {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  invitedBy: string;
};
type Note = { ok: boolean; text: string } | null;

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

/** Mirrors the server's rule, only to hide choices that would be refused anyway. */
function canChangeRole(me: Me, target: AdminMember, next: Role) {
  if (me.user.id === target.userId || target.role === 'owner' || next === 'owner') return false;
  if (me.role === 'owner') return true;
  return me.role === 'admin' && target.role !== 'admin' && next !== 'admin';
}
const canDeactivate = (me: Me, target: AdminMember) =>
  me.user.id !== target.userId &&
  target.role !== 'owner' &&
  (me.role === 'owner' || (me.role === 'admin' && target.role !== 'admin'));

export function PeopleTab({ me }: { me: Me }) {
  return (
    <>
      <InviteCard me={me} />
      <PendingCard />
      <MembersCard me={me} />
    </>
  );
}

function InviteCard({ me }: { me: Me }) {
  const client = useQueryClient();
  const channels = useConversations();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [guestChannels, setGuestChannels] = useState<string[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roles: Role[] = me.role === 'owner' ? ['member', 'guest', 'admin'] : ['member', 'guest'];
  const channelChoices = (channels.data ?? []).filter((c) => c.kind === 'public' || c.kind === 'private');

  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    setLink(null);
    try {
      const res = await api<{ link: string; emailSent: boolean }>('/invitations', {
        json: {
          email: email.trim(),
          role,
          ...(role === 'guest' ? { conversationIds: guestChannels } : {}),
        },
      });
      await client.invalidateQueries({ queryKey: ['invitations'] });
      setNote({
        ok: true,
        text: res.emailSent ? `Invitation emailed to ${email.trim()}.` : 'Invitation created.',
      });
      // Without an email service, the link is the way in: show it to copy and share.
      if (!res.emailSent) setLink(res.link);
      setEmail('');
      setGuestChannels([]);
    } catch (err) {
      setNote({ ok: false, text: errorText(err, 'The invitation wasn’t created.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Invite people"
      description="Huddle is invite-only. Invitations work once and expire after 7 days."
    >
      <form onSubmit={(e) => void invite(e)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {role === 'guest' && (
          <fieldset>
            <legend className="text-sm font-medium">Channels the guest can see</legend>
            <p className="text-xs text-meta">Guests only see these channels and the people in them.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {channelChoices.map((c) => {
                const on = guestChannels.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className={cn(
                      'cursor-pointer rounded-pill px-3 py-1.5 text-sm edge has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-action',
                      on ? 'bg-action/15 text-ink ring-1 ring-action/60' : 'text-muted',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={() =>
                        setGuestChannels((g) => (on ? g.filter((x) => x !== c.id) : [...g, c.id]))
                      }
                    />
                    #{c.name}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={busy || !email.includes('@') || (role === 'guest' && !guestChannels.length)}
          >
            Send invitation
          </Button>
          <SaveNote state={note} />
        </div>
        {link && <CopyLink link={link} />}
      </form>
    </Card>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg bg-ground p-3 edge">
      <p className="text-sm text-muted">
        No email service is set up, so share this link with them yourself. It works once.
      </p>
      <div className="mt-2 flex gap-2">
        <Input
          readOnly
          value={link}
          aria-label="Invitation link"
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function PendingCard() {
  const client = useQueryClient();
  const pending = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => (await api<{ invitations: Invitation[] }>('/invitations')).invitations,
  });
  if (!pending.data?.length) return null;
  return (
    <Card title="Pending invitations">
      <ul className="divide-y divide-rule">
        {pending.data.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
            <span className="min-w-0 flex-1 truncate text-[15px]">{inv.email}</span>
            <span className="text-sm text-muted">{ROLE_LABEL[inv.role]}</span>
            <span className="text-sm text-meta">Expires {date.format(new Date(inv.expiresAt))}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Withdraw the invitation for ${inv.email}`}
              onClick={() =>
                void api(`/invitations/${inv.id}`, { method: 'DELETE' }).then(() =>
                  client.invalidateQueries({ queryKey: ['invitations'] }),
                )
              }
            >
              Withdraw
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MembersCard({ me }: { me: Me }) {
  const client = useQueryClient();
  const members = useQuery({
    queryKey: ['members', 'admin'],
    queryFn: async () => (await api<{ members: AdminMember[] }>('/members')).members,
  });
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState<Note>(null);
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['members'] }),
      client.invalidateQueries({ queryKey: ['members', 'admin'] }),
    ]);

  const run = async (action: Promise<unknown>, ok: string) => {
    setNote(null);
    try {
      await action;
      await refresh();
      setNote({ ok: true, text: ok });
    } catch (err) {
      setNote({ ok: false, text: errorText(err, 'That change didn’t save.') });
    }
  };

  const shown = (members.data ?? []).filter((m) =>
    `${m.name} ${m.email ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <Card
      title="Members"
      description={
        members.data ? `${members.data.filter((m) => m.status !== 'deactivated').length} active` : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Filter members"
          placeholder="Filter by name or email"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <SaveNote state={note} />
      </div>
      <ul className="mt-3 divide-y divide-rule">
        {shown.map((m) => {
          const off = m.status === 'deactivated';
          const roleChoices = (['admin', 'member', 'guest'] as Role[]).filter(
            (r) => r === m.role || canChangeRole(me, m, r),
          );
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <span
                aria-hidden
                className={cn(
                  'grid size-9 shrink-0 place-items-center rounded-full bg-bronze text-sm font-semibold',
                  off && 'opacity-50', // only the decorative initial fades; text keeps full contrast
                )}
              >
                {(m.name || '?').charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[15px] font-medium', off && 'text-muted')}>
                  {m.name || 'No name yet'}
                  {m.userId === me.user.id && <span className="font-normal text-meta"> (you)</span>}
                </span>
                <span className="block truncate text-sm text-meta">
                  {m.email}
                  {off && ' · Deactivated'}
                  {m.role === 'guest' &&
                    m.guestExpiresAt &&
                    ` · Access ends ${date.format(new Date(m.guestExpiresAt))}`}
                </span>
              </span>
              {roleChoices.length > 1 && !off ? (
                <Select
                  aria-label={`Role for ${m.name}`}
                  value={m.role}
                  className="w-32"
                  onChange={(e) =>
                    void run(
                      api(`/members/${m.userId}`, { method: 'PATCH', json: { role: e.target.value } }),
                      `${m.name} is now ${ROLE_LABEL[e.target.value as Role].toLowerCase()}.`,
                    )
                  }
                >
                  {roleChoices.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="w-32 text-sm text-muted">{ROLE_LABEL[m.role]}</span>
              )}
              {canDeactivate(me, m) &&
                (off ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void run(
                        api(`/members/${m.userId}/reactivate`, { json: {} }),
                        `${m.name} can sign in again.`,
                      )
                    }
                  >
                    Reactivate
                  </Button>
                ) : (
                  <ConfirmButton
                    className="hover:text-attention"
                    title={`Deactivate ${m.name}?`}
                    description="They’re signed out everywhere at once and can’t sign in until you reactivate them. Their messages stay."
                    confirmLabel="Deactivate"
                    onConfirm={() =>
                      run(api(`/members/${m.userId}/deactivate`, { json: {} }), `${m.name} was deactivated.`)
                    }
                  >
                    Deactivate
                  </ConfirmButton>
                ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
