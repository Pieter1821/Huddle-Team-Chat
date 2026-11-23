import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/page';
import { api } from '@/lib/api';
import { useMembers } from '@/lib/queries';

type Entry = {
  id: string;
  actorId: string | null;
  action: string;
  targetId: string | null;
  ipAddress: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Plain-language names for what the log records. Unknown actions fall back to the raw name.
const ACTIONS: Record<string, string> = {
  'auth.sign_in': 'Signed in',
  'auth.sign_in_failed': 'Sign-in failed',
  'auth.sign_up_blocked': 'Sign-up blocked (not invited)',
  'auth.session_blocked': 'Blocked a deactivated account',
  'workspace.created': 'Set up the workspace',
  'workspace.updated': 'Changed workspace settings',
  'workspace.logo_changed': 'Uploaded a new logo',
  'workspace.logo_removed': 'Removed the logo',
  'webhook.created': 'Created a webhook',
  'webhook.revoked': 'Revoked a webhook',
  'invitation.created': 'Invited someone',
  'invitation.accepted': 'Accepted an invitation',
  'invitation.revoked': 'Withdrew an invitation',
  'member.role_changed': 'Changed a role',
  'member.deactivated': 'Deactivated someone',
  'member.reactivated': 'Reactivated someone',
  'export.started': 'Exported data',
  'import.started': 'Started a Slack import',
  'import.finished': 'Finished a Slack import',
};

/** Who did what and when: sign-ins, invitations, role changes and other security-relevant events. */
export function AuditTab() {
  const members = useMembers();
  const log = useInfiniteQuery({
    queryKey: ['audit'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<{ entries: Entry[]; nextBefore: string | null }>(
        `/admin/audit?limit=50${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextBefore,
  });
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  const who = (id: string | null) =>
    id ? (members.byId.get(id)?.name ?? 'Former member') : 'Nobody signed in';

  return (
    <Card
      title="Security log"
      description="Kept so you can check who did what. Only owners and admins can see it."
    >
      {log.isPending ? (
        <p className="text-sm text-meta">Loading…</p>
      ) : !entries.length ? (
        <p className="text-sm text-meta">Nothing recorded yet.</p>
      ) : (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs text-meta">
              <tr>
                <th scope="col" className="px-2 pb-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-2 pb-2 font-medium">
                  Who
                </th>
                <th scope="col" className="px-2 pb-2 font-medium">
                  What
                </th>
                <th scope="col" className="px-2 pb-2 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {entries.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="px-2 py-2.5 whitespace-nowrap text-muted tabular-nums">
                    {when.format(new Date(e.createdAt))}
                  </td>
                  <td className="px-2 py-2.5">{who(e.actorId)}</td>
                  <td className="px-2 py-2.5">{ACTIONS[e.action] ?? e.action}</td>
                  <td className="px-2 py-2.5 text-meta">{describe(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.hasNextPage && (
        <Button
          variant="ghost"
          className="mt-4"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {log.isFetchingNextPage ? 'Loading…' : 'Show older'}
        </Button>
      )}
    </Card>
  );
}

/** A short, readable summary of the entry's details (never the raw JSON). */
function describe(e: Entry): string {
  const m = e.meta ?? {};
  const parts: string[] = [];
  for (const key of ['email', 'role', 'from', 'to', 'name', 'channel', 'method'] as const) {
    const v = m[key];
    if (typeof v === 'string' || typeof v === 'number')
      parts.push(key === 'channel' ? `#${v}` : `${key}: ${v}`);
  }
  // Workspace settings: "name: Acme → Acme Studio".
  if (m.changes && typeof m.changes === 'object') {
    for (const [field, change] of Object.entries(
      m.changes as Record<string, { from: unknown; to: unknown }>,
    )) {
      parts.push(`${FIELD[field] ?? field}: ${show(change.from)} → ${show(change.to)}`);
    }
  }
  if (m.includeDms === true) parts.push('including direct messages');
  if (e.ipAddress) parts.push(`IP ${e.ipAddress}`);
  return parts.join(' · ');
}

const FIELD: Record<string, string> = {
  name: 'name',
  accent: 'colour',
  allowMemberGuestInvites: 'members invite guests',
};
const show = (v: unknown): string => {
  if (v === null || v === undefined) return 'default';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return JSON.stringify(v);
};
