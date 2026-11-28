import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, SaveNote } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';
import { useBranding, useMe } from '@/lib/queries';
import type { Branding } from '@/lib/types';
import {
  CHARCOAL,
  DEFAULT_ACCENT,
  MIN_ACCENT_CONTRAST,
  contrastRatio,
  isHexColor,
} from '../../../shared/color';

type Note = { ok: boolean; text: string } | null;
const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'That didn’t save. Try again.');

export function WorkspaceTab() {
  const { data: me } = useMe();
  if (!me?.workspace) return null;
  return (
    <>
      <NameCard current={me.workspace.name} />
      <BrandCard current={me.workspace.accent ?? DEFAULT_ACCENT} />
      <LogoCard />
      <ToggleCard
        field="allowMemberInvites"
        current={me.workspace.allowMemberInvites ?? false}
        title="Inviting people"
        description="Huddle is invite-only. Choose who can send invitations."
        label="Members can invite people"
        hint="Members can invite other members and guests, from Invite people in the sidebar. Only owners can invite admins. Otherwise only owners and admins can invite."
      />
      <ToggleCard
        field="allowMemberGuestInvites"
        current={me.workspace.allowMemberGuestInvites ?? false}
        title="Guests"
        description="Guests are people from outside the team, limited to the channels they’re invited to."
        label="Members can invite guests"
        hint="Otherwise only owners and admins can. Not needed if members can already invite people."
      />
    </>
  );
}

function useRefresh() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['me'] }),
      // Branding is browser-cached for a minute (it's public and read on every visit); 'reload'
      // skips that cache and refreshes it, so the admin sees their change straight away.
      client.fetchQuery({
        queryKey: ['branding'],
        queryFn: () => api<Branding>('/branding', { cache: 'reload' }),
        staleTime: 0,
      }),
    ]);
}

function NameCard({ current }: { current: string }) {
  const refresh = useRefresh();
  const [name, setName] = useState(current);
  const [note, setNote] = useState<Note>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    try {
      await api('/workspace', { method: 'PATCH', json: { name: name.trim() } });
      await refresh();
      setNote({ ok: true, text: 'Saved' });
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
    }
  }
  return (
    <Card title="Name" description="Shown in the sidebar, on the sign-in page and in emails.">
      <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="ws-name" className="sr-only">
            Workspace name
          </Label>
          <Input id="ws-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" disabled={!name.trim() || name.trim() === current}>
          Save
        </Button>
        <SaveNote state={note} />
      </form>
    </Card>
  );
}

function BrandCard({ current }: { current: string }) {
  const refresh = useRefresh();
  const [hex, setHex] = useState(current);
  const [note, setNote] = useState<Note>(null);
  const valid = isHexColor(hex);
  const ratio = valid ? contrastRatio(hex, CHARCOAL) : 0;
  const readable = ratio >= MIN_ACCENT_CONTRAST;

  async function save(value: string | null) {
    setNote(null);
    try {
      await api('/workspace', { method: 'PATCH', json: { accent: value } });
      await refresh();
      if (value === null) setHex(DEFAULT_ACCENT);
      setNote({ ok: true, text: 'Saved' });
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
    }
  }

  return (
    <Card
      title="Brand colour"
      description="Used for buttons, links and highlights. It must stay readable with dark text on it."
    >
      <div className="flex flex-wrap items-center gap-4">
        <label className="relative size-11 shrink-0 cursor-pointer overflow-hidden rounded-full edge">
          <span className="sr-only">Pick a colour</span>
          <input
            type="color"
            value={valid ? hex : DEFAULT_ACCENT}
            onChange={(e) => setHex(e.target.value)}
            className="absolute -inset-2 size-16 cursor-pointer"
          />
        </label>
        <div className="w-36">
          <Label htmlFor="accent-hex" className="sr-only">
            Colour code
          </Label>
          <Input
            id="accent-hex"
            value={hex}
            maxLength={7}
            onChange={(e) => setHex(e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`)}
            aria-invalid={!valid || !readable}
            aria-describedby="accent-check"
            className="font-mono"
          />
        </div>
        <span
          className="rounded-pill px-4 py-2 text-sm font-semibold text-action-ink"
          style={{ background: valid ? hex : DEFAULT_ACCENT }}
          aria-hidden
        >
          Preview button
        </span>
      </div>
      <p id="accent-check" className={readable ? 'mt-3 text-sm text-muted' : 'mt-3 text-sm text-attention'}>
        {!valid
          ? 'Use a colour code like #00b18c.'
          : readable
            ? `Contrast ${ratio.toFixed(1)}:1. Readable.`
            : `Contrast ${ratio.toFixed(1)}:1. Too dark: it needs at least ${MIN_ACCENT_CONTRAST}:1. Try a lighter shade.`}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={!valid || !readable || hex.toLowerCase() === current.toLowerCase()}
          onClick={() => void save(hex)}
        >
          Save colour
        </Button>
        <Button
          variant="ghost"
          disabled={current.toLowerCase() === DEFAULT_ACCENT}
          onClick={() => void save(null)}
        >
          Use Huddle’s default
        </Button>
        <SaveNote state={note} />
      </div>
    </Card>
  );
}

function LogoCard() {
  const refresh = useRefresh();
  const { data: branding } = useBranding();
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setNote(null);
    try {
      if (file.size > 1024 * 1024) throw new ApiError(413, 'too_large', 'Logos can be up to 1 MB.');
      await api('/workspace/logo', {
        method: 'PUT',
        body: file,
        headers: { 'content-type': 'application/octet-stream' },
      });
      await refresh();
      setNote({ ok: true, text: 'Logo updated' });
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Logo"
      description="PNG, JPEG or WebP, up to 1 MB. A wide logo about 64 pixels tall works best."
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid h-16 min-w-32 place-items-center rounded-lg bg-ground px-4 edge">
          <img
            src={branding?.logoUrl ?? '/brand/huddle-logo-dark-h64.png'}
            alt="Current logo"
            className="max-h-10 w-auto"
          />
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
        <Button variant="ghost" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Uploading…' : 'Upload a logo'}
        </Button>
        {branding?.logoUrl && (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() =>
              void api('/workspace/logo', { method: 'DELETE' })
                .then(refresh)
                .then(() => setNote({ ok: true, text: 'Logo removed' }))
                .catch((err: unknown) => setNote({ ok: false, text: errorText(err) }))
            }
          >
            Remove
          </Button>
        )}
        <SaveNote state={note} />
      </div>
    </Card>
  );
}

/** One yes/no workspace setting, saved as soon as it's ticked. */
function ToggleCard({
  field,
  current,
  title,
  description,
  label,
  hint,
}: {
  field: 'allowMemberGuestInvites' | 'allowMemberInvites';
  current: boolean;
  title: string;
  description: string;
  label: string;
  hint: string;
}) {
  const refresh = useRefresh();
  const [on, setOn] = useState(current);
  const [note, setNote] = useState<Note>(null);
  async function toggle(next: boolean) {
    setOn(next);
    setNote(null);
    try {
      await api('/workspace', { method: 'PATCH', json: { [field]: next } });
      await refresh();
      setNote({ ok: true, text: 'Saved' });
    } catch (err) {
      setOn(!next);
      setNote({ ok: false, text: errorText(err) });
    }
  }
  return (
    <Card title={title} description={description}>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-0.5 size-5 shrink-0 accent-[var(--color-action)]"
        />
        <span>
          <span className="block text-[15px]">{label}</span>
          <span className="block text-sm text-meta">{hint}</span>
        </span>
      </label>
      <div className="mt-3">
        <SaveNote state={note} />
      </div>
    </Card>
  );
}
