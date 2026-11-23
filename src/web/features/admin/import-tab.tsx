import { useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { unzipSync } from 'fflate';
import { CheckCircle2, FileArchive, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { runImport, type ImportOptions, type Outcome, type Progress } from './import-runner';
import { ExportError, parseSlackExport, type SlackExport } from './slack-export';

const DAILY_LIMIT = 20_000;
const SESSION_KEY = 'huddle-import-session';
const number = new Intl.NumberFormat();
const month = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });

type Loaded = { data: SlackExport; fingerprint: string; fileName: string };
type Phase = { kind: 'pick' } | { kind: 'ready' } | { kind: 'running'; progress: Progress | null } | Outcome;

/** Remembers the open import for this zip, so a closed tab or the daily limit can continue it. */
const saved = (fingerprint: string): string | null => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const s = raw ? (JSON.parse(raw) as { fingerprint: string; sessionId: string }) : null;
    return s?.fingerprint === fingerprint ? s.sessionId : null;
  } catch {
    return null;
  }
};
const remember = (fingerprint: string, sessionId: string | null) => {
  try {
    if (sessionId) localStorage.setItem(SESSION_KEY, JSON.stringify({ fingerprint, sessionId }));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Private windows may refuse storage; the import still works, it just can't be resumed later.
  }
};

