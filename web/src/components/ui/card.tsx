import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

type DivProps = HTMLAttributes<HTMLDivElement> & { children: ReactNode };

export function Card({ className, children, ...props }: DivProps) {
  return (
    <div className={cn('card', className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }: DivProps) {
  return (
    <div className={cn('card-header', className)} {...props}>
      {children}
    </div>
  );
}

export function CardContent({ className, children, ...props }: DivProps) {
  return (
    <div className={cn('card-content', className)} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...props }: DivProps) {
  return (
    <div className={cn('card-footer', className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: DivProps) {
  return (
    <div className={cn('card-title', className)} {...props}>
      {children}
    </div>
  );
}

export function CardDescription({ className, children, ...props }: DivProps) {
  return (
    <div className={cn('card-description', className)} {...props}>
      {children}
    </div>
  );
}
