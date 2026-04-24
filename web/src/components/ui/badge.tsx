import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  muted?: boolean;
};

export function Badge({ className, muted, children, ...props }: BadgeProps) {
  return (
    <span className={cn('badge', muted && 'muted', className)} {...props}>
      {children}
    </span>
  );
}
