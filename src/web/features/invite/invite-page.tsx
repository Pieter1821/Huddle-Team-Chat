import { InviteCard } from '@/features/admin/people-tab';
import { Page } from '@/components/ui/page';
import { useMe } from '@/lib/queries';

/**
 * Invite people, for anyone the workspace lets invite: owners and admins always, members when an
 * owner or admin has turned it on (the server decides on every invitation too).
 */
export function InvitePage() {
  const { data: me } = useMe();
  if (!me) return null;
  const allowed =
    me.role === 'owner' ||
    me.role === 'admin' ||
    (me.role === 'member' && (me.workspace?.allowMemberInvites || me.workspace?.allowMemberGuestInvites));
  return (
    <Page title="Invite people">
      {allowed ? (
        <InviteCard me={me} />
      ) : (
        <p className="text-[15px] text-muted">
          Inviting people isn’t turned on for your role. Ask an owner or admin.
        </p>
      )}
    </Page>
  );
}
