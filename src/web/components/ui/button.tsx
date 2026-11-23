import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils';

// shadcn/ui button, restyled to Huddle's brand: every interactive control is a full pill; the primary
// is the accent fill with dark text (kept at 4.5:1 by the server's accent check) and a light inset ring.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill text-sm font-medium transition-[background-color,box-shadow,filter,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-action text-action-ink font-semibold shadow-[inset_0_0_0_2px_rgba(255,251,235,0.25)] hover:brightness-110',
        ghost: 'text-ink shadow-[inset_0_0_0_1px_rgba(255,251,235,0.4)] hover:bg-raised',
        quiet: 'text-muted hover:bg-raised hover:text-ink',
        danger: 'text-attention shadow-[inset_0_0_0_1px_var(--color-attention)] hover:bg-raised',
      },
      size: {
        md: 'h-10 px-5',
        sm: 'h-8 px-3.5 text-[13px]',
        icon: 'size-9 rounded-full',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
