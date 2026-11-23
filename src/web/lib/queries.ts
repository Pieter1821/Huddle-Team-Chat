import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './api';
import { forgetPushOnSignOut } from './pwa';
import type { Branding, Me, Role, SidebarConversation } from './types';

/** The team's look, readable before sign-in. Its accent drives the theme's action colour. */
export function useBranding() {
  const query = useQuery({
    queryKey: ['branding'],
    queryFn: () => api<Branding>('/branding'),
    staleTime: 5 * 60_000,
  });
  const accent = query.data?.accent;
  useEffect(() => {
    if (accent) document.documentElement.style.setProperty('--huddle-accent', accent);
  }, [accent]);
  return query;
}

/** Who is signed in. 401 = signed out, 403 = signed in but not a member (e.g. before setup). */
export function useMe() {
  return useQuery<Me, ApiError>({
    queryKey: ['me'],
    queryFn: () => api<Me>('/me'),
    retry: false,
  });
}

export function useSetupStatus(enabled = true) {
  return useQuery({ queryKey: ['setup'], queryFn: () => api<{ needsSetup: boolean }>('/setup'), enabled });
}

export function useConversations(enabled = true) {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: async () =>
      (await api<{ conversations: SidebarConversation[] }>('/conversations')).conversations,
    enabled,
  });
}

/** Signs out and forgets everything cached for this person. */
export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await forgetPushOnSignOut();
      return api('/auth/sign-out', { json: {} });
    },
    onSettled: () => client.clear(),
  });
}

/** A conversation's display name: #channel, or the other people in a DM. */
export function conversationLabel(c: SidebarConversation, myId: string | undefined): string {
  if (c.kind === 'public' || c.kind === 'private') return c.name ?? 'channel';
  const others = (c.members ?? []).filter((m) => m.userId !== myId).map((m) => m.name || 'Someone');
  return others.length ? others.join(', ') : 'Just you';
}

export type Member = { userId: string; name: string; image: string | null; role: Role; email?: string };

/** Everyone you can see in the workspace, for names on messages and (later) mentions. */
export function useMembers() {
  const query = useQuery({
    queryKey: ['members'],
    queryFn: async () => (await api<{ members: Member[] }>('/members')).members,
    staleTime: 5 * 60_000,
  });
  const byId = new Map((query.data ?? []).map((m) => [m.userId, m]));
  return { ...query, byId };
}

export type ConversationDetail = {
  conversation: {
    id: string;
    kind: SidebarConversation['kind'];
    name: string | null;
    topic: string | null;
    lastSeq: number;
    archivedAt: string | null;
  };
  members: { userId: string; name: string; image: string | null; role: Role }[];
  isMember: boolean;
  guestCount: number;
};

export function useConversation(id: string, enabled = true) {
  return useQuery<ConversationDetail, ApiError>({
    queryKey: ['conversation', id],
    queryFn: () => api<ConversationDetail>(`/conversations/${id}`),
    enabled,
    retry: false,
  });
}
