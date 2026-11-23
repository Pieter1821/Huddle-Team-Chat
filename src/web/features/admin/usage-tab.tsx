import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/page';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type Meter = { used: number; limit: number; ratio: number };
type Usage = {
  usage: { database: Meter; files: Meter; emailsToday: Meter; importedToday: Meter };
  counts: { files: number; messages: number; activeMembers: number };
  warnings: string[];
};

const number = new Intl.NumberFormat();
const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : `${Math.round(n / 1024)} KB`;

/** How much of Cloudflare's free plan Huddle is using, so nobody is surprised by a limit. */
export function UsageTab() {
  const data = useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/admin/usage') });
  if (!data.data) return <Card title="Usage">{data.isError ? 'Usage didn’t load.' : null}</Card>;
  const { usage, counts, warnings } = data.data;
  return (
    <>
      {warnings.length > 0 && (
        <div role="alert" className="rounded-card bg-attention/10 p-4 ring-1 ring-attention/40">
          {warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 text-sm">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-attention" />
              {w}
            </p>
          ))}
        </div>
      )}
      <Card
        title="Free plan"
        description="Huddle runs in your own Cloudflare account. These are the free plan’s limits."
      >
        <dl className="grid gap-5 sm:grid-cols-2">
          <Bar label="Database" meter={usage.database} format={bytes} />
          <Bar label="File storage" meter={usage.files} format={bytes} />
          <Bar label="Emails sent today" meter={usage.emailsToday} format={(n) => number.format(n)} />
          <Bar label="Messages imported today" meter={usage.importedToday} format={(n) => number.format(n)} />
        </dl>
      </Card>
      <Card title="Totals">
        <dl className="grid grid-cols-3 gap-4">
          {[
            ['Active members', counts.activeMembers],
            ['Messages', counts.messages],
            ['Files', counts.files],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-meta">{label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{number.format(Number(value))}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}

function Bar({ label, meter, format }: { label: string; meter: Meter; format: (n: number) => string }) {
  const pct = Math.min(100, Math.round(meter.ratio * 100));
  const high = meter.ratio >= 0.8;
  return (
    <div>
      <dt className="flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="text-meta tabular-nums">
          {format(meter.used)} of {format(meter.limit)}
        </span>
      </dt>
      <dd className="mt-2">
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${pct}% used`}
          className="h-2 overflow-hidden rounded-pill bg-active"
        >
          <div
            className={cn('h-full rounded-pill', high ? 'bg-attention' : 'bg-action')}
            style={{ width: `${Math.max(pct, 1)}%` }}
          />
        </div>
      </dd>
    </div>
  );
}
