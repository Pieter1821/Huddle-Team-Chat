import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, Page, SaveNote, Select } from '@/components/ui/page';
import { ApiError, api } from '@/lib/api';
import { useMe } from '@/lib/queries';

type Preferences = {
  digest: 'hourly' | 'daily' | 'off';
  digestDelayMin: number;
  timezone: string;
  pausedUntil: string | null;
};
type Note = { ok: boolean; text: string } | null;

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'That didn’t save. Try again.');

/** Your own settings: the name people see, and when Huddle emails you. */
export function SettingsPage() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <Page title="Your settings">
      <ProfileCard name={me.user.name} email={me.user.email} />
      <NotificationsCard />
    </Page>
  );
}

function ProfileCard({ name: current, email }: { name: string; email: string }) {
  const client = useQueryClient();
  const [name, setName] = useState(current);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      await api('/me', { method: 'PATCH', json: { name: name.trim() } });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['me'] }),
        client.invalidateQueries({ queryKey: ['members'] }),
      ]);
      setNote({ ok: true, text: 'Saved' });
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Profile" description="Your name appears next to your messages and in mentions.">
      <form onSubmit={(e) => void save(e)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="profile-name">Name</Label>
          <Input
            id="profile-name"
            autoComplete="name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-email">Email</Label>
          <Input id="profile-email" value={email} readOnly className="text-muted" />
          <p className="text-xs text-meta">
            You sign in with this address. An admin can invite a new one if it changes.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !name.trim() || name.trim() === current}>
            Save
          </Button>
          <SaveNote state={note} />
        </div>
      </form>
    </Card>
  );
}

const PAUSES = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
];
const until = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function NotificationsCard() {
  const client = useQueryClient();
  const prefs = useQuery({
    queryKey: ['preferences'],
    queryFn: async () => (await api<{ preferences: Preferences }>('/me/preferences')).preferences,
  });
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [Intl.DateTimeFormat().resolvedOptions().timeZone];
    }
  }, []);
  const [note, setNote] = useState<Note>(null);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Each control saves on change; the cache updates first so the screen never lags.
  async function update(change: Partial<Preferences>) {
    const before = client.getQueryData<Preferences>(['preferences']);
    if (before) client.setQueryData(['preferences'], { ...before, ...change });
    setNote(null);
    try {
      await api('/me/preferences', { method: 'PATCH', json: change });
      setNote({ ok: true, text: 'Saved' });
    } catch (err) {
      if (before) client.setQueryData(['preferences'], before);
      setNote({ ok: false, text: errorText(err) });
    }
  }

  if (!prefs.data) return <Card title="Email notifications">{null}</Card>;
  const p = prefs.data;
  const paused = p.pausedUntil && new Date(p.pausedUntil) > new Date();

  return (
    <Card
      title="Email notifications"
      description="When you miss mentions or direct messages, Huddle can email you a short summary. Nothing is sent for things you’ve already read."
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="digest">Email summary</Label>
            <Select
              id="digest"
              value={p.digest}
              onChange={(e) => void update({ digest: e.target.value as Preferences['digest'] })}
            >
              <option value="hourly">At most every hour</option>
              <option value="daily">Once a day</option>
              <option value="off">Never</option>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="delay">Wait before emailing</Label>
            <Select
              id="delay"
              value={String(p.digestDelayMin)}
              disabled={p.digest === 'off'}
              onChange={(e) => void update({ digestDelayMin: Number(e.target.value) })}
            >
              {[15, 30, 60, 120, 240].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
                </option>
              ))}
              {![15, 30, 60, 120, 240].includes(p.digestDelayMin) && (
                <option value={p.digestDelayMin}>{p.digestDelayMin} minutes</option>
              )}
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="timezone">Time zone</Label>
          <Select
            id="timezone"
            value={p.timezone}
            onChange={(e) => void update({ timezone: e.target.value })}
          >
            {(zones.includes(p.timezone) ? zones : [p.timezone, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z.replaceAll('_', ' ')}
              </option>
            ))}
          </Select>
          {browserZone !== p.timezone ? (
            <p className="text-xs text-meta">
              This device is set to {browserZone.replaceAll('_', ' ')}.{' '}
              <button
                type="button"
                className="text-action underline-offset-2 hover:underline"
                onClick={() => void update({ timezone: browserZone })}
              >
                Use that
              </button>
            </p>
          ) : (
            <p className="text-xs text-meta">Daily summaries arrive in your morning.</p>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Pause notifications</p>
          {paused ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted">Paused until {until.format(new Date(p.pausedUntil!))}.</p>
              <Button size="sm" variant="ghost" onClick={() => void update({ pausedUntil: null })}>
                Resume now
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {PAUSES.map((pause) => (
                <Button
                  key={pause.label}
                  size="sm"
                  variant="ghost"
                  onClick={() => void update({ pausedUntil: new Date(Date.now() + pause.ms).toISOString() })}
                >
                  {pause.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        <SaveNote state={note} />
      </div>
    </Card>
  );
}
