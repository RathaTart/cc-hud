import type { SessionRateLimit } from 'claude-code'

import { fmtPercent, fmtSpan, labelOf, liveLimits, runOutIn, shortReset } from './usage'

// The row's text as plain spans, in versions from fullest to tightest. The row draws the first version
// that fits the width it has, so it stays on one line on any surface instead of wrapping or being cut.

/** How a span is drawn; the row maps each tone to the surface's colors. */
export type Tone = 'plain' | 'dim' | 'warm' | 'cold' | 'level' | 'error' | 'warning' | 'accent'
/** What pressing a span does, where the row can draw it as a button. */
export type Action = 'agents' | 'compact' | 'usage' | 'cache' | 'tools'
export type Span = { text: string; tone: Tone; bold?: boolean; level?: number; action?: Action }

/** The cache part as the row shows it. */
export type CacheView = { state: 'warm' | 'cold' | 'unknown'; full: string; short: string }

/** Everything the row can show, as figures; the versions below decide how much of it fits. */
export type RowData = {
  cache: CacheView
  /** What keepwarm does next, as the compact line says it. */
  keepwarm: string
  /** The main turn in progress: how long it has run and how many tools it called. */
  working?: { ms: number; tools: number }
  limits: readonly SessionRateLimit[]
  agents: number
  now: number
  /** The context fill; the row warns about it from CONTEXT_WARN up. */
  contextPercent?: number
  /** Background shells, monitors and other tasks in flight, and scheduled wake-ups. */
  background: number
  scheduled: number
}

/** The context fill from which the row shows it, with a compact button. */
export const CONTEXT_WARN = 80

export function widthOf(spans: readonly Span[]): number {
  return spans.reduce((n, s) => n + [...s.text].length, 0)
}

/** The first version that fits `columns`, or the tightest when none does. */
export function fit(versions: readonly Span[][], columns: number): Span[] {
  return versions.find(v => widthOf(v) <= columns) ?? versions[versions.length - 1] ?? []
}

const sep: Span = { text: ' · ', tone: 'dim' }

