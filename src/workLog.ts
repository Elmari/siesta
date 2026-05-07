import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { stampLogPath } from './paths.js';
import type { Presence } from './stamp.js';

interface StampEvent {
  ts: number;
  presence: Presence;
}

export interface WorkSummary {
  totalMs: number;
  /** ts at which the currently-open anwesend interval started, or null if not anwesend now. */
  openSinceTs: number | null;
  /** Number of completed (anwesend → abwesend) pairs today. */
  pairs: number;
  /** ts of the most recent abwesend event today, or null. */
  lastAbwesendTs: number | null;
  /** ts of the very first stamp today, or null. */
  firstTs: number | null;
}

export function appendStamp(presence: Presence, ts = Date.now()): void {
  const p = stampLogPath();
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ ts, presence }) + '\n', 'utf8');
}

export function clearStampLog(): void {
  const p = stampLogPath();
  if (existsSync(p)) unlinkSync(p);
}

function readEvents(): StampEvent[] {
  const p = stampLogPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        const obj = JSON.parse(l);
        if (typeof obj?.ts !== 'number') return null;
        if (obj.presence !== 'anwesend' && obj.presence !== 'abwesend') return null;
        return { ts: obj.ts, presence: obj.presence } as StampEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is StampEvent => e !== null)
    .sort((a, b) => a.ts - b.ts);
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate()
  );
}

export function summarizeToday(now = Date.now()): WorkSummary {
  const events = readEvents().filter((e) => isSameLocalDay(e.ts, now));
  let totalMs = 0;
  let openSinceTs: number | null = null;
  let pairs = 0;
  let lastAbwesendTs: number | null = null;

  for (const ev of events) {
    if (ev.presence === 'anwesend') {
      if (openSinceTs === null) openSinceTs = ev.ts;
    } else {
      if (openSinceTs !== null) {
        totalMs += ev.ts - openSinceTs;
        pairs += 1;
        openSinceTs = null;
      }
      lastAbwesendTs = ev.ts;
    }
  }

  if (openSinceTs !== null) totalMs += now - openSinceTs;

  return {
    totalMs,
    openSinceTs,
    pairs,
    lastAbwesendTs,
    firstTs: events.length > 0 ? events[0].ts : null,
  };
}

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}min`;
  return `${h}h ${m}min`;
}

export function formatHm(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
