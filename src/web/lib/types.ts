// Shapes of the API responses the screens use (mirroring the Worker's routes).

export type Role = 'owner' | 'admin' | 'member' | 'guest';

export type Branding = { name: string; accent: string; logoUrl: string | null };

export type Me = {
  user: { id: string; name: string; email: string; image: string | null };
  role: Role;
  needsName: boolean;
  workspace:
    | {
        id: string;
        name: string;
        accent: string | null;
        logoFileId: string | null;
        allowMemberGuestInvites?: boolean;
      }
    | undefined;
};

export type SidebarConversation = {
  id: string;
  kind: 'public' | 'private' | 'dm' | 'group_dm';
  name: string | null;
  topic: string | null;
  lastSeq: number;
  lastReadSeq: number;
  notifyLevel: 'all' | 'mentions' | 'muted';
  unread: number;
  mentions: number;
  members?: { userId: string; name: string }[];
};

export type InvitationPreview = {
  workspaceName: string;
  inviterName: string;
  email: string;
  role: Role;
  expiresAt: string;
};
