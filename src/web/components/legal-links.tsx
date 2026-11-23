import { cn } from '@/lib/utils';

/** Links to the public privacy policy and terms (plain pages, readable without signing in). */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={cn('flex gap-4 text-[13px] text-meta', className)}>
      <a href="/privacy.html" className="underline-offset-2 hover:text-ink hover:underline">
        Privacy policy
      </a>
      <a href="/terms.html" className="underline-offset-2 hover:text-ink hover:underline">
        Terms of use
      </a>
    </nav>
  );
}
