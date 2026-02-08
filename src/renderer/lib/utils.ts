import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

export function middleEllipsis(value: string, keepStart = 20, keepEnd = 20): string {
	if (value.length <= keepStart + keepEnd + 3) return value;
	return `${value.slice(0, keepStart)} ... ${value.slice(-keepEnd)}`;
}
