import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn-standard className composer (tailwind-merge + clsx). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
