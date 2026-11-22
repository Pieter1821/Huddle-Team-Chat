import * as React from 'react';
import { cn } from '@/lib/utils';

// shadcn/ui input, restyled: a pill on the charcoal ground with the brand's inset edge, bronze on
// hover, accent on focus, coral when invalid (aria-invalid).
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-11 w-full min-w-0 rounded-pill bg-transparent px-4 text-[15px] text-ink placeholder:text-meta',
        'shadow-[inset_0_0_0_1px_var(--color-edge)] outline-none transition-shadow duration-150',
        'hover:shadow-[inset_0_0_0_1px_var(--color-bronze)] focus-visible:shadow-[inset_0_0_0_1px_var(--color-action)]',
        'aria-invalid:shadow-[inset_0_0_0_1px_var(--color-attention)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
