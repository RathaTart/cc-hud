import type { Color, CommandInfo, EngineInterface, Register, RenderElement, RenderSurface, SessionRateLimit } from 'claude-code'
import { statusIcons } from './status-icons'
import { compactVersions, fit, fmtWorking, keepwarmVersions, sessionVersions, usageVersions, type Action, type CacheView, type RowData, type Span } from './row-layout'
import { redactSecrets } from './redact'
import { PARTY_MS, SKIN_GLYPH, skinForTool, SPRITE_HEIGHT, SPRITE_WIDTH, skinOf, spriteSvg, type Skin } from './sprites'
import { burnRate, dayKey, elapsedPercent, fmtPercent, fmtSpan, isOverPace, labelOf, levelColor, liveLimits, runOutIn, sparkline } from './usage'
import { cacheState, clockLine, fmtDuration, fmtTok, fmtUsd, isCold, SYNC_SLACK_MS, TTL_MS, type ClockProps } from './clock-row'

export { clockLine, fmtClock, fmtDuration } from './clock-row'
export type { CacheState, ClockLine } from './clock-row'

const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
/** "on": keepwarm for the rest of this session. Kept under the 24.8 days a host timer can wait. */
const SESSION_WINDOW_MS = 20 * 24 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'
const KEY_FOR_SESSION = 'session'
// The live clock row: on or off per session (`clock:<sid>`), and the default new sessions start with.
const KEY_CLOCK = 'clock'
const KEY_CLOCK_DEFAULT = 'clock-default'
/** Whether the row shows its two detailed lines rather than the one compact line; kept across sessions. */
const KEY_DETAILED = 'detailed'
/** Whether a long turn ends with a chime; on unless /hud chime off. */
const KEY_CHIME = 'chime'
/** The usage alerts already shown, so each window and threshold alerts once. */
const KEY_ALERTS = 'alerts'
/** Each day's peak usage per window, for /hud's history. */
const KEY_HISTORY = 'history'
// The Client that draws the row's text; its module path is read off the source, so it is spelled out where drawn.
const CLOCK_CLIENT = 'cache-clock'

// $ per million tokens, [cache read, 1h cache write, output], list prices September 2026.
// Longer family names first: a model id matches the first row it contains.
const PRICES: Array<[string, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  // The window is "on": it runs until this session ends, not for a set time.
  forSession: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  clockOn: boolean
  // The session the clock choice was read for; kept apart from `sid`, which keepwarm's keys follow as cache-tax does.
  clockSid: string
  pinging: boolean
  // A ping came due mid-turn and stood down; the turn's end re-arms it.
  held: boolean
  // Bumped when the process moves to another conversation, so a ping still out cannot stamp the new one.
  epoch: number
  twinWarned: boolean
  // The one redraw the clock row needs that no state change brings: the cache turning cold, for the icon.
  boundary: { cancel: () => void } | null
  // The compact row's minute redraw, running only while that row is drawn.
  tick: { cancel: () => void } | null
  // The plan's usage windows, as the engine last measured them.
  limits: SessionRateLimit[]
  // The row's two detailed lines (true) or its one compact line (false).
  detailed: boolean
  // The session's cost and when it began, the context fill, and what cache reads saved, in dollars.
  usd: number | undefined
  startedAt: number
  contextPercent: number | undefined
  saved: number
  // The main turn in progress: when it started (0 when none), its tool calls, and the redraw that ticks its timer.
  turnStart: number
  tools: number
  turnTick: { cancel: () => void } | null
  // The tool calls of the turn in progress, or of the last one, and how long that last turn took.
  toolLog: ToolCall[]
  lastTurnMs: number
  // The session's subagents as the agents pane lists them, and the redraw that ticks their clocks while any runs.
  agentRuns: AgentRun[]
  // Every agent id the pane has kept, so one the cap let go is not listed again as new.
  agentSeen: Set<string>
  agentTick: { cancel: () => void } | null
  // The agent whose row is open in the pane, showing its task, its calls and its answer.
  expandedAgent: string | null
  // The main Claude's row: what the person last asked, and the start of its last answer.
  lastPrompt: string
  lastAnswer: string
  // Background tasks in flight and scheduled wake-ups, as the last turn's end reported them.
  background: number
  scheduled: number
  chime: boolean
  alerted: string[]
}

function priceOf(model: string | null): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, read, write, output] of PRICES) if (m.includes(family)) return [read, write, output]
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') s.lastRequestAt = now - e.seconds_since_last_response * 1000
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

/** The cache's own time beside its state in the compact row: time left while warm, time since it lapsed when cold. */
export function cacheTimeText(s: State, now: number): string {
  if (!s.lastRequestAt || s.compacted) return ''
  const left = s.lastRequestAt + TTL_MS - now
  return left > 0 ? ` ${fmtDuration(Math.ceil(left / 60000) * 60000)} left` : ` expired ${fmtDuration(-left)} ago`
}

/** The id of the Tool calls pane cc-hud had before its calls moved into the agents pane. */
const RETIRED_TOOLS_PANE = 'hud-tools'
/** Main-thread tool calls kept for the main Claude's row in the agents pane: the turn's latest. */
const TOOL_LOG_SIZE = 60

/** cc-hud's own command: the usage breakdown, and the chime switch. */
const HUD_COMMAND = 'hud'
/** Usage at which the row raises a toast, once per window and threshold. */
const ALERT_AT = [80, 95]
/** A main turn at least this long ends with a toast, and a chime when that is on. */
const LONG_TURN_MS = 60 * 1000
const CHIME_ASSET = 'sounds/done.wav'
/** Days of usage history kept. */
const HISTORY_DAYS = 14

/** cc-hud's agents pane: each subagent of the session, dressed for its task. */
const AGENTS_PANE = 'hud-agents'
/** Agents kept for the pane: the session's latest. */
const AGENT_LOG_SIZE = 100
/**
 * Rows the desktop pane draws with an animated sprite: Claude (main), then running agents, then the newest. The rest
 * show their costume's emoji, so a workflow's dozens of agents do not send the pane a tree too large to draw.
 */
const SPRITE_ROWS = 12

/** The subagent states the row counts as running. */
const ACTIVE_AGENT: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])

