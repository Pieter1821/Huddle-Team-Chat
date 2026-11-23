import { useRef, useState } from 'react';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';
import type { MessageDto } from '../../../shared/events';

type Manifest = {
  format: string;
  version: number;
  conversations: { id: string; kind: string; name: string | null; messages: number }[];
};
type State =
  | { kind: 'idle' }
  | { kind: 'working'; step: string; done: number; total: number }
  | { kind: 'done'; size: number }
  | { kind: 'failed'; message: string };

const safe = (s: string) => s.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 80) || 'file';

/**
 * The owner's copy of everything, as one .zip built in the browser (building it in the Worker would
 * exceed the free plan's CPU limit). Every export is recorded in the security log.
 */
export function ExportTab({ isOwner }: { isOwner: boolean }) {
  const [includeDms, setIncludeDms] = useState(false);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const stop = useRef(false);

  if (!isOwner) {
    return (
      <Card title="Export">
        <p className="text-sm text-muted">Only the workspace owner can export the workspace.</p>
      </Card>
    );
  }

  async function run() {
    stop.current = false;
    const scope = `includeDms=${includeDms ? 1 : 0}`;
    try {
      setState({ kind: 'working', step: 'Workspace and people', done: 0, total: 1 });
      const manifest = await api<Manifest>(`/export?${scope}`);
      const zip: Zippable = { 'huddle-export.json': strToU8(JSON.stringify(manifest, null, 2)) };
      const files: { id: string; name: string }[] = [];

      const total = manifest.conversations.length;
      for (const [i, c] of manifest.conversations.entries()) {
        if (stop.current) return setState({ kind: 'idle' });
        setState({ kind: 'working', step: 'Conversations', done: i, total });
        const messages: MessageDto[] = [];
        let after: number | null = 0;
        while (after !== null) {
          const page: { messages: MessageDto[]; nextAfter: number | null } = await api(
            `/export/conversations/${c.id}/messages?after=${after}&limit=500&${scope}`,
          );
          messages.push(...page.messages);
          after = page.nextAfter;
        }
        for (const m of messages) for (const f of m.files ?? []) files.push({ id: f.id, name: f.name });
        const label = c.name ? safe(c.name) : `${c.kind}-${c.id}`;
        zip[`conversations/${label}.json`] = strToU8(JSON.stringify({ conversation: c, messages }, null, 2));
      }

      if (includeFiles) {
        for (const [i, f] of files.entries()) {
          if (stop.current) return setState({ kind: 'idle' });
          setState({ kind: 'working', step: 'Files', done: i, total: files.length });
          const res = await fetch(`/api/export/files/${f.id}?${scope}`, { credentials: 'same-origin' });
          if (!res.ok) continue; // a missing file shouldn't spoil the whole export
          // Already-compressed formats (images, zips, PDFs) gain nothing from compressing again.
          zip[`files/${f.id}-${safe(f.name)}`] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
        }
      }

      setState({ kind: 'working', step: 'Packing the zip', done: 0, total: 1 });
      await new Promise((r) => setTimeout(r, 30));
      const bytes = zipSync(zip, { level: 6 });
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `huddle-export-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setState({ kind: 'done', size: bytes.byteLength });
    } catch (err) {
      setState({
        kind: 'failed',
        message: err instanceof ApiError ? err.message : 'The export stopped. Try again.',
      });
    }
  }

  const working = state.kind === 'working';
  return (
    <Card
      title="Export"
      description="Download a copy of your workspace: people, channels, every message with its threads and reactions, and optionally files."
    >
      <div className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={includeDms}
            disabled={working}
            onChange={(e) => setIncludeDms(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-[var(--color-action)]"
          />
          <span>
            <span className="block text-[15px]">Include direct messages</span>
            <span className="block text-sm text-meta">
              Private conversations between people. Off by default; the security log notes when they’re
              included.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={includeFiles}
            disabled={working}
            onChange={(e) => setIncludeFiles(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-[var(--color-action)]"
          />
          <span>
            <span className="block text-[15px]">Include files</span>
            <span className="block text-sm text-meta">
              Makes the download larger. Without them, messages still list each file’s name.
            </span>
          </span>
        </label>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {working ? (
          <Button variant="ghost" onClick={() => (stop.current = true)}>
            Stop
          </Button>
        ) : (
          <Button onClick={() => void run()}>
            <Download aria-hidden className="size-4" />
            Download export
          </Button>
        )}
        <p role="status" className="text-sm text-muted">
          {state.kind === 'working' &&
            `${state.step}${state.total > 1 ? ` (${state.done} of ${state.total})` : ''}…`}
          {state.kind === 'done' && `Done: ${(state.size / 1024 / 1024).toFixed(1)} MB downloaded.`}
          {state.kind === 'failed' && <span className="text-attention">{state.message}</span>}
        </p>
      </div>
    </Card>
  );
}
