import type { Color, SessionRateLimit } from 'claude-code'

// The plan's usage windows as the row shows them, from what the engine already has
// ($.session.usage and session.measure): no request of its own, so they cost no tokens.

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** How far ahead of the clock usage may run before the row flags it, in percentage points. */
export const PACE_SLACK = 10

const WINDOWS: Record<string, { label: string; length?: number }> = {
  five_hour: { label: 'Session', length: 5 * HOUR },
  seven_day: { label: 'Week', length: 7 * DAY },
  spend_limit: { label: 'Spend' },
}

export function labelOf(kind: string): string {
  return WINDOWS[kind]?.label ?? kind.replace(/_/g, ' ')
}

/** A duration as the usage figures show it: 32m, 4h50m, 4d 7h. */
export function fmtSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN))
  const d = Math.floor(total / (24 * 60))
  const h = Math.floor((total % (24 * 60)) / 60)
  const m = total % 60
  if (d > 0) return `${d}d ${h}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

export function fmtPercent(p: number): string {
  return `${Math.round(p)}%`
}

/** The share of the window gone by at `now`, 0 to 100; undefined when its length or reset is unknown. */
export function elapsedPercent(limit: SessionRateLimit, now: number): number | undefined {
  const length = WINDOWS[limit.kind]?.length
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!length || Number.isNaN(resetsAt)) return undefined
  return Math.min(100, Math.max(0, 100 * (1 - (resetsAt - now) / length)))
}

/** Whether usage runs more than PACE_SLACK points ahead of the clock: at this rate the window runs out before it resets. */
export function isOverPace(limit: SessionRateLimit, now: number): boolean {
  const elapsed = elapsedPercent(limit, now)
  return elapsed !== undefined && limit.percentUsed > elapsed + PACE_SLACK
}

export function levelColor(p: number): Color {
  return p >= 90 ? 'error' : p >= 75 ? 'warning' : 'suggestion'
}

/** The time to a window's reset after a reset mark: ↻4h50m. */
export function shortReset(limit: SessionRateLimit, now: number): string {
  const at = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  return Number.isNaN(at) ? '' : `↻${fmtSpan(at - now)}`
}

/** Windows in a fixed order (session, week, spend, then any other), only those still running. */
export function liveLimits(limits: readonly SessionRateLimit[], now: number): SessionRateLimit[] {
  const order = Object.keys(WINDOWS)
  const rank = (k: string) => (order.indexOf(k) + order.length + 1) % (order.length + 1)
  return limits
    .filter(l => !l.resetsAt || Number.isNaN(Date.parse(l.resetsAt)) || Date.parse(l.resetsAt) > now)
    .sort((a, b) => rank(a.kind) - rank(b.kind))
}

/** How long until the window runs out at the pace so far, when that comes before its reset; undefined otherwise. */
export function runOutIn(limit: SessionRateLimit, now: number): number | undefined {
  const length = WINDOWS[limit.kind]?.length
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  // Only a window already marked ahead of pace gets a forecast, so the two never disagree.
  if (!length || Number.isNaN(resetsAt) || limit.percentUsed >= 100 || !isOverPace(limit, now)) return undefined
  const elapsed = length - (resetsAt - now)
  // Too early in the window, a pace means nothing: wait for a tenth of it, and at least half an hour.
  if (elapsed < Math.max(30 * MIN, length / 10)) return undefined
  const left = ((100 - limit.percentUsed) / limit.percentUsed) * elapsed
  // Only a run-out that comes well before the reset (a twentieth of the window) is worth a warning.
  return resetsAt - (now + left) >= length / 20 ? left : undefined
}

/** Dollars an hour since `startedAt`; undefined in the first ten minutes, when a rate would mislead. */
export function burnRate(usd: number, startedAt: number, now: number): number | undefined {
  const hours = (now - startedAt) / HOUR
  return now - startedAt < 10 * MIN ? undefined : usd / hours
}

/** A row of block characters, one per value from 0 to 100. */
export function sparkline(values: readonly number[]): string {
  const blocks = '▁▂▃▄▅▆▇█'
  return values.map(v => blocks[Math.min(7, Math.max(0, Math.floor((v / 100) * 8)))] ?? '▁').join('')
}

/** The local calendar day of `now` as YYYY-MM-DD, the key usage history is kept under. */
export function dayKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