/** Once a minute the compact row is drawn again, so its minute countdowns move (the live clock ticks on its own). */
const COMPACT_TICK_MS = 60 * 1000

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${s.forSession ? 'on for this session' : `${fmtDuration(s.deadline - now)} left`}${nextText}${pingText}`
}

/** What the clock row's Client draws from: the state at `now`, and the colors (none under NO_COLOR). */
function clockProps(s: State, now: number, light: boolean, noColor: boolean): ClockProps {
  return {
    at: now,
    s: {
      lastRequestAt: s.lastRequestAt, compacted: s.compacted, deadline: s.deadline, every: s.every, always: s.always, forSession: s.forSession,
      pinging: s.pinging, stopped: s.stopped, held: s.held, last: s.last && { at: s.last.at, read: s.last.read, usd: s.last.usd },
    },
    colors: noColor ? { warm: null, cold: null, low: null } : { warm: 'success', cold: light ? '#c15f3c' : '#d97757', low: 'warning' },
  }
}

/** The Client counts the seconds, so the hooks module redraws only on a state change and when a warm cache turns cold (the icon). */
function scheduleBoundary($: EngineInterface, s: State, now: number) {
  if (s.boundary) s.boundary.cancel()
  s.boundary = null
  if (!s.hasBand || !s.clockOn || cacheState(s, now) !== 'warm') return
  s.boundary = $.clock.after(s.lastRequestAt + TTL_MS - now, () => {
    s.boundary = null
    $.ui.invalidate('ui.render')
  })
}

/** Redraws the clock row now and moves the cold boundary to the new state's. */
function refreshClock($: EngineInterface, s: State, now: number) {
  if (!s.hasBand || !s.clockOn) return
  $.ui.invalidate('ui.render')
  scheduleBoundary($, s, now)
}

/** The surfaces that raise AbovePrompt; VS Code and mobile have no row above the prompt. */
function isBand(surface: RenderSurface | null | undefined): boolean {
  return surface === 'terminal' || surface === 'desktop'
}

/** The theme and NO_COLOR, read once a surface with a row above the prompt is seen. */
async function readLook($: EngineInterface): Promise<{ light: boolean; noColor: boolean }> {
  const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  return { light: typeof theme === 'string' && theme.startsWith('light'), noColor: Boolean(await $.env.get('NO_COLOR')) }
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) {
    $.ui.invalidate('ui.render')
    scheduleBoundary($, s, now)
  } else $.ui.status(statusText(s, now))
}

function clockKey(s: State): string {
  return `${KEY_CLOCK}:${s.clockSid}`
}

/** This session's own choice wins; a session that never chose takes the default, on unless set off. A /clear or a resume changes the session id without a session.start, so this runs on those too. */
async function readClock($: EngineInterface, s: State) {
  s.clockSid = await $.session.id()
  const saved = await $.store.get(clockKey(s))
  s.clockOn = typeof saved === 'boolean' ? saved : (await $.store.get(KEY_CLOCK_DEFAULT)) === true
  syncCompactTick($, s)
}

async function setClock($: EngineInterface, s: State, on: boolean) {
  s.clockOn = on
  await $.store.set(clockKey(s), on)
  syncCompactTick($, s)
  updateStatus($, s, await $.clock.now())
}

/** The compact line's keepwarm part: when the next ping comes, or on/off. */
export function compactKeepwarm(s: State, now: number): string {
  if (s.stopped) return 'keepwarm stopped'
  if (!s.deadline || now >= s.deadline) return 'keepwarm off'
  if (!s.lastRequestAt || s.compacted || isCold(s, now)) return 'keepwarm on'
  return `ping in ${fmtDuration(Math.max(0, s.lastRequestAt + s.every - now))}`
}

async function setDetailed($: EngineInterface, s: State, detailed: boolean) {
  s.detailed = detailed
  await $.store.set(KEY_DETAILED, detailed)
  $.ui.invalidate('ui.render')
}

/** One main-thread tool call as the tools pane lists it. */
type ToolCall = { tool: string; detail: string; startedAt: number; ms?: number; status: 'running' | 'ok' | 'error' | 'denied' }

const RESERVED_TOOL_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

/** What a call acted on, in a few words: the command, the file, the pattern, the URL, the task. */
export function toolDetail(e: Record<string, unknown>): string {
  const first = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt', 'path']
    .map(k => e[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const any = first ?? Object.entries(e).find(([k, v]) => !RESERVED_TOOL_KEYS.has(k) && typeof v === 'string' && v.trim() !== '')?.[1]
  return typeof any === 'string' ? redactSecrets(any.replace(/\s+/g, ' ').trim()) : ''
}

export function fmtCallTime(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60 * 1000 ? `${(ms / 1000).toFixed(1)}s` : fmtWorking(ms)
}

/** Opens the agents pane with every row folded, or closes it; the tools count and the agent count both open it. */
async function toggleAgentsPane($: EngineInterface, s: State): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === AGENTS_PANE)) {
    await $.ui.close({ id: AGENTS_PANE })
    return false
  }
  // Folded before it opens, so its first drawing has no row left open from last time.
  s.expandedAgent = null
  $.ui.invalidate('ui.render')
  await $.ui.open({ id: AGENTS_PANE, title: 'Agents' })
  return true
}


/** One subagent as the agents pane lists it: its task, what it ran on, what it has cost, and how it ended. */
type AgentRun = {
  id: string; task: string; type: string; model: string; skin: Skin
  startedAt: number; endedAt?: number; status: 'running' | 'done' | 'failed'; tokens: number; usd: number | null
  // Running but waiting on something (a permission, another agent): the pane draws it asleep.
  isWaiting?: boolean
  // For the expanded view: the instructions it was given, its latest tool calls, and the start of its answer.
  prompt: string
  calls: ToolCall[]
  answer?: string
}

/** Tool calls kept per agent for its expanded view. */
const AGENT_CALLS_SIZE = 8
/** How much of an agent's instructions and answer the expanded view shows. */
const PROMPT_CHARS = 280
const ANSWER_CHARS = 4000
/** A tool call's detail in an agent's row, kept to one line. */
const CALL_DETAIL_CHARS = 72

/** An answer for the pane's markdown: secrets hidden, cut at the last whole line within ANSWER_CHARS. */
export function answerMarkdown(answer: string): string {
  const text = redactSecrets(answer.trim())
  if (text.length <= ANSWER_CHARS) return text
  const cut = text.lastIndexOf('\n', ANSWER_CHARS)
  return `${text.slice(0, cut > 0 ? cut : ANSWER_CHARS)}\n\n…`
}

const clip = (text: string, max: number) => {
  const flat = redactSecrets(text.replace(/\s+/g, ' ').trim())
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A model id as people say it: claude-haiku-5-5 is Haiku 5.5. */
export function modelName(id: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return id.replace(/^claude-/, '') || 'model'
  const family = m[1]!
  return `${family[0]!.toUpperCase()}${family.slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/** A subagent's turn usage in tokens and dollars: uncached input at the base rate (half the 1h write), writes, reads and output. */
function turnCost(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, model: string | null): { tokens: number; usd: number | null } {
  const tokens = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const price = priceOf(model)
  if (!price) return { tokens, usd: null }
  const [read, write, output] = price
  return { tokens, usd: (u.input_tokens * write / 2 + u.cache_creation_input_tokens * write + u.cache_read_input_tokens * read + u.output_tokens * output) / 1e6 }
}

export function fmtClockTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Whether the agents pane still has something moving: an agent running, or one still in its party hat. */
function isAgentPaneLive(s: State, now: number): boolean {
  return s.agentRuns.some(a => a.status === 'running' || (a.status === 'done' && a.endedAt !== undefined && now - a.endedAt < PARTY_MS))
}

/** Keeps the agents pane's clocks moving once a second while it has something moving, and stops when it has not. */
function syncAgentTick($: EngineInterface, s: State, now: number) {
  const isRunning = isAgentPaneLive(s, now)
  if (isRunning && !s.agentTick) {
    s.agentTick = $.clock.every(1000, () => {
      void $.clock.now().then(at => {
        if (!isAgentPaneLive(s, at)) {
          s.agentTick?.cancel()
          s.agentTick = null
        }
        $.ui.invalidate('ui.render')
      })
    })
  } else if (!isRunning && s.agentTick) {
    s.agentTick.cancel()
    s.agentTick = null
  }
}

/** Takes the usage figures the engine reports, at session start and at each measurement. */
function readUsage(s: State, u: { rateLimits: readonly SessionRateLimit[]; context: { percent?: number }; cost?: { usd: number } }) {
  s.limits = [...u.rateLimits]
  s.contextPercent = u.context.percent
  if (u.cost) s.usd = u.cost.usd
}

/** A toast the first time a window passes 80% and again at 95%, with when it resets and, at this pace, runs out. */
async function checkAlerts($: EngineInterface, s: State, now: number) {
  for (const l of liveLimits(s.limits, now)) {
    const crossed = ALERT_AT.filter(t => l.percentUsed >= t)
    const keys = crossed.map(t => `${l.kind}:${l.resetsAt ?? ''}:${t}`)
    if (!keys.length || keys.every(k => s.alerted.includes(k))) continue
    s.alerted = [...s.alerted.filter(k => !keys.includes(k)), ...keys].slice(-40)
    await $.store.set(KEY_ALERTS, s.alerted)
    const reset = l.resetsAt ? `, resets in ${fmtSpan(Date.parse(l.resetsAt) - now)}` : ''
    const out = runOutIn(l, now)
    $.ui.toast(`${labelOf(l.kind)} limit at ${fmtPercent(l.percentUsed)}${reset}${out !== undefined ? `; at this pace it runs out in ${fmtSpan(out)}` : ''}`)
  }
}

type History = Record<string, Record<string, number>>

/** Keeps each day's peak per window, for HISTORY_DAYS days; writes only when a peak rises. */
async function recordHistory($: EngineInterface, s: State, now: number) {
  const saved = await $.store.get(KEY_HISTORY)
  const history: History = saved && typeof saved === 'object' ? { ...(saved as History) } : {}
  const day = dayKey(now)
  const today = { ...(history[day] ?? {}) }
  let isChanged = false
  for (const l of liveLimits(s.limits, now)) {
    if ((today[l.kind] ?? -1) < l.percentUsed) {
      today[l.kind] = l.percentUsed
      isChanged = true
    }
  }
  if (!isChanged) return
  history[day] = today
  const days = Object.keys(history).sort().slice(-HISTORY_DAYS)
  await $.store.set(KEY_HISTORY, Object.fromEntries(days.map(d => [d, history[d]!])))
}

/** What /hud prints: each window in full, the last week's peaks, cost, cache savings, context, agents and background work. */
export function hudText(s: State, now: number, history: History, agents: number): string {
  const lines: string[] = []
  const limits = liveLimits(s.limits, now)
  if (!limits.length) lines.push('Plan limits: not reported for this account (Pro and Max plans get them).')
  for (const l of limits) {
    const parts = [`${fmtPercent(l.percentUsed)} used`]
    if (l.resetsAt) parts.push(`resets in ${fmtSpan(Date.parse(l.resetsAt) - now)}`)
    const elapsed = elapsedPercent(l, now)
    if (elapsed !== undefined) parts.push(`${fmtPercent(elapsed)} of the window gone, ${isOverPace(l, now) ? 'ahead of pace' : 'on pace'}`)
    const out = runOutIn(l, now)
    if (out !== undefined) parts.push(`runs out in ~${fmtSpan(out)} at this pace`)
    lines.push(`${labelOf(l.kind).padEnd(8)} ${parts.join(' · ')}`)
  }
  const days = Object.keys(history).sort().slice(-7)
  if (days.length) {
    const peaks = (kind: string) => days.map(d => history[d]?.[kind] ?? 0)
    lines.push(`History  last ${days.length} days, daily peak: Session ${sparkline(peaks('five_hour'))} · Week ${sparkline(peaks('seven_day'))}`)
  }
  if (s.usd !== undefined) {
    const rate = burnRate(s.usd, s.startedAt, now)
    lines.push(`Cost     ${fmtUsd(s.usd)} this session${rate !== undefined ? ` · ${fmtUsd(rate)}/h` : ''} (API-price estimate)`)
  }
  lines.push(`Cache    reads saved about ${fmtUsd(s.saved)} this session against sending the same input uncached`)
  if (s.contextPercent !== undefined) lines.push(`Context  ${fmtPercent(s.contextPercent)} of the window`)
  lines.push(`Agents   ${agents} running${s.background ? ` · ${s.background} background task${s.background === 1 ? '' : 's'}` : ''}${s.scheduled ? ` · ${s.scheduled} scheduled` : ''}`)
  lines.push(`Chime    ${s.chime ? 'on' : 'off'} after turns of a minute or more (/hud chime ${s.chime ? 'off' : 'on'})`)
  return lines.join('\n')
}

/** Runs the compact row's minute redraw while that row is drawn (a band, the clock off), and stops it otherwise. */
function syncCompactTick($: EngineInterface, s: State) {
  const isWanted = s.hasBand && !s.clockOn
  if (isWanted && !s.tick) s.tick = $.clock.every(COMPACT_TICK_MS, () => $.ui.invalidate('ui.render'))
  else if (!isWanted && s.tick) {
    s.tick.cancel()
    s.tick = null
  }
}

// The mod form of cache-tax beside this fork means two guards and two keepwarm loops. Which of the
// two registered a shared command last is not fixed, so the command handlers look again.
function warnTwin($: EngineInterface, s: State, commands: CommandInfo[]) {
  const twin = commands.find(c => (c.name === 'keepwarm' || c.name === 'cache-tax') && c.plugin && c.plugin !== $.plugin.name)
  if (s.twinWarned || !twin) return
  s.twinWarned = true
  $.ui.log(`${twin.plugin} is also loaded and registers /${twin.name}: two guards and two keepwarm loops, and /keepwarm off reaches only one. Disable it (claude plugin disable cache-tax@claude-code-mods) and restart.`)
}

async function lookForTwin($: EngineInterface, s: State) {
  if (!s.twinWarned) warnTwin($, s, await $.command.list())
}

function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.held = false
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function forSessionKey(s: State): string {
  return `${KEY_FOR_SESSION}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
    await $.store.delete(KEY_FOR_SESSION + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.forSession = false
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  await $.store.delete(forSessionKey(s))
  if (forgetAlways) {
    s.always = false
    await $.store.delete(KEY_ALWAYS)
  }
  updateStatus($, s, await $.clock.now())
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  if (!s.deadline) {
    // Nothing to schedule, but a turn, a compaction or a resume still moves the clock row.
    if (s.hasBand && s.clockOn) refreshClock($, s, await $.clock.now())
    return
  }
  const now = await $.clock.now()
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
    s.pending = $.clock.after(delay, () => { void ping($, s) })
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  // A window armed again while a ping is still out (off, then on) must not send a second one: the ping out
  // re-arms from its own readback when it returns.
  if (s.pinging) return
  const now = await $.clock.now()
  if (now >= s.deadline) return arm($, s)
  // A turn in the meantime re-armed the timer; this callback is stale.
  if (isCold(s, now)) return arm($, s)
  if (now - s.lastRequestAt < s.every - 1000) {
    // Only turn.step moves the last request without re-arming: the turn is still open, and its turn.complete re-arms.
    s.held = true
    return refreshClock($, s, now)
  }
  let reply
  // The clock row says "pinging now" while the fork is out, then resets its countdown from the readback.
  s.pinging = true
  if (s.hasBand) $.ui.invalidate('ui.render')
  const epoch = s.epoch
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    if (s.epoch !== epoch) return arm($, s)
    return stop($, s, `the ping failed, ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    s.pinging = false
  }
  // A /clear or a resume while the fork was out: the readback is the old conversation's, not this one's.
  if (s.epoch !== epoch) return arm($, s)
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    const reason = reply.reason === 'nothing-to-fork' ? 'no conversation to warm yet'
      : reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    return stop($, s, reason)
  }
  const u = reply.usage
  const price = priceOf(s.lastModel)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await arm($, s)
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

