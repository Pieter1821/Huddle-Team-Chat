import type { ReactNode } from 'react';
import { useBranding } from '@/lib/queries';

/** The frame every getting-in screen shares: the team's logo and name above one focused card. */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const { data: branding } = useBranding();
  return (
    <main className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <img
          src={branding?.logoUrl ?? '/brand/huddle-logo-dark-h64.png'}
          alt={branding?.name ?? 'Huddle'}
          className="mx-auto mb-8 h-8 w-auto"
        />
        <section className="edge rounded-card px-6 py-8 sm:px-8">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-[15px] leading-relaxed text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
  );
}

/** A form error, announced to screen readers as soon as it appears. */
export function FormError({ message }: { message: string | null }) {
  return (
    <p role="alert" aria-live="assertive" className="min-h-5 text-sm text-attention">
      {message}
    </p>
  );
}