export function fmtWorking(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function cacheSpans(c: CacheView, isShort: boolean): Span[] {
  if (c.state === 'unknown') return [{ text: isShort ? 'idle' : 'no request yet', tone: 'dim' }]
  return [{ text: c.state, tone: c.state, bold: true }, { text: ` ${isShort ? c.short : c.full}`, tone: c.state }]
}

/** The turn in progress, or what keepwarm does next. */
function activitySpans(d: RowData, isShort: boolean): Span[] {
  if (!d.working) return [{ text: d.keepwarm, tone: 'plain' }]
  const tools = d.working.tools === 1 ? '1 tool' : `${d.working.tools} tools`
  return [
    { text: isShort ? fmtWorking(d.working.ms) : `working ${fmtWorking(d.working.ms)}`, tone: 'accent', bold: true },
    ...(isShort ? [] : [{ text: ' · ', tone: 'dim' } as Span, { text: tools, tone: 'dim', action: 'tools' } as Span]),
  ]
}

type Shape = {
  isShortCache: boolean; hasActivity: boolean; isShortActivity: boolean
  isShortLabel: boolean; hasResets: boolean; forecast: 'full' | 'short' | 'none'
  hasContext: boolean; hasBackground: boolean
}

/** Each plan window, then the agents, the context warning and the background work, each led by a separator. */
function usageSpans(d: RowData, o: Shape): Span[] {
  const spans: Span[] = []
  for (const l of liveLimits(d.limits, d.now)) {
    const label = o.isShortLabel ? (l.kind === 'five_hour' ? '5h' : l.kind === 'seven_day' ? '7d' : labelOf(l.kind)) : labelOf(l.kind)
    spans.push(sep, { text: label, tone: 'dim', action: 'usage' }, { text: ' ', tone: 'dim' }, { text: fmtPercent(l.percentUsed), tone: 'level', bold: true, level: l.percentUsed })
    const reset = o.hasResets ? shortReset(l, d.now) : ''
    if (reset) spans.push({ text: ` ${reset}`, tone: 'dim' })
    const out = o.forecast === 'none' ? undefined : runOutIn(l, d.now)
    if (out !== undefined) spans.push({ text: o.forecast === 'full' ? ` ⚠ out in ${fmtSpan(out)}` : ` ⚠${fmtSpan(out)}`, tone: 'warning', bold: true })
  }
  spans.push(sep, ...(d.agents
    ? [{ text: String(d.agents), tone: 'accent', bold: true, action: 'agents' } as Span, { text: d.agents === 1 ? ' agent' : ' agents', tone: 'dim', action: 'agents' } as Span]
    : [{ text: '0 agents', tone: 'dim', action: 'agents' } as Span]))
  if (o.hasContext && d.contextPercent !== undefined && d.contextPercent >= CONTEXT_WARN) {
    spans.push(sep, { text: `ctx ${fmtPercent(d.contextPercent)}`, tone: 'warning', bold: true }, { text: ' ', tone: 'dim' }, { text: 'compact', tone: 'dim', action: 'compact' })
  }
  if (o.hasBackground) {
    if (d.background) spans.push(sep, { text: `${d.background} bg`, tone: 'dim' })
    if (d.scheduled) spans.push(sep, { text: `${d.scheduled} scheduled`, tone: 'dim' })
  }
  return spans
}

// Fullest first; each step gives up a little more. The agent count, the cache and a running turn stay longest.
const SHAPES: readonly Shape[] = [
  { isShortCache: false, hasActivity: true, isShortActivity: false, isShortLabel: false, hasResets: true, forecast: 'full', hasContext: true, hasBackground: false },
  { isShortCache: true, hasActivity: true, isShortActivity: false, isShortLabel: false, hasResets: true, forecast: 'full', hasContext: true, hasBackground: false },
  { isShortCache: true, hasActivity: true, isShortActivity: false, isShortLabel: false, hasResets: true, forecast: 'short', hasContext: true, hasBackground: false },
  { isShortCache: true, hasActivity: true, isShortActivity: false, isShortLabel: false, hasResets: false, forecast: 'short', hasContext: true, hasBackground: false },
  { isShortCache: true, hasActivity: true, isShortActivity: true, isShortLabel: true, hasResets: false, forecast: 'short', hasContext: true, hasBackground: false },
  { isShortCache: true, hasActivity: false, isShortActivity: true, isShortLabel: true, hasResets: false, forecast: 'none', hasContext: false, hasBackground: false },
]

/** The compact line, fullest first: cache, the turn or keepwarm, the plan windows, the agents and any warnings. */
export function compactVersions(d: RowData): Span[][] {
  const versions = SHAPES.map(o => [
    ...cacheSpans(d.cache, o.isShortCache),
    // keepwarm gives way to a running turn, and a running turn stays when keepwarm would have gone.
    ...(o.hasActivity || d.working ? [sep, ...activitySpans(d, o.isShortActivity || !o.hasActivity)] : []),
    ...usageSpans(d, o),
  ])
  const agentsOnly = usageSpans({ ...d, limits: [], contextPercent: undefined }, SHAPES[SHAPES.length - 1]!)
  // The tightest keeps the cache and the agent count, which never drops out; then the cache alone.
  return [...versions, [...cacheSpans(d.cache, true), ...agentsOnly], cacheSpans(d.cache, true)]
}

/** The detailed usage line, fullest first (no leading separator): it also counts the background work. */
export function usageVersions(d: RowData): Span[][] {
  return [
    ...SHAPES.slice(0, 2).map(o => usageSpans(d, { ...o, hasContext: false, hasBackground: true }).slice(1)),
    ...SHAPES.map(o => usageSpans(d, { ...o, hasContext: false }).slice(1)),
  ]
}

/** The detailed keepwarm line, fullest first: `cache ·`, the state and time, then what keepwarm is doing and the savings. */
export function keepwarmVersions(state: Span, time: Span | null, keepwarm: string, saved: string | null): Span[][] {
  // The short form keeps what keepwarm will do next and leaves out how long it lasts and the last ping.
  const brief = keepwarm.replace(' for this session', '').replace(/ · last ping .*$/, '')
  const head = [state, ...(time ? [time] : [])]
  const savedSpans: Span[] = saved ? [sep, { text: saved, tone: 'dim' }] : []
  const label: Span[] = [{ text: 'cache', tone: 'plain', action: 'cache' }, { text: ' · ', tone: 'plain' }]
  return [
    [...label, ...head, sep, { text: keepwarm, tone: 'plain' }, ...savedSpans],
    [...head, sep, { text: keepwarm, tone: 'plain' }, ...savedSpans],
    [...head, sep, { text: keepwarm, tone: 'plain' }],
    [...head, sep, { text: brief, tone: 'plain' }],
    head,
  ]
}

/** The detailed third line, fullest first: the turn in progress, the session's cost and its rate, and the context. */
export function sessionVersions(d: RowData, cost: string | null, rate: string | null): Span[][] {
  const turn: Span[] = d.working ? activitySpans(d, false) : []
  const ctx: Span[] = d.contextPercent === undefined ? [] : [
    { text: `ctx ${fmtPercent(d.contextPercent)}`, tone: d.contextPercent >= CONTEXT_WARN ? 'warning' : 'dim', bold: d.contextPercent >= CONTEXT_WARN },
    ...(d.contextPercent >= CONTEXT_WARN ? [{ text: ' ', tone: 'dim' } as Span, { text: 'compact', tone: 'dim', action: 'compact' } as Span] : []),
  ]
  const costFull: Span[] = cost ? [{ text: cost, tone: 'plain' }, ...(rate ? [{ text: ` · ${rate}`, tone: 'dim' } as Span] : [])] : []
  const costShort: Span[] = cost ? [{ text: cost, tone: 'plain' }] : []
  const join = (...groups: Span[][]) => groups.filter(g => g.length).flatMap((g, i) => (i ? [sep, ...g] : g))
  return [join(turn, costFull, ctx), join(turn, costShort, ctx), join(turn.slice(0, 1), costShort, ctx.slice(0, 1))]
}