/** The rows' keepwarm switch: on keeps the cache warm until this session ends, off stops it (and always). */
async function setKeepwarm($: EngineInterface, s: State, mode: 'on' | 'off') {
  if (mode === 'off') {
    await stop($, s, null, true)
    return $.ui.toast('keepwarm off')
  }
  await startWindow($, s, SESSION_WINDOW_MS, PING_AFTER_MS, true)
  // The row's own text is cut at a narrow width; the toast says what was armed and what a ping costs.
  const each = warmUsd(s)
  const cost = each == null ? 'each ping is a model request' : `each ping reads the cache, about ${fmtUsd(each)} at this context`
  $.ui.toast(`keepwarm on for this session; ${cost}`)
}

async function startWindow($: EngineInterface, s: State, windowMs: number, every: number, forSession = false) {
  const now = await $.clock.now()
  s.forSession = forSession
  if (forSession) await $.store.set(forSessionKey(s), true)
  else await $.store.delete(forSessionKey(s))
  s.every = every
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  s.deadline = now + windowMs
  s.stopped = null
  await $.store.set(deadlineKey(s), s.deadline)
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next session start, which turns it on (always)' : 'off (/keepwarm on keeps it warm for this session)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm (on )?/, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/cache-tax guard warn to only show the price)' : 'warn only (/cache-tax guard refuse to be stopped once)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  lines.push(`clock row   ${s.clockOn ? 'on' : 'off'} in this session (/cache-clock on|off)${s.hasBand ? '' : '; not drawn here, the row shows in the terminal and the desktop app only'}`)
  return lines.join('\n')
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, forSession: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null,
    clockOn: false, clockSid: '', pinging: false, held: false, epoch: 0, twinWarned: false, boundary: null, tick: null, limits: [], detailed: false,
    usd: undefined, startedAt: 0, contextPercent: undefined, saved: 0, turnStart: 0, tools: 0, turnTick: null, toolLog: [], lastTurnMs: 0, agentRuns: [], agentSeen: new Set(), agentTick: null, expandedAgent: null, lastPrompt: '', lastAnswer: '', background: 0, scheduled: 0,
    chime: true, alerted: [],
  }
}

