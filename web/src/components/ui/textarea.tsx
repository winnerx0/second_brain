import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, ...props }: TextareaProps) {
  return <textarea className={cn('composer-textarea', className)} {...props} />;
}
