import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Hash, Lock, Search, User } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useMembers } from '@/lib/queries';
import type { MessageDto } from '../../../shared/events';

type Results = {
  messages: {
    message: MessageDto;
    conversation: { id: string; kind: string; name: string | null };
    snippet: string;
  }[];
  files: {
    id: string;
    name: string;
    mime: string;
    size: number;
    messageId: string | null;
    conversationId: string;
  }[];
  channels: { id: string; name: string; kind: string; topic: string | null }[];
  people: { userId: string; name: string }[];
};

const START = '\u0002';
const END = '\u0003';
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** Ctrl+K: find messages, files, channels and people, limited to what you're allowed to see. */
export function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const client = useQueryClient();
  const members = useMembers();

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);

  const results = useQuery({
    queryKey: ['search', query],
    queryFn: () => api<Results>(`/search?q=${encodeURIComponent(query)}&limit=20`),
    enabled: open && /[\p{L}\p{N}]/u.test(query),
    staleTime: 30_000,
  });

  const go = (path: string) => {
    onOpenChange(false);
    void navigate(path);
  };
  const nameOf = (id: string) => members.byId.get(id)?.name ?? 'someone';
  const data = results.data;
  const empty =
    data && !data.messages.length && !data.files.length && !data.channels.length && !data.people.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setInput('');
      }}
      title="Search"
      top
    >
      <div className="px-6 pt-4">
        <label className="relative block">
          <span className="sr-only">Search messages, files, channels and people</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-meta"
          />
          <input
            autoFocus
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Messages, files, channels, people"
            maxLength={200}
            className="h-11 w-full rounded-pill bg-ground pr-4 pl-11 text-[15px] outline-none edge placeholder:text-meta focus-visible:ring-2 focus-visible:ring-action [&::-webkit-search-cancel-button]:appearance-none"
          />
        </label>
      </div>

      <div
        className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-4"
        aria-live="polite"
        aria-busy={results.isFetching}
      >
        {!query ? (
          <p className="px-3 py-6 text-center text-sm text-meta">
            Every word must match; endings are filled in (“kitch” finds “kitchen”).
          </p>
        ) : results.isError ? (
          <p className="px-3 py-6 text-center text-sm text-attention">
            Search didn’t work. Try different words.
          </p>
        ) : empty ? (
          <p className="px-3 py-6 text-center text-sm text-meta">Nothing matches “{query}”.</p>
        ) : data ? (
          <>
            {data.channels.length > 0 && (
              <Section title="Channels">
                {data.channels.map((ch) => (
                  <Row
                    key={ch.id}
                    onClick={() => go(`/c/${ch.id}`)}
                    icon={ch.kind === 'private' ? Lock : Hash}
                    title={ch.name}
                    detail={ch.topic}
                  />
                ))}
              </Section>
            )}
            {data.people.length > 0 && (
              <Section title="People">
                {data.people.map((p) => (
                  <Row
                    key={p.userId}
                    icon={User}
                    title={p.name}
                    detail="Send a direct message"
                    onClick={() => {
                      void api<{ conversation: { id: string } }>('/conversations/dm', {
                        json: { userIds: [p.userId] },
                      }).then(async ({ conversation }) => {
                        await client.invalidateQueries({ queryKey: ['conversations'] });
                        go(`/c/${conversation.id}`);
                      });
                    }}
                  />
                ))}
              </Section>
            )}
            {data.messages.length > 0 && (
              <Section title="Messages">
                {data.messages.map(({ message: m, conversation: c, snippet }) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => go(m.parentId ? `/c/${c.id}/t/${m.parentId}` : `/c/${c.id}`)}
                      className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-active focus-visible:bg-active focus-visible:outline-none"
                    >
                      <span className="flex items-baseline gap-2 text-xs text-meta">
                        <span className="font-medium text-muted">
                          {m.authorId ? nameOf(m.authorId) : (m.webhookName ?? 'App')}
                        </span>
                        <span>{c.name ? `#${c.name}` : 'Direct message'}</span>
                        {m.parentId && <span>in a thread</span>}
                        <span className="ml-auto">{when.format(new Date(m.createdAt))}</span>
                      </span>
                      <span className="mt-0.5 block text-sm leading-relaxed">
                        <Highlighted snippet={snippet} nameOf={nameOf} />
                      </span>
                    </button>
                  </li>
                ))}
              </Section>
            )}
            {data.files.length > 0 && (
              <Section title="Files">
                {data.files.map((f) => (
                  <li key={f.id}>
                    <a
                      href={`/api/files/${f.id}`}
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-active focus-visible:bg-active focus-visible:outline-none"
                    >
                      <FileText aria-hidden className="size-4 shrink-0 text-meta" />
                      <span className="truncate text-sm">{f.name}</span>
                    </a>
                  </li>
                ))}
              </Section>
            )}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-2">
      <h3 className="px-3 pb-1 text-xs font-medium text-meta">{title}</h3>
      <ul>{children}</ul>
    </section>
  );
}

function Row({
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  icon: typeof Hash;
  title: string;
  detail?: string | null;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-active focus-visible:bg-active focus-visible:outline-none"
      >
        <Icon aria-hidden className="size-4 shrink-0 text-meta" />
        <span className="truncate text-sm font-medium">{title}</span>
        {detail && <span className="ml-auto truncate text-xs text-meta">{detail}</span>}
      </button>
    </li>
  );
}

/**
 * The server marks matches with control characters (never HTML). They become <mark> elements here,
 * and mention tokens become names, so message text can't inject anything into the page.
 */
function Highlighted({ snippet, nameOf }: { snippet: string; nameOf: (id: string) => string }) {
  const tidy = (text: string) =>
    text
      .replace(/<@([0-9A-HJKMNP-TV-Z]{26})>/g, (_, id: string) => `@${nameOf(id)}`)
      .replace(/<@(channel|here)>/g, '@$1')
      .replace(/(\*\*|~~|```|`)/g, '');
  const parts: ReactNode[] = [];
  let rest = snippet;
  let key = 0;
  while (rest) {
    const s = rest.indexOf(START);
    if (s < 0) {
      parts.push(tidy(rest));
      break;
    }
    const e = rest.indexOf(END, s);
    parts.push(tidy(rest.slice(0, s)));
    parts.push(
      <mark key={key++} className="rounded bg-action/25 px-0.5 text-ink">
        {tidy(rest.slice(s + 1, e < 0 ? undefined : e))}
      </mark>,
    );
    rest = e < 0 ? '' : rest.slice(e + 1);
  }
  return <>{parts}</>;
}
