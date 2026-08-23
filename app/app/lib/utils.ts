import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge Tailwind class names: clsx handles conditionals/arrays, tailwind-merge
 * resolves conflicting Tailwind utilities (last wins). Imported by every shadcn
 * ui component as `@/lib/utils`.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
