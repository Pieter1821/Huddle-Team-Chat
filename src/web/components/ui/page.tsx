import type { ComponentProps, ReactNode } from 'react';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

/** A settings-style page in the main pane: a header bar and a scrolling, centred column. */
export function Page({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-rule px-4">
        <Link
          to="/"
          aria-label="Back to conversations"
          className="-ml-1 rounded-lg p-1 text-muted hover:text-ink md:hidden"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <h1 className="truncate text-[15px] font-semibold">{title}</h1>
        {actions && <div className="ml-auto">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 relative overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">{children}</div>
      </div>
    </div>
  );
}

/** A titled card that groups related settings. */
export function Card({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-card bg-raised p-5 edge sm:p-6', className)}>
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A native select (keyboard and screen-reader behaviour for free), styled like the inputs. */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className={cn('relative block', className)}>
      <select
        {...props}
        className="h-11 w-full appearance-none rounded-pill bg-ground pr-10 pl-4 text-[15px] text-ink shadow-[inset_0_0_0_1px_var(--color-edge)] outline-none hover:shadow-[inset_0_0_0_1px_var(--color-bronze)] focus-visible:shadow-[inset_0_0_0_1px_var(--color-action)] disabled:opacity-50"
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-meta"
      />
    </span>
  );
}

/** A short-lived "Saved" or error note beside a save button, announced to screen readers. */
export function SaveNote({ state }: { state: { ok: boolean; text: string } | null }) {
  return (
    <span role="status" className={cn('text-sm', state?.ok ? 'text-action' : 'text-attention')}>
      {state?.text}
    </span>
  );
}