/** Bring a team's history over from a Slack export. Owner only (the server enforces it too). */
export function ImportTab({ isOwner }: { isOwner: boolean }) {
  const client = useQueryClient();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [options, setOptions] = useState<ImportOptions>({ includeDirectMessages: true, includeFiles: true });
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  if (!isOwner) {
    return (
      <Card title="Import from Slack">
        <p className="text-sm text-muted">Only the workspace owner can import history.</p>
      </Card>
    );
  }

  async function read(file: File) {
    setError(null);
    setReading(true);
    // Let the "Reading…" state paint before the (synchronous) unzip.
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (!/\.zip$/i.test(file.name)) throw new ExportError('Choose the .zip file Slack gave you.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Only the JSON is needed: attachments in the zip are skipped, keeping memory low.
      const files = unzipSync(bytes, { filter: (f) => f.name.endsWith('.json') });
      const data = parseSlackExport(files);
      setLoaded({ data, fingerprint: `${file.name}:${file.size}:${file.lastModified}`, fileName: file.name });
      setPhase({ kind: 'ready' });
    } catch (err) {
      setError(
        err instanceof ExportError ? err.message : 'That zip couldn’t be opened. Is it the Slack export?',
      );
    } finally {
      setReading(false);
    }
  }

  async function start() {
    if (!loaded) return;
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: 'running', progress: null });
    try {
      let sessionId = saved(loaded.fingerprint);
      if (sessionId) {
        const status = await api<{ session: { status: string } }>(`/import/${sessionId}`).catch(() => null);
        if (status?.session.status !== 'open') sessionId = null;
      }
      if (!sessionId) {
        sessionId = (await api<{ sessionId: string }>('/import', { json: {} })).sessionId;
        remember(loaded.fingerprint, sessionId);
      }
      const outcome = await runImport(
        sessionId,
        loaded.data,
        options,
        (progress) => setPhase({ kind: 'running', progress }),
        controller.signal,
      );
      if (outcome.kind === 'finished') {
        remember(loaded.fingerprint, null);
        await client.invalidateQueries({ queryKey: ['conversations'] });
        await client.invalidateQueries({ queryKey: ['members'] });
      }
      setPhase(outcome);
    } catch (err) {
      setPhase({ kind: 'ready' });
      setError(err instanceof ApiError ? err.message : 'The import couldn’t start.');
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) void read(file);
  };

  if (phase.kind === 'pick' || !loaded) {
    return (
      <Card
        title="Import from Slack"
        description="Bring your team’s channels, messages, threads, reactions and files across. Your Slack workspace isn’t changed."
      >
        <ol className="mb-5 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>
            In Slack, a workspace owner or admin opens{' '}
            <span className="text-ink">
              Tools &amp; settings › Workspace settings › Import/Export data › Export
            </span>
            .
          </li>
          <li>When Slack emails that it’s ready, download the .zip.</li>
          <li>Choose it below. It’s read in your browser; only the content is sent to Huddle.</li>
        </ol>
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="flex flex-col items-center gap-3 rounded-card border border-dashed border-edge px-6 py-10 text-center"
        >
          <FileArchive aria-hidden className="size-8 text-meta" />
          <p className="text-sm text-muted">Drop the Slack export here, or</p>
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            hidden
            aria-label="Slack export zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void read(file);
              e.target.value = '';
            }}
          />
          <Button variant="ghost" disabled={reading} onClick={() => input.current?.click()}>
            {reading ? 'Reading…' : 'Choose the .zip'}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-attention">
            {error}
          </p>
        )}
      </Card>
    );
  }

  const s = loaded.data.summary;
  const includedMessages = options.includeDirectMessages
    ? s.messages
    : loaded.data.channels
        .filter((c) => c.kind === 'public' || c.kind === 'private')
        .reduce((n, c) => n + (loaded.data.messages.get(c.slackId)?.length ?? 0), 0);
  const days = Math.max(1, Math.ceil(includedMessages / DAILY_LIMIT));

  if (phase.kind === 'ready') {
    return (
      <Card title="Ready to import" description={loaded.fileName}>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {[
            ['People', s.people],
            ['Public channels', s.publicChannels],
            ['Private channels', s.privateChannels],
            ['Direct messages', s.directMessages],
            ['Messages', s.messages],
            ['Files', s.files],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-meta">{label}</dt>
              <dd className="mt-0.5 text-xl font-semibold tabular-nums">{number.format(Number(value))}</dd>
            </div>
          ))}
        </dl>
        {s.from && s.to && (
          <p className="mt-4 text-sm text-muted">
            History from {month.format(new Date(s.from))} to {month.format(new Date(s.to))}.
          </p>
        )}
        <div className="mt-5 space-y-3">
          <Option
            checked={options.includeDirectMessages}
            onChange={(v) => setOptions((o) => ({ ...o, includeDirectMessages: v }))}
            title="Include direct messages"
            text="Private conversations between people. Only include them if your team expects that."
          />
          <Option
            checked={options.includeFiles}
            onChange={(v) => setOptions((o) => ({ ...o, includeFiles: v }))}
            title="Copy files from Slack"
            text="Downloads each file from Slack’s servers into your storage. Files Slack no longer serves are skipped."
          />
        </div>
        <p className="mt-4 rounded-lg bg-ground p-3 text-sm text-muted edge">
          People who aren’t in Huddle yet are added <span className="text-ink">deactivated</span>, so their
          messages keep the right names. To let someone sign in, reactivate them under People: they use the
          same email as in Slack and see their history. People already here keep their account.
          {days > 1 &&
            ` To stay inside the free plan, up to ${number.format(DAILY_LIMIT)} messages are imported a day: this one takes about ${days} days. Come back and press Continue each day.`}
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-attention">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={() => void start()}>
            {saved(loaded.fingerprint) ? 'Continue import' : 'Start import'}
          </Button>
          <Button variant="ghost" onClick={() => setPhase({ kind: 'pick' })}>
            Choose another file
          </Button>
        </div>
      </Card>
    );
  }

  const progress = phase.kind === 'running' ? phase.progress : phase.progress;
  return (
    <Card
      title={phase.kind === 'finished' ? 'Import finished' : 'Importing from Slack'}
      description={loaded.fileName}
    >
      {phase.kind === 'finished' && (
        <p className="mb-4 flex items-center gap-2 text-[15px]">
          <CheckCircle2 aria-hidden className="size-5 text-action" />
          Your Slack history is in Huddle. Imported channels are in the sidebar.
        </p>
      )}
      {(phase.kind === 'daily-limit' || phase.kind === 'failed') && (
        <p role="alert" className="mb-4 flex items-start gap-2 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-attention" />
          {phase.message}
        </p>
      )}
      {phase.kind === 'paused' && (
        <p className="mb-4 text-sm text-muted">Paused. Continue whenever you’re ready.</p>
      )}

      <ul className="space-y-4" aria-live="polite">
        <Row
          label="People"
          step="people"
          current={progress?.step}
          done={progress?.people.done}
          total={progress?.people.total}
        />
        <Row
          label="Channels and conversations"
          step="conversations"
          current={progress?.step}
          done={progress?.conversations.done}
          total={progress?.conversations.total}
        />
        <Row
          label="Messages"
          step="messages"
          current={progress?.step}
          done={progress?.messages.done}
          total={progress?.messages.total}
          note={
            progress && progress.messages.skipped
              ? `${number.format(progress.messages.skipped)} skipped (already imported, or Slack housekeeping)`
              : undefined
          }
        />
        {options.includeFiles && (
          <Row
            label="Files"
            step="files"
            current={progress?.step}
            done={progress?.files.done}
            total={progress?.files.total}
            note={
              progress?.files.failed ? `${progress.files.failed} no longer available from Slack` : undefined
            }
          />
        )}
      </ul>

      <div className="mt-6 flex flex-wrap gap-2">
        {phase.kind === 'running' ? (
          <Button variant="ghost" onClick={() => abort.current?.abort()}>
            Pause
          </Button>
        ) : phase.kind === 'finished' ? (
          <Button
            variant="ghost"
            onClick={() => {
              setLoaded(null);
              setPhase({ kind: 'pick' });
            }}
          >
            Import another export
          </Button>
        ) : (
          <Button onClick={() => void start()}>Continue import</Button>
        )}
      </div>
    </Card>
  );
}

const ORDER = ['people', 'conversations', 'messages', 'files', 'finishing'];

function Row({
  label,
  step,
  current,
  done = 0,
  total = 0,
  note,
}: {
  label: string;
  step: string;
  current: string | undefined;
  done?: number | undefined;
  total?: number | undefined;
  note?: string | undefined;
}) {
  const pct = total
    ? Math.round((done / total) * 100)
    : current && ORDER.indexOf(current) > ORDER.indexOf(step)
      ? 100
      : 0;
  const active = current === step;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className={cn(active ? 'font-medium text-ink' : 'text-muted')}>{label}</span>
        <span className="text-meta tabular-nums">
          {number.format(done)} / {number.format(total)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mt-1.5 h-2 overflow-hidden rounded-pill bg-active"
      >
        <div
          className="h-full rounded-pill bg-action transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      {note && <p className="mt-1 text-xs text-meta">{note}</p>}
    </li>
  );
}

function Option({
  checked,
  onChange,
  title,
  text,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  text: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-action)]"
      />
      <span>
        <span className="block text-[15px]">{title}</span>
        <span className="block text-sm text-meta">{text}</span>
      </span>
    </label>
  );
}
