import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, SaveNote, Select } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';
import { useConversations } from '@/lib/queries';

type Webhook = { id: string; name: string; createdAt: string; createdBy: string };
type Note = { ok: boolean; text: string } | null;
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** Incoming webhooks: a secret URL that lets another tool post messages into one channel. */
export function WebhooksTab() {
  const client = useQueryClient();
  const channels = (useConversations().data ?? []).filter((c) => c.kind === 'public' || c.kind === 'private');
  const [channelId, setChannelId] = useState('');
  const selected = channelId || channels[0]?.id || '';
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null);
  const [note, setNote] = useState<Note>(null);

  const hooks = useQuery({
    queryKey: ['webhooks', selected],
    queryFn: async () => (await api<{ webhooks: Webhook[] }>(`/conversations/${selected}/webhooks`)).webhooks,
    enabled: Boolean(selected),
  });

  async function create(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    try {
      const res = await api<{ url: string }>(`/conversations/${selected}/webhooks`, {
        json: { name: name.trim() },
      });
      setCreated({ name: name.trim(), url: res.url });
      setName('');
      await client.invalidateQueries({ queryKey: ['webhooks', selected] });
    } catch (err) {
      setNote({ ok: false, text: err instanceof ApiError ? err.message : 'The webhook wasn’t created.' });
    }
  }

  return (
    <>
      <Card
        title="Incoming webhooks"
        description="Let another tool (a build server, a form, a monitor) post messages into a channel. Anyone with the URL can post, so keep it secret."
      >
        <div className="space-y-2">
          <Label htmlFor="hook-channel">Channel</Label>
          <Select
            id="hook-channel"
            value={selected}
            onChange={(e) => {
              setChannelId(e.target.value);
              setCreated(null);
            }}
          >
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </Select>
        </div>
        <form onSubmit={(e) => void create(e)} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="hook-name">Name shown on its messages</Label>
            <Input
              id="hook-name"
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Deploy bot"
            />
          </div>
          <Button type="submit" disabled={!selected || !name.trim()}>
            Create webhook
          </Button>
        </form>
        <div className="mt-2">
          <SaveNote state={note} />
        </div>
        {created && <NewHook {...created} />}
      </Card>

      <Card title={`Webhooks in this channel`}>
        {!hooks.data?.length ? (
          <p className="text-sm text-meta">None yet.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {hooks.data.map((h) => (
              <li key={h.id} className="flex items-center gap-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{h.name}</span>
                  <span className="block text-sm text-meta">
                    Created {date.format(new Date(h.createdAt))}
                  </span>
                </span>
                <ConfirmButton
                  className="hover:text-attention"
                  aria-label={`Revoke ${h.name}`}
                  title={`Revoke ${h.name}?`}
                  description="Its URL stops working at once. Anything still using it will get an error."
                  confirmLabel="Revoke"
                  onConfirm={async () => {
                    await api(`/webhooks/${h.id}`, { method: 'DELETE' });
                    await client.invalidateQueries({ queryKey: ['webhooks', selected] });
                  }}
                >
                  Revoke
                </ConfirmButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** The URL is shown once: only a hash is stored, so it can't be looked up again. */
function NewHook({ name, url }: { name: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const example = `curl -X POST ${url} \\\n  -H "content-type: application/json" \\\n  -d '{"text": "Build passed ✅"}'`;
  return (
    <div className="mt-4 rounded-lg bg-ground p-4 edge">
      <p className="text-sm font-medium">{name} is ready. Copy its URL now: it won’t be shown again.</p>
      <div className="mt-2 flex gap-2">
        <Input
          readOnly
          value={url}
          aria-label="Webhook URL"
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <Button
          variant="ghost"
          onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}
        >
          {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="mt-3 text-xs text-meta">Try it:</p>
      <pre className="mt-1 overflow-x-auto rounded-lg bg-raised p-3 font-mono text-xs leading-relaxed">
        {example}
      </pre>
    </div>
  );
}
