import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { lastStampPath } from './paths.js';
import type { Presence } from './stamp.js';

export interface LastStamp {
  presence: Presence;
  ts: number;
}

export function readLastStamp(): LastStamp | null {
  const p = lastStampPath();
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof data?.ts !== 'number') return null;
    if (data.presence !== 'anwesend' && data.presence !== 'abwesend') return null;
    return { presence: data.presence, ts: data.ts };
  } catch {
    return null;
  }
}

export function writeLastStamp(s: LastStamp): void {
  const p = lastStampPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s), 'utf8');
}

export function clearLastStamp(): void {
  const p = lastStampPath();
  if (existsSync(p)) unlinkSync(p);
}
