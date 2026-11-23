import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { openLiveSocket } from '@/lib/live-socket';
import type { SidebarConversation } from '@/lib/types';

type HubFrame =
  | { type: 'presence.snapshot'; online: string[] }
  | { type: 'presence'; userId: string; online: boolean }
  | { type: 'activity'; conversationId: string; seq: number; authorId: string | null; mentioned: boolean }
  | { type: 'conversation.changed'; conversationId: string };

/**
 * The workspace socket keeps the sidebar live: new-message pings update unread and mention badges,
 * membership changes reload the list, and presence says who is online.
 * `openConversationId` is the conversation on screen, which marks itself read instead.
 */
export function useWorkspaceLive(myId: string | undefined, openConversationId: string | undefined) {
  const client = useQueryClient();
  const openRef = useRef(openConversationId);
  useEffect(() => {
    openRef.current = openConversationId;
  }, [openConversationId]);
  useEffect(() => {
    if (!myId) return;
    const socket = openLiveSocket({
      url: () => '/api/realtime/socket',
      onMessage: (data) => {
        const frame = data as HubFrame;
        if (frame.type === 'presence.snapshot') {
          client.setQueryData(['presence'], new Set(frame.online));
        } else if (frame.type === 'presence') {
          client.setQueryData<Set<string>>(['presence'], (prev) => {
            const next = new Set(prev);
            if (frame.online) next.add(frame.userId);
            else next.delete(frame.userId);
            return next;
          });
        } else if (frame.type === 'conversation.changed') {
          void client.invalidateQueries({ queryKey: ['conversations'] });
        } else if (frame.type === 'activity') {
          const list = client.getQueryData<SidebarConversation[]>(['conversations']);
          if (!list?.some((c) => c.id === frame.conversationId)) {
            void client.invalidateQueries({ queryKey: ['conversations'] });
            return;
          }
          const fromSomeoneElse = frame.authorId !== myId;
          client.setQueryData<SidebarConversation[]>(['conversations'], (prev) =>
            prev?.map((c) => {
              if (c.id !== frame.conversationId || frame.seq <= c.lastSeq) return c;
              const counts = fromSomeoneElse && c.id !== openRef.current;
              return {
                ...c,
                lastSeq: frame.seq,
                unread: counts ? c.unread + 1 : c.unread,
                mentions: counts && frame.mentioned ? c.mentions + 1 : c.mentions,
              };
            }),
          );
        }
      },
      // After a reconnect, counts may have moved while we were away.
      onStatus: (status) => {
        if (status === 'open') void client.invalidateQueries({ queryKey: ['conversations'] });
      },
    });
    return () => socket.close();
  }, [client, myId]);
}