export const register: Register = on => {
  const s = freshState()
  let light = false
  let noColor = false

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    // Only a surface with the row asks for AbovePrompt, and an SDK host such as the desktop app can ask before
    // session.attach says it is there. A render only reads; the Client ticks on its own regardless.
    if (!s.hasBand) {
      s.hasBand = true
      ;({ light, noColor } = await readLook($))
    }
    const now = await $.clock.now()
    // The row always shows: the live clock, or with the clock off cache-tax's own row with an on/off keepwarm toggle,
    // kept while keepwarm is off so the toggle can turn it back on.
    const isArmed = !!s.deadline && now < s.deadline
    const text = s.stopped || isArmed ? statusText(s, now) ?? 'keepwarm off' : 'keepwarm off'
    const state = s.clockOn ? cacheState(s, now) : s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
    const color = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
    const icon = noColor ? Text({ bold: true, children: ['[>]'] })
      : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
      : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 18, height: 18, alt: 'Cache Tax' })
      : Text({ color, bold: true, children: ['[>]'] })
    if (s.clockOn) {
      const props = clockProps(s, now, light, noColor)
      // The text ticks in a Client, so this tree, and a Button under the pointer, is drawn again only on a change.
      const line = 'Client' in ui
        ? ui.Client({ key: CLOCK_CLIENT, module: './clock-row.ts', props, width: '100%' })
        : Text({ wrap: 'truncate-end', children: [` cache ${clockLine(props.s, now).state}`] })
      // on, off: the one in force drawn as the surface marks a selected button; pressing it changes nothing.
      const mode = s.deadline ? 'on' : 'off'
      const option = (key: 'on' | 'off', label: string) => mode === key
        ? Button({ key: `cache-keepwarm-${key}`, label, variant: 'primary', onPress: () => {} })
        : Button({ key: `cache-keepwarm-${key}`, label, plain: true, dimColor: true, onPress: () => { void setKeepwarm($, s, key) } })
      return Box({ flexDirection: 'column', children: [
        rest,
        Box({ key: 'cache-clock-row', flexDirection: 'row', alignItems: 'center', children: [
          Box({ flexShrink: 0, children: [icon] }),
          Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', children: [line] }),
          Box({ key: 'cache-clock-controls', flexShrink: 0, flexDirection: 'row', alignItems: 'center', columnGap: 1, children: [
            option('on', 'on'),
            option('off', 'off'),
            Box({ marginLeft: 1, children: [
              Button({ key: 'cache-clock-hide', label: 'hide', plain: true, dimColor: true, onPress: () => { void setClock($, s, false) } }),
            ] }),
          ] }),
        ] }),
      ] })
    }
    // on, off: as /keepwarm on (until this session ends) and /keepwarm off. Pressing the one already in force
    // changes nothing, so on never clears an always that armed this window.
    const toggle = (key: 'on' | 'off', label: string) => (key === 'on') === isArmed
      ? Button({ key: `cache-toggle-${key}`, label, variant: 'primary', onPress: () => {} })
      : Button({ key: `cache-toggle-${key}`, label, plain: true, dimColor: true, onPress: () => { void setKeepwarm($, s, key) } })
    // The width the row's text has: the band less the icon, the buttons and their margin.
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 120
    const isNarrow = columns < 60
    const textColumns = (buttons: number) => columns - 4 - buttons - 2
    const detailLabel = s.detailed ? (isNarrow ? 'less' : 'show less') : (isNarrow ? 'details' : 'show details')
    const detailButton = Button({
      key: 'cache-detail-toggle', label: detailLabel, plain: true, dimColor: true,
      onPress: () => { void setDetailed($, s, !s.detailed) },
    })
    // Agents at work: the main Claude while it runs a turn, and each subagent started, running, or waiting on something.
    const agents = (await $.agent.list()).filter(a => ACTIVE_AGENT.has(a.status)).length + (s.turnStart ? 1 : 0)
    const cache = cacheState(s, now)
    const cacheColor = noColor ? undefined : cache === 'warm' ? 'success' : cache === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const toneColor = (span: Span): Color | undefined => noColor ? undefined
      : span.tone === 'warm' || span.tone === 'cold' ? cacheColor ?? color
      : span.tone === 'level' ? levelColor(span.level ?? 0)
      : span.tone === 'error' ? 'error'
      : span.tone === 'warning' ? 'warning'
      : span.tone === 'accent' ? 'suggestion'
      : undefined
    const draw = (spans: Span[]) => spans.map(span => Text({ color: toneColor(span), dimColor: span.tone === 'dim', bold: span.bold, children: [span.text] }))
    // A pressed span runs a command, or opens one of cc-hud's panes. A command runs once the session is idle, so
    // pressed mid-turn it waits for the turn to end, and a toast says so; a pane opens at once.
    const isWorking = e.props.isWorking
    const actions: Record<Action, { command: string; waits: string } | null> = {
      agents: { command: '', waits: '' },
      compact: { command: 'compact', waits: 'Compacts when this turn finishes' },
      usage: { command: HUD_COMMAND, waits: 'The usage breakdown shows when this turn finishes' },
      cache: { command: 'cache-tax', waits: 'The cache card shows when this turn finishes' },
      // The tools pane is cc-hud's own, opened at once rather than by a command, so it shows mid-turn.
      tools: { command: '', waits: '' },
    }
    const button = (action: Action, label: string) => {
      const run = actions[action]!
      return Button({
        key: action === 'usage' ? `cache-usage-${label}` : `cache-${action}`, label, plain: true, dimColor: !(action === 'agents' && agents > 0),
        onPress: () => {
          if (action === 'tools' || action === 'agents') return void toggleAgentsPane($, s)
          if (isWorking) $.ui.toast(run.waits)
          void $.command.run({ command: run.command, args: '' })
        },
      })
    }
    // A line's spans as text, with each run of spans that share an available action drawn as one button.
    const line = (spans: Span[]): RenderElement[] => {
      const lead = Text({ children: [' '] })
      if (!spans.some(span => span.action && actions[span.action])) return [Text({ wrap: 'truncate-end', children: [lead, ...draw(spans)] })]
      const parts: RenderElement[] = [Box({ flexShrink: 0, children: [lead] })]
      for (let i = 0; i < spans.length;) {
        const action = spans[i]!.action
        let j = i + 1
        if (action && actions[action]) {
          while (j < spans.length && spans[j]!.action === action) j++
          parts.push(Box({ flexShrink: 0, children: [button(action, spans.slice(i, j).map(span => span.text).join(''))] }))
        } else {
          while (j < spans.length && !(spans[j]!.action && actions[spans[j]!.action!])) j++
          parts.push(Box({ flexShrink: 1, minWidth: 0, overflow: 'hidden', children: [Text({ wrap: 'truncate-end', children: draw(spans.slice(i, j)) })] }))
        }
        i = j
      }
      return [Box({ flexDirection: 'row', alignItems: 'center', minWidth: 0, children: parts })]
    }
    const row = (key: string, spans: Span[], right: RenderElement[], withIcon: boolean) => Box({ key, flexDirection: 'row', alignItems: 'center', children: [
      Box({ flexShrink: 0, width: 3, children: withIcon ? [icon] : [] }),
      Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', children: line(spans) }),
      Box({ flexShrink: 0, flexDirection: 'row', alignItems: 'center', columnGap: 1, marginLeft: 1, children: right }),
    ] })

    const time = cacheTimeText(s, now).trim()
    const data: RowData = {
      cache: { state: cache, full: time, short: time.replace(/ left$/, '').replace(/^expired (.*) ago$/, '$1 ago') },
      keepwarm: compactKeepwarm(s, now),
      ...(s.turnStart ? { working: { ms: now - s.turnStart, tools: s.tools } } : {}),
      limits: s.limits, agents, now, contextPercent: s.contextPercent, background: s.background, scheduled: s.scheduled,
    }

    // Compact: one line, as much as fits: the cache, the turn or keepwarm, the plan's windows, the agents, warnings.
    if (!s.detailed) {
      return Box({ flexDirection: 'column', children: [rest, row('cache-tax-compact', fit(compactVersions(data), textColumns(detailLabel.length)), [detailButton], true)] })
    }

    // Detailed: the cache with the keepwarm switch; the plan's windows, agents and background work; the turn, cost and context.
    const stateSpan: Span = { text: state, tone: state === 'warm' ? 'warm' : state === 'cold' ? 'cold' : 'plain', bold: true }
    const timeSpan: Span | null = state === 'warm' || state === 'cold' ? { text: cacheTimeText(s, now), tone: stateSpan.tone } : null
    const saved = s.saved >= 0.01 ? `saved ${fmtUsd(s.saved)}` : null
    const rate = s.usd === undefined ? undefined : burnRate(s.usd, s.startedAt, now)
    const sessionLine = fit(sessionVersions(data, s.usd === undefined ? null : `${fmtUsd(s.usd)} this session`, rate === undefined ? null : `${fmtUsd(rate)}/h`), textColumns(detailLabel.length))
    return Box({ flexDirection: 'column', children: [
      rest,
      Box({ key: 'cache-tax-row', flexDirection: 'row', alignItems: 'center', children: [
        Box({ flexShrink: 0, width: 3, children: [icon] }),
        Box({ key: 'cache-tax-line', flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', children: line(fit(keepwarmVersions(stateSpan, timeSpan, text, saved), textColumns(8))) }),
        Box({ key: 'cache-toggle', flexShrink: 0, flexDirection: 'row', alignItems: 'center', columnGap: 1, marginLeft: 1, children: [
          toggle('on', 'on'),
          toggle('off', 'off'),
        ] }),
      ] }),
      // show less sits at the bottom right: the end of the last line, the session's when it has one.
      ...(sessionLine.length
        ? [row('cache-usage-row', fit(usageVersions(data), textColumns(0)), [], false), row('cache-session-row', sessionLine, [detailButton], false)]
        : [row('cache-usage-row', fit(usageVersions(data), textColumns(detailLabel.length)), [detailButton], false)]),
    ] })
  })

  // The agents pane: each subagent of the session, newest first, dressed for its task, with what it cost and how it ended.
  on('ui.render', { component: 'Pane', requestId: AGENTS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const ui = $.ui.resolve(e)
    const now = await $.clock.now()
    // The engine's list settles each status; one this session never saw spawned (before a reload) joins as it stands.
    for (const a of await $.agent.list()) {
      const known = s.agentRuns.find(r => r.id === a.id)
      const status = a.status === 'completed' ? 'done' : a.status === 'failed' || a.status === 'killed' ? 'failed' : 'running'
      if (known) known.isWaiting = a.status === 'waiting'
      if (known && known.status === 'running' && status !== 'running') {
        known.status = status
        known.endedAt ??= now
      } else if (!known && !a.teammateId && !s.agentSeen.has(a.id)) {
        s.agentRuns.push({ id: a.id, task: a.description, type: a.type, model: '', skin: skinOf(a.type, a.description), startedAt: now, status, tokens: 0, usd: null, prompt: '', calls: [] })
        s.agentSeen.add(a.id)
      }
    }
    s.agentRuns = s.agentRuns.slice(-AGENT_LOG_SIZE)
    const runs = [...s.agentRuns].reverse()
    // The main Claude, pinned first: at work while a turn runs, asleep while it waits for the person, dressed for its tool.
    const isWorking = !!s.turnStart
    const mainCall = [...s.toolLog].reverse().find(c => c.status === 'running') ?? (isWorking ? s.toolLog[s.toolLog.length - 1] : undefined)
    const main: AgentRun = {
      id: 'main', task: 'Claude (main)', type: 'main thread', model: s.lastModel ?? '',
      skin: mainCall ? skinForTool(mainCall.tool, mainCall.detail) : 'plain',
      startedAt: s.turnStart || now, status: 'running', isWaiting: !isWorking, tokens: 0, usd: s.usd ?? null,
      prompt: s.lastPrompt, calls: s.toolLog, answer: isWorking ? undefined : s.lastAnswer || undefined,
    }
    const running = runs.filter(r => r.status === 'running').length
    const usd = runs.reduce((n, r) => n + (r.usd ?? 0), 0)
    const tokens = runs.reduce((n, r) => n + r.tokens, 0)
    const mark = { running: ['●', 'suggestion'], done: ['✓', 'success'], failed: ['✗', 'error'] } as const
    // Sprites for Claude (main), then running agents, then the newest; the other rows wear their costume's emoji.
    const withSprite = new Set([main, ...runs.filter(r => r.status === 'running'), ...runs.filter(r => r.status !== 'running')].slice(0, SPRITE_ROWS).map(r => r.id))
    const sprite = (r: AgentRun) => e.surface === 'desktop' && 'Svg' in ui && withSprite.has(r.id)
      ? ui.Svg({
        source: spriteSvg(r.skin, r.status, SPRITE_WIDTH, { isWaiting: r.isWaiting, isParty: r.status === 'done' && r.endedAt !== undefined && now - r.endedAt < PARTY_MS }),
        width: SPRITE_WIDTH, height: SPRITE_HEIGHT, alt: r.skin,
      })
      : Text({ children: [SKIN_GLYPH[r.skin]] })
    return Box({ flexDirection: 'column', rowGap: 1, children: [
      Box({ flexDirection: 'column', children: [
        Text({ bold: true, children: [`Claude ${isWorking ? 'working' : 'idle'} · ${running} running · ${runs.length - running} finished`] }),
        ...(runs.length ? [Text({ dimColor: true, children: [`Subagents ≈${fmtUsd(usd)} · ${fmtTok(tokens)} tokens`] })] : []),
      ] }),
      ...[main, ...runs].flatMap((r, i) => {
        const isMain = r.id === 'main'
        const [glyph, tone] = isMain && !isWorking ? ['○', 'subtle'] as const : mark[r.status]
        const time = fmtClockTime((r.endedAt ?? now) - r.startedAt)
        const isOpen = s.expandedAgent === r.id
        const callMark = { running: ['●', 'suggestion'], ok: ['✓', 'success'], error: ['✗', 'error'], denied: ['⊘', 'warning'] } as const
        const current = [...r.calls].reverse().find(c => c.status === 'running')
        const detail = !isOpen ? [] : [
          ...(r.status === 'running' ? [Text({ wrap: 'truncate-end', children: [
            Text({ color: noColor ? undefined : 'suggestion', bold: true, children: ['Now '] }),
            current ? `${current.tool} · ${current.detail}` : isMain && !isWorking ? 'waiting for you' : r.isWaiting ? 'waiting' : 'thinking',
          ] })] : []),
          ...(r.prompt ? [Text({ children: [Text({ bold: true, children: [isMain ? 'You asked ' : 'Task '] }), Text({ dimColor: true, children: [clip(r.prompt, PROMPT_CHARS)] })] })] : []),
          ...(r.calls.length ? [
            Text({ bold: true, children: [`${isMain ? (isWorking ? 'Tool calls this turn' : 'Tool calls last turn') : 'Tool calls'} (${r.calls.length === (isMain ? TOOL_LOG_SIZE : AGENT_CALLS_SIZE) ? `latest ${r.calls.length}` : r.calls.length})`] }),
            ...r.calls.map(c => {
              const [m, t] = callMark[c.status]
              const took = c.status === 'running' ? fmtCallTime(now - c.startedAt) : fmtCallTime(c.ms ?? 0)
              return Text({ wrap: 'truncate-end', children: [
                Text({ color: noColor ? undefined : t, children: [`${m} `] }), Text({ bold: true, children: [c.tool] }), Text({ dimColor: true, children: [` ${clip(c.detail, CALL_DETAIL_CHARS)} · ${took}`] }),
              ] })
            }),
          ] : []),
          // The answer as the reply drew it, tables and all, as far as a whole line under ANSWER_CHARS goes.
          ...(r.answer ? [
            Text({ bold: true, children: [isMain ? 'Last answer' : 'Result'] }),
            'Markdown' in ui ? ui.Markdown({ text: answerMarkdown(r.answer), dimColor: true }) : Text({ dimColor: true, children: [clip(r.answer, 360)] }),
          ] : []),
        ]
        // The main Claude's third line is its turn and the session's cost; a subagent's, its tokens, cost and time.
        const third = isMain
          ? [isWorking ? `working ${fmtWorking(now - s.turnStart)} · ${s.tools === 1 ? '1 tool' : `${s.tools} tools`}` : `waiting for you${s.lastTurnMs ? ` · last turn ${fmtWorking(s.lastTurnMs)}` : ''}`, r.usd !== null ? `≈${fmtUsd(r.usd)} this session` : '']
          : [`${fmtTok(r.tokens)} tokens`, r.usd !== null ? `≈${fmtUsd(r.usd)}` : '', time]
        const section = i === 1 ? [Box({ key: 'agents-subagents', children: [Text({ dimColor: true, bold: true, children: ['Subagents'] })] })] : []
        return [...section, Box({ key: `agent-${r.id}`, flexDirection: 'row', alignItems: 'flex-start', columnGap: 1, children: [
          Box({ flexShrink: 0, width: e.surface === 'desktop' ? 5 : 3, children: [sprite(r)] }),
          Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: 'column', children: [
            Box({ flexDirection: 'row', children: [
              Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', children: [Button({
                key: `agent-open-${r.id}`, label: `${isOpen ? '▾' : '▸'} ${r.task || r.type}`, plain: true,
                onPress: () => {
                  s.expandedAgent = s.expandedAgent === r.id ? null : r.id
                  $.ui.invalidate('ui.render')
                },
              })] }),
              Box({ flexShrink: 0, marginLeft: 1, children: [Text({ color: noColor ? undefined : tone, children: [glyph] })] }),
            ] }),
            Text({ dimColor: true, wrap: 'truncate-end', children: [[r.type, r.model ? modelName(r.model) : ''].filter(Boolean).join(' · ')] }),
            Text({ dimColor: true, wrap: 'truncate-end', children: [third.filter(Boolean).join(' · ')] }),
            ...(detail.length ? [Box({ key: `agent-${r.id}-detail`, flexDirection: 'column', marginTop: 1, children: detail })] : []),
          ] }),
        ] })]
      }),
    ] })
  })

  on('session.measure', async ($, e, next) => {
    readUsage(s, e)
    const now = await $.clock.now()
    await checkAlerts($, s, now)
    await recordHistory($, s, now)
    if (s.hasBand && !s.clockOn) $.ui.invalidate('ui.render')
    return next(e)
  })

  // Once a minute the Client says what time it believes it is; when a frame clock that paused (a hidden window)
  // left it off, it gets the time again, without this tree, or its Buttons, being drawn again.
  on('ui.message', async ($, e, next) => {
    const r = await next(e)
    if (e.element !== CLOCK_CLIENT) return r
    const now = await $.clock.now()
    const at = (e.data as { at?: unknown } | null)?.at
    if (typeof at === 'number' && Math.abs(now - at) < SYNC_SLACK_MS) return r
    return { props: clockProps(s, now, light, noColor) }
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // An SDK host such as the desktop app starts with no surface; its client attaches later (session.attach below),
    // or already has when this is a reload.
    s.hasBand = isBand(e.surface) || (await $.session.surfaces()).some(isBand)
    if (s.hasBand) {
      ;({ light, noColor } = await readLook($))
      $.ui.status(undefined)
    }
    s.sid = await $.session.id()
    const now = await $.clock.now()
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.forSession = s.deadline > 0 && (await $.store.get(forSessionKey(s))) === true
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    await readClock($, s)
    // A new session starts with keepwarm off. Always is the one opt-in that turns it on at every session start.
    if (s.always) await startWindow($, s, SESSION_WINDOW_MS, PING_AFTER_MS, true)
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    readUsage(s, usage)
    s.startedAt = usage.startedAt
    // cc-hud before 3.10 had a separate Tool calls pane; one left open across the reload has nothing to draw it now.
    // Best effort: a host that answers no pane list has no such pane to close.
    try {
      if ((await $.ui.panes()).some(p => p.id === RETIRED_TOOLS_PANE)) await $.ui.close({ id: RETIRED_TOOLS_PANE })
    } catch {}
    s.detailed = (await $.store.get(KEY_DETAILED)) === true
    s.chime = (await $.store.get(KEY_CHIME)) !== false
    const alerted = await $.store.get(KEY_ALERTS)
    s.alerted = Array.isArray(alerted) ? alerted.filter((k): k is string => typeof k === 'string') : []
    await $.command.register({
      name: HUD_COMMAND,
      description: 'Usage breakdown: each window, pace and forecast, history, cost, cache savings, agents; tools pane; chime on|off (cc-hud)',
      argumentHint: '[agents | tools | chime on | chime off]',
      immediate: true,
    })
    await checkAlerts($, s, now)
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: on for this session, off, a window such as 90m, always, or status (cache-tax)',
      argumentHint: '[6h | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-tax',
      description: 'Prompt cache state, cold price and this session\'s cold writes; guard warn|refuse (cache-tax, the Mod)',
      argumentHint: '[status | guard warn | guard refuse]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-clock',
      description: 'Live cache countdown above the prompt: on or off for this session, or default on|off for new sessions (cc-hud)',
      argumentHint: '[on | off | default on | default off | status]',
      immediate: true,
    })
    // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax:status')) {
      $.ui.log('the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-tax guard warn here.')
    }
    warnTwin($, s, commands)
    updateStatus($, s, now)
    return r
  })

  // The desktop app's client joins after session.start: from then on the row draws there. A draw may already have
  // set hasBand, so the attach still clears a status line pinned before it and schedules the row's cold boundary.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    if (!isBand(e.surface)) return r
    if (!s.hasBand) {
      s.hasBand = true
      ;({ light, noColor } = await readLook($))
    }
    $.ui.status(undefined)
    syncCompactTick($, s)
    updateStatus($, s, await $.clock.now())
    return r
  })

  // With the last terminal or desktop client gone (a phone left watching), keepwarm goes back to the status line.
  on('session.detach', async ($, e, next) => {
    const r = await next(e)
    if (e.reason === 'end' || !isBand(e.surface) || !s.hasBand) return r
    if ((await $.session.surfaces()).some(isBand)) return r
    s.hasBand = false
    syncCompactTick($, s)
    updateStatus($, s, await $.clock.now())
    return r
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    s.epoch++
    await readClock($, s)
    if (e.source === 'clear') {
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      s.sid = await $.session.id()
      updateStatus($, s, await $.clock.now())
      return r
    }
    const line = seedFromResume(s, e, await $.clock.now())
    // The resume payload may omit the model; without it the guard cannot price the cold write.
    if (!s.lastModel) s.lastModel = await $.session.model()
    if (line) $.ui.log(line)
    // The resumed session's clock choice may differ: redraw, and stop the tick when it is off.
    if (s.hasBand) updateStatus($, s, await $.clock.now())
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    await lookForTwin($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and no longer arms itself at session start' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, SESSION_WINDOW_MS, PING_AFTER_MS, true)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session starts with it on; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length || words[0] === 'on') {
      await startWindow($, s, SESSION_WINDOW_MS, PING_AFTER_MS, true)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm on for this session, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written${cold}` }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0] ?? '')
      if (window == null) return { text: 'keepwarm takes on, off, a window such as 6h or 90m, always, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        if (period == null || period < MIN_PING_MS) return { text: 'every takes a period of at least 1m' }
        every = period
      }
      await startWindow($, s, window, every)
      return { text: armedText(s, now, window) }
    }
    return { text: statusText(s, now) ?? 'keepwarm is off' }
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    await lookForTwin($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: '/cache-tax guard takes warn or refuse' }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    return { text: card(s, now) }
  })

  on('command.run', { command: 'cache-clock' }, async ($, e) => {
    await lookForTwin($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const where = s.hasBand ? '' : ' It draws in the terminal and the desktop app; this surface has no row above the prompt.'
    if (words[0] === 'default') {
      if (words[1] !== 'on' && words[1] !== 'off') return { text: '/cache-clock default takes on or off' }
      await $.store.set(KEY_CLOCK_DEFAULT, words[1] === 'on')
      return { text: `new sessions start with the cache clock ${words[1]}; this session stays ${s.clockOn ? 'on' : 'off'} (/cache-clock on|off)` }
    }
    if (words[0] === 'status') {
      const isDefaultOn = (await $.store.get(KEY_CLOCK_DEFAULT)) === true
      return { text: `cache clock ${s.clockOn ? 'on' : 'off'} in this session, ${isDefaultOn ? 'on' : 'off'} by default for new sessions.${where}` }
    }
    const want = words[0] === 'on' ? true : words[0] === 'off' ? false : words.length === 0 ? !s.clockOn : null
    if (want === null) return { text: '/cache-clock takes on, off, default on, default off or status' }
    await setClock($, s, want)
    return { text: `cache clock ${want ? 'on' : 'off'} for this session${want ? '' : '; /cache-clock on brings it back'}.${where}` }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    // The main Claude's row in the agents pane shows what it was last asked.
    s.lastPrompt = e.text
    const now = await $.clock.now()
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    if (s.guard === 'warn') {
      $.ui.log(`${guardText(s, now)} Sending anyway; turn keepwarm on to keep it warm after this.`)
      s.coldWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    return { drop: `cache-tax: ${guardText(s, now)} Send it again to pay it, then turn keepwarm on to keep it warm. Or /clear and start from a note.` }
  })

  on('command.run', { command: HUD_COMMAND }, async ($, e) => {
    const words = String(e.args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words[0] === 'chime') {
      if (words[1] !== 'on' && words[1] !== 'off') return { text: '/hud chime takes on or off' }
      s.chime = words[1] === 'on'
      await $.store.set(KEY_CHIME, s.chime)
      return { text: `chime ${words[1]}: ${s.chime ? 'a turn of a minute or more ends with a chime and a toast' : 'long turns end with a toast alone'}` }
    }
    if (words[0] === 'agents' || words[0] === 'tools') return { text: (await toggleAgentsPane($, s)) ? 'Agents pane opened' : 'Agents pane closed' }
    if (words.length && words[0] !== 'status') return { text: '/hud takes status, agents, tools, chime on or chime off' }
    const now = await $.clock.now()
    readUsage(s, await $.session.usage())
    const saved = await $.store.get(KEY_HISTORY)
    const agents = (await $.agent.list()).filter(a => ACTIVE_AGENT.has(a.status)).length
    return { text: hudText(s, now, saved && typeof saved === 'object' ? saved as History : {}, agents) }
  })

  // The background work still in flight and the wake-ups scheduled, as each turn's end reports them.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    s.background = (e.background_tasks ?? []).filter(t => t.type !== 'subagent').length
    s.scheduled = (e.session_crons ?? []).length
    if (s.hasBand && !s.clockOn) $.ui.invalidate('ui.render')
    return r
  })

  // Main-thread tool calls: counted for the running turn's timer and listed, with how each ended, in the tools pane.
  on('tool.call', async ($, e, next) => {
    // A subagent's call goes on its run, for its expanded row in the agents pane; a main-thread one on the turn's list.
    const run = e.agentId ? s.agentRuns.find(a => a.id === e.agentId) : undefined
    if (e.agentId ? !run : !s.turnStart) return next(e)
    const call: ToolCall = { tool: e.tool, detail: toolDetail(e as unknown as Record<string, unknown>), startedAt: await $.clock.now(), status: 'running' }
    if (run) run.calls = [...run.calls, call].slice(-AGENT_CALLS_SIZE)
    else {
      s.tools++
      s.toolLog = [...s.toolLog, call].slice(-TOOL_LOG_SIZE)
    }
    if (s.hasBand) $.ui.invalidate('ui.render')
    try {
      const r = await next(e)
      call.status = 'deny' in r && r.deny ? 'denied' : 'isError' in r && r.isError ? 'error' : 'ok'
      return r
    } catch (err) {
      call.status = 'error'
      throw err
    } finally {
      call.ms = (await $.clock.now()) - call.startedAt
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && !s.turnStart) {
      // The turn's first model request starts its timer, which ticks each second while the row shows it.
      s.turnStart = await $.clock.now()
      s.tools = 0
      s.toolLog = []
      s.turnTick?.cancel()
      s.turnTick = $.clock.every(1000, () => { if (s.hasBand && !s.clockOn) $.ui.invalidate('ui.render') })
      // The row counts the main Claude from now, and the agents pane dresses it: draw both at once.
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    if (!e.agentId) {
      s.lastRequestAt = await $.clock.now()
      // A turn that starts cold restarts the countdown now, not at the next slow tick.
      refreshClock($, s, s.lastRequestAt)
    }
    yield* next(e)
  })

  // A subagent starting or finishing changes the row's agent count and the agents pane.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if ('agentId' in r && r.agentId) {
      const run: AgentRun = {
        id: r.agentId, task: e.description, type: e.subagentType, model: r.model, skin: skinOf(e.subagentType, `${e.description} ${e.prompt}`),
        startedAt: await $.clock.now(), status: 'running', tokens: 0, usd: null, prompt: e.prompt, calls: [],
      }
      s.agentRuns = [...s.agentRuns.filter(a => a.id !== run.id), run].slice(-AGENT_LOG_SIZE)
      s.agentSeen.add(run.id)
      syncAgentTick($, s, run.startedAt)
    }
    if (s.hasBand) $.ui.invalidate('ui.render')
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    // Every cache read, a subagent's too, is input not sent at the base rate (half the 1h write rate).
    const used = e.usage
    const price = used ? priceOf(used.model ?? s.lastModel) : null
    if (used && price) s.saved += Math.max(0, used.cache_read_input_tokens * (price[1] / 2 - price[0]) / 1e6)
    if (!e.agentId && s.turnStart) {
      const ms = (await $.clock.now()) - s.turnStart
      const tools = s.tools
      s.lastTurnMs = ms
      if ('answer' in e && typeof e.answer === 'string' && e.answer.trim()) s.lastAnswer = e.answer
      s.turnStart = 0
      s.turnTick?.cancel()
      s.turnTick = null
      if (s.hasBand && !s.clockOn) $.ui.invalidate('ui.render')
      if (ms >= LONG_TURN_MS && !e.isAborted) {
        $.ui.toast(`Done in ${fmtWorking(ms)} · ${tools === 1 ? '1 tool' : `${tools} tools`}`)
        if (s.chime) void $.audio.play({ asset: CHIME_ASSET }).catch(() => {})
      }
    }
    if (e.agentId) {
      const run = s.agentRuns.find(a => a.id === e.agentId)
      if (run) {
        if (used) {
          const cost = turnCost(used, used.model ?? run.model)
          run.tokens += cost.tokens
          run.usd = cost.usd === null ? run.usd : (run.usd ?? 0) + cost.usd
        }
        run.status = e.isAborted ? 'failed' : 'done'
        run.isWaiting = false
        if ('answer' in e && typeof e.answer === 'string' && e.answer.trim()) run.answer = e.answer
        run.endedAt = await $.clock.now()
        syncAgentTick($, s, run.endedAt)
      }
      if (s.hasBand) $.ui.invalidate('ui.render')
      return r
    }
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    if (now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.compacted = false
    s.ackedAt = 0
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const write = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + write
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || s.coldWritePending) {
        const price = priceOf(s.lastModel)
        const usd = price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        // keepwarm is never turned on for the person: say what the write cost and how to avoid the next one.
        if (!s.deadline) $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}). Turn keepwarm on (the row's on, or /keepwarm on) so it is not paid again this session.`)
      }
    }
    s.coldWritePending = false
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      s.compacted = true
      s.ctx = 0
      s.ackedAt = 0
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
