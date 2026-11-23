import type { ReactNode } from 'react';
import { Dialog as Radix } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A modal dialog on the Huddle tokens. Radix handles the hard parts: focus is trapped inside and
 * returned afterwards, Escape closes it, and the rest of the page is hidden from screen readers.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  top = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Pin near the top (for search, so results grow downwards) instead of centring. */
  top?: boolean;
}) {
  return (
    <Radix.Root open={open} onOpenChange={onOpenChange}>
      <Radix.Portal>
        <Radix.Overlay className="fixed inset-0 z-40 bg-ground/70" />
        <Radix.Content
          className={cn(
            'fixed left-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-32px)] max-w-lg -translate-x-1/2 flex-col rounded-card bg-raised edge shadow-2xl focus:outline-none',
            top ? 'top-[10dvh]' : 'top-1/2 -translate-y-1/2',
            className,
          )}
        >
          <div className="flex items-start gap-4 px-6 pt-5">
            <div className="min-w-0 flex-1">
              <Radix.Title className="text-lg font-semibold">{title}</Radix.Title>
              {description ? (
                <Radix.Description className="mt-1 text-sm text-muted">{description}</Radix.Description>
              ) : (
                <Radix.Description className="sr-only">{title}</Radix.Description>
              )}
            </div>
            <Radix.Close
              aria-label="Close"
              className="-mr-2 grid size-8 place-items-center rounded-md text-meta hover:bg-active hover:text-ink"
            >
              <X aria-hidden className="size-4" />
            </Radix.Close>
          </div>
          {children}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
