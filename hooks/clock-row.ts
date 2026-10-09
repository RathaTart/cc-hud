import type { ClientSurface, Color, RenderElement } from 'claude-code'

// The clock row's text, drawn by a `Client` that counts the seconds on the surface's own frame clock.
// The hooks module redraws its tree (the icon and the Buttons beside this text) only when the state
// changes, so a Button under the pointer is not redrawn every second and keeps its hover.

export const TTL_MS = 60 * 60 * 1000
const WARN_LEFT_MS = 5 * 60 * 1000
/** Frame-clock ticks between checks against the hooks module's time, in case the surface's clock drifted or paused. */
export const SYNC_TICKS = 60
/** How far the Client's count may be off before the hooks module hands it the time again. */
export const SYNC_SLACK_MS = 2000

/** The `State` fields the row reads; a `Client`'s props carry them as plain data. */
export type ClockInput = {
  lastRequestAt: number
  compacted: boolean
  deadline: number
  every: number
  always: boolean
  forSession?: boolean
  pinging: boolean
  stopped: string | null
  held: boolean
  last: { at: number; read: number; usd: number | null } | null
}

export type CacheState = 'warm' | 'cold' | 'unknown'
export type ClockLine = { state: CacheState; time: string; isLow: boolean; keepwarm: string }
/** What the hooks module hands the `Client`: the state at `at`, its time, and the colors (null under NO_COLOR). */
export type ClockProps = { at: number; s: ClockInput; colors: { warm: Color | null; cold: Color | null; low: Color | null } }
type Local = { base: number; ticks: number }

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

/** A countdown as the clock row shows it: m:ss under an hour, h:mm:ss above, rounded up so the last second reads 0:01. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

export function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

export function isCold(s: Pick<ClockInput, 'lastRequestAt' | 'compacted'>, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

export function cacheState(s: Pick<ClockInput, 'lastRequestAt' | 'compacted'>, now: number): CacheState {
  return !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
}

function lastPingText(s: ClockInput, now: number): string {
  if (!s.last) return ''
  const when = now - s.last.at < 60 * 1000 ? 'just now' : `${fmtDuration(now - s.last.at)} ago`
  return ` · last ping ${when} read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}`
}

/** The keepwarm half of the clock row; the next ping is the one `arm` schedules, at the last request plus the period. */
function keepwarmText(s: ClockInput, now: number, state: CacheState): string {
  const last = lastPingText(s, now)
  if (s.pinging) return `keepwarm pinging now${last}`
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return `keepwarm off${s.always ? ' (always: arms at the next session start)' : ''}${last}`
  const window = s.forSession ? 'for this session' : `window ${fmtDuration(s.deadline - now)}`
  // ping() finds the cache cold at one TTL and sends nothing, so a period that long never pings.
  const outlasts = `keepwarm on, its ${fmtDuration(s.every)} period outlasts the cache · ${window}${last}`
  if (state === 'unknown') return `keepwarm on · waiting for the first turn${s.compacted ? ' after compaction' : ''} · ${window}`
  if (state === 'cold') return s.every >= TTL_MS ? outlasts : `keepwarm on · first ping ${fmtDuration(s.every)} after the next turn · ${window}${last}`
  if (s.held) return `keepwarm waits for this turn to finish · ${window}${last}`
  const pingAt = s.lastRequestAt + s.every
  // ping() stops at the deadline before it sends, so a ping due at the deadline is not sent either.
  if (pingAt >= s.deadline) return `keepwarm ends in ${fmtClock(s.deadline - now)}, no ping before then${last}`
  if (s.every >= TTL_MS) return outlasts
  return `keepwarm ping in ${fmtClock(pingAt - now)} · ${window}${last}`
}

/** What the clock row says at `now`: the cache's state, its countdown, and keepwarm's next move. */
export function clockLine(s: ClockInput, now: number): ClockLine {
  const state = cacheState(s, now)
  const left = s.lastRequestAt + TTL_MS - now
  const time = state === 'warm' ? `${fmtClock(left)} left`
    : state === 'cold' ? `expired ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago`
    : s.compacted ? 'reset by compaction' : 'no request yet'
  return { state, time, isLow: state === 'warm' && !s.deadline && left <= WARN_LEFT_MS, keepwarm: keepwarmText(s, now, state) }
}

/** The `Client`: the line at the hooks module's `at` plus the seconds this instance has counted since. */
export default function CacheClock(props: ClockProps, surface: ClientSurface<Local>): RenderElement {
  const { Text } = surface.elements
  const local = surface.state
  if (!local) {
    surface.every(1000, () => {
      const cur = surface.state
      if (!cur) return
      surface.setState({ base: cur.base, ticks: cur.ticks + 1 })
      // The time this instance believes it is: the hooks module answers with fresh props only if that is off.
      if ((cur.ticks + 1) % SYNC_TICKS === 0) surface.post({ at: cur.base + (cur.ticks + 1) * 1000 })
    })
  }
  // New props from the hooks module carry a fresh `at`: count again from there.
  const fresh = !local || local.base !== props.at
  if (fresh) surface.setState({ base: props.at, ticks: 0 })
  const line = clockLine(props.s, props.at + (fresh ? 0 : local.ticks) * 1000)
  const color = (line.state === 'warm' ? props.colors.warm : line.state === 'cold' ? props.colors.cold : null) ?? undefined
  const timeColor = (line.isLow ? props.colors.low : null) ?? color
  return Text({ wrap: 'truncate-end', children: [
    ' cache ',
    Text({ color, bold: true, children: [line.state] }),
    ' ',
    Text({ color: timeColor, bold: true, children: [line.time] }),
    ` · ${line.keepwarm}`,
  ] })
}
