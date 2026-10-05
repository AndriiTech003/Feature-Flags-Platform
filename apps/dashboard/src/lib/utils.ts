import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const diff = Date.now() - new Date(value).getTime();
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [86400000, 'day'],
    [3600000, 'hour'],
    [60000, 'minute'],
  ];
  for (const [ms, unit] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return diff >= 0 ? `${n} ${unit}${n === 1 ? '' : 's'} ago` : `in ${n} ${unit}${n === 1 ? '' : 's'}`;
    }
  }
  return 'just now';
}

export function percent(weight: number): string {
  const value = weight / 1000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export const VARIATION_COLORS = [
  '#4f46e5',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#06b6d4',
  '#a855f7',
  '#84cc16',
  '#f97316',
];
