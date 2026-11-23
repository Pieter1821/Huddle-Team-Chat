import { useState, type ReactNode } from 'react';
import { AlertDialog } from 'radix-ui';
import { Button } from '@/components/ui/button';

/** A button that asks first, for actions that are hard to undo. */
export function ConfirmButton({
  children,
  title,
  description,
  confirmLabel,
  onConfirm,
  size = 'sm',
  variant = 'quiet',
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  size?: 'sm' | 'md';
  variant?: 'quiet' | 'ghost' | 'danger';
  className?: string;
  'aria-label'?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <Button size={size} variant={variant} className={className} aria-label={ariaLabel}>
          {children}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-ground/70" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-32px)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-card bg-raised p-6 edge">
          <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[15px] text-muted">
            {description}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onConfirm().finally(() => setBusy(false));
                }}
              >
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
