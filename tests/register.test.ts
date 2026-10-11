import { describe, expect, mock, test, tier, type MockClock, type Mounted, type TestBody } from 'claude-code/testing'
import type { AgentInfo, CommandRunInput, ConfigSetInput, ModelForkResult, On, PromptSubmitInput, RenderPropsOf, SessionRateLimit, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import { statusIcons } from '../hooks/status-icons'
import { outfitsFit, SKIN_GLYPH, skinOf, spriteSvg } from '../hooks/sprites'
import { redactSecrets } from '../hooks/redact'
import { answerMarkdown, clockLine, fmtClock, fmtDuration, freshState, parseDuration, resetForClear, seedFromResume } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1', ...over,
})

// TurnCompleteInput is a union on `reason`; the tests only drive the answered arm.
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})

const run = (command: 'keepwarm' | 'cache-tax' | 'cache-clock' | 'hud', args: string): CommandRunInput => ({
  command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
const themeChange = (value: string): ConfigSetInput => ({ key: 'theme', value, previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })

type ForkAnswer = null | ModelForkResult | { read: number; write: number; out?: number; input?: number }

// The world beneath the mod: its store, the engine's answers, and a fork that
// replies from a script so each test decides what the cache looked like.
// The suite inherited from cache-tax runs with the live clock row off by default
// (`clock: true` turns it on), so cache-tax's own row is still what it checks. It draws the detailed
// two-line row unless a test passes `detailed: false` for the one compact line.
// `sid` can be an object whose value a test changes mid-process, as /clear and an in-process resume do.
function world(on: On, forkAnswers: ForkAnswer[], opts: { store?: Map<string, unknown>; commands?: Array<string | { name: string; plugin?: string }>; live?: { tokens?: number }; sid?: string | { value: string }; model?: string; bandText?: string; theme?: { value: string }; noColor?: boolean; denyTheme?: boolean; writtenTheme?: string; clock?: boolean; detailed?: boolean; limits?: SessionRateLimit[]; ctxPercent?: number; usd?: number; agents?: AgentInfo[]; duringFork?: () => Promise<unknown>; surfaces?: Array<'terminal' | 'desktop' | 'vscode' | 'mobile'> } = {}) {
  if (opts.store) {
    const store = opts.store
    on('store.get', ($, e) => ({ value: store.has(e.key) ? store.get(e.key) : e.key === 'clock-default' ? opts.clock === true : e.key === 'detailed' ? opts.detailed ?? true : undefined }))
    on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
    on('store.delete', ($, e) => { store.delete(e.key); return { value: undefined } })
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else mock.store(on, { 'clock-default': opts.clock === true, detailed: opts.detailed ?? true })
  const reads = { theme: 0, env: 0 }
  on('env.get', ($, e) => { reads.env++; return { value: e.name === 'NO_COLOR' && opts.noColor ? '1' : undefined } })
  on('config.list', () => {
    reads.theme++
    return { value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme?.value ?? 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] }
  })
  on('config.set', ($, e) => opts.denyTheme ? { deny: 'theme locked' } : { value: opts.writtenTheme ?? e.value })
  const forks: number[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const entered: string[] = []
  const renders = { n: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: typeof opts.sid === 'object' ? opts.sid.value : opts.sid ?? 'S1' }))
  // The roster of attached clients: empty unless a test says a client (the desktop app) is already there.
  on('session.surfaces', () => ({ value: opts.surfaces ?? [] }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('session.detach', ($, e) => ({ clientId: e.clientId }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  const sounds: string[] = []
  on('audio.play', ($, e) => { sounds.push(typeof e.clip === 'object' && e.clip && 'asset' in e.clip && typeof e.clip.asset === 'string' ? e.clip.asset : '?'); return { value: undefined } })
  on('classic.Stop', () => ({}))
  on('session.model', () => ({ value: opts.model ?? 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: opts.live?.tokens, percent: opts.ctxPercent }, rateLimits: opts.limits ?? [], ...(opts.usd !== undefined ? { cost: { usd: opts.usd } } : {}) } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.list', () => ({ value: opts.agents ?? [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: (opts.commands ?? []).map(c => ({ description: '', source: 'plugin' as const, ...(typeof c === 'string' ? { name: c } : c) })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => { entered.push(e.text); return { text: e.text } })
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.render', ($, e) => { renders.n++; return $.ui.resolve(e).Text({ children: [opts.bandText ?? ''] }) })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('model.fork', async () => {
    forks.push(forks.length)
    if (opts.duringFork) await opts.duringFork()
    const a = forkAnswers.shift()
    // Older Claude Code releases returned null instead of a failure object.
    if (a === null || a === undefined) return { value: null as unknown as ModelForkResult }
    if ('isAnswered' in a) return { value: a }
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: a.input ?? 2, output_tokens: a.out ?? 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } }
    return { value }
  })
  return { forks, status, logs, entered, reads, renders, toasts, sounds }
}

// One model request of a turn that stays open: a turn.step with no turn.complete after it.
async function step($: { turn: { step: (e: { turnId: string; index: number; model: string; messageCount: number }) => AsyncGenerator<unknown, unknown> } }) {
  for await (const chunk of $.turn.step({ turnId: 'open', index: 0, model: 'claude-fable-5-1', messageCount: 1 })) void chunk
}

const warm: ForkAnswer = { read: 200000, write: 0 }

// The detailed row's first line: the cache, keepwarm and the savings, its `cache` label drawn as a button.
const cacheLine = async (ui: { find(q: { key: string }): Promise<{ text?: string } | undefined> }) => (await ui.find({ key: 'cache-tax-line' }))?.text

const bandProps: RenderPropsOf['AbovePrompt'] = {
  // Wide enough that the row draws its fullest version; the responsive tests pass their own width.
  hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}

describe('cache indicator', () => {
  test('redraws reuse session preferences and theme changes repaint immediately', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cc-hud',surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    await $.config.set(themeChange('light'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.warm.png })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    expect(w.forks.length).toBe(0)
  })

  test('a denied theme change preserves the existing icon', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { denyTheme: true })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cc-hud',surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await $.config.set(themeChange('light'))).deny).toBe('theme locked')
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
  })

  test('the written theme wins over the requested value', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { writtenTheme: 'light' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cc-hud',surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.neutral.png })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: official cube follows state and theme with a text alternative`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const theme = { value: 'dark' }
      const w = world(on, [], { theme })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.command.run(run('keepwarm', '3h every 90m'))
      const ui = await $.ui.mount({ plugin: 'cc-hud',surface, component: 'AbovePrompt', props: bandProps })
      const type = surface === 'terminal' ? 'Image' : 'Svg'
      const source = (variant: typeof statusIcons.dark) => surface === 'terminal' ? { png: variant.neutral.png } : variant.neutral.svg
      expect((await ui.find({ type }))?.props.source).toEqual(source(statusIcons.dark))
      expect((await ui.find({ type }))?.props.alt).toBe(surface === 'terminal' ? '[>]' : 'Cache Tax')
      if (surface === 'terminal') {
        expect((await ui.find({ type }))?.props.columns).toBe(3)
        expect((await ui.find({ type }))?.props.rows).toBe(1)
      }
      await $.turn.complete(turn())
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.dark.warm.png } : statusIcons.dark.warm.svg)
      await $.config.set(themeChange('light'))
      await clock.advance(HOUR)
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.light.cold.png } : statusIcons.light.cold.svg)
      expect((await ui.find({ type: 'Text', text: /^cold$/ }))?.props.color).toBe('#c15f3c')
      expect(w.forks.length).toBe(0)
      await $.command.run(run('keepwarm', 'off'))
      expect((await cacheLine(ui))).toMatch(/keepwarm off( · saved \$[\d.]+)?$/)
    })

    test(`${surface}: NO_COLOR uses a bold text icon and uncolored state`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { noColor: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      const ui = await $.ui.mount({ plugin: 'cc-hud',surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ type: 'Image' })).toBe(undefined)
      expect(await ui.find({ type: 'Svg' })).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: /^\[>\]$/ }))?.props.bold).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^warm$/ }))?.props.color).toBe(undefined)
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: unknown, warm, cold and warm again agree with the card`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const w = world(on, [], { bandText: 'other mod' })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cc-hud',surface, component: 'AbovePrompt', props: bandProps })
      expect((await cacheLine(ui))).toMatch(/keepwarm off( · saved \$[\d.]+)?$/)
      await $.command.run(run('keepwarm', '3h every 90m'))
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await cacheLine(ui))).toMatch(/unknown.*waiting for the first turn/)
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
      expect((await cacheLine(ui))).toMatch(/warm.*ping in 1h30m/)
      await clock.advance(HOUR)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
      expect((await cacheLine(ui))).toMatch(/cold.*cold now/)
      expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/state       COLD/)
      expect(w.forks.length).toBe(0)
      expect((await ui.find({ text: /^other mod$/ }))?.text).toBe('other mod')
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
      expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/state       warm/)
      expect(w.status.filter(Boolean)).toEqual([])
      await $.command.run(run('keepwarm', 'off'))
      expect((await cacheLine(ui))).toMatch(/keepwarm off( · saved \$[\d.]+)?$/)
      expect(w.forks.length).toBe(0)
    })
  }

  test('cold resume, compaction and clear reset the row without a ping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [], { store: new Map([['deadline:S1', 13 * HOUR]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud',surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await cacheLine(ui))).toMatch(/unknown.*after compaction/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    await $.classic.SessionStart({ source: 'clear' })
    expect((await cacheLine(ui))).toMatch(/keepwarm off( · saved \$[\d.]+)?$/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('window expiry removes the row and surveys retain their band', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { bandText: 'survey' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '10m'))
    const ui = await $.ui.mount({ plugin: 'cc-hud',surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    const survey = await $.ui.mount({ plugin: 'cc-hud',surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, hasSurvey: true } })
    expect(await survey.find({ key: 'cache-tax-line' })).toBe(undefined)
    expect((await survey.find({ text: 'survey' }))?.text).toBe('survey')
    await clock.advance(10 * MIN)
    expect((await cacheLine(ui))).toMatch(/keepwarm off( · saved \$[\d.]+)?$/)
    expect(w.forks.length).toBe(0)
  })

  test('the on/off toggle arms and stops keepwarm, and stays to turn it back on', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    const selected = async () => (await ui.find({ key: 'cache-toggle-on' }))?.props.variant === 'primary' ? 'on' : (await ui.find({ key: 'cache-toggle-off' }))?.props.variant === 'primary' ? 'off' : null
    expect(await selected()).toBe('off')
    await ui.press({ key: 'cache-toggle-on' })
    expect(await selected()).toBe('on')
    expect((await cacheLine(ui))).toMatch(/keepwarm on for this session · ping in 50m/)
    expect(w.toasts.at(-1)).toMatch(/keepwarm on for this session/)
    await ui.press({ key: 'cache-toggle-off' })
    expect(await selected()).toBe('off')
    expect((await cacheLine(ui))).toMatch(/keepwarm off( · saved \$[\d.]+)?$/)
    await ui.press({ key: 'cache-toggle-on' })
    expect(await selected()).toBe('on')
    expect(w.forks.length).toBe(0)
  })

  test('the compact row shows the cache time left and moves it every minute', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await cacheLine(ui))).toMatch(/^ cache · warm 1h00m left · keepwarm off · saved \$[\d.]+$/)
    await clock.advance(19 * MIN + 30 * 1000)
    expect((await cacheLine(ui))).toMatch(/warm 41m left/)
    await clock.advance(45 * MIN)
    expect((await cacheLine(ui))).toMatch(/cold expired 4m ago/)
  })

  test('pressing on while always armed the window keeps always', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', 'always'))
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await ui.press({ key: 'cache-toggle-on' })
    expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/keepwarm    on, .*\(always\)/)
  })

  test('a warm resume restores green and ignores subagent cache activity', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [], { store: new Map<string, unknown>([['deadline:S1', 13 * HOUR], ['every:S1', 90 * MIN]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 30 * 60, context_tokens: 200000 })
    const ui = await $.ui.mount({ plugin: 'cc-hud',surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    await $.turn.complete(turn({ agentId: 'worker' }))
    await $.session.compact({ trigger: 'manual', agentId: 'worker', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await clock.advance(30 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
    expect(w.forks.length).toBe(0)
  })

  for (const surface of ['vscode', 'mobile', null] as const) {
    test(`${surface ?? 'headless'} keeps the plain status fallback`, async ($, on) => {
      mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 50m')
      expect(w.status.at(-1)).not.toMatch(/\x1b/)
      expect(w.forks.length).toBe(0)
    })
  }

  test('a warm ping keeps the green row and a cold read stops it neutrally', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, { read: 0, write: 200000 }])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    const ui = await $.ui.mount({ plugin: 'cc-hud',surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await clock.advance(50 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    expect((await cacheLine(ui))).toMatch(/last ping read 200k/)
    await clock.advance(50 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await cacheLine(ui))).toMatch(/stopped.*cache was already gone/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(2)
  })

  for (const failure of [
    { isAnswered: false, reason: 'nothing-to-fork' },
    { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() },
    { isAnswered: false, reason: 'empty-reply', usage: usage() },
    { isAnswered: false, reason: 'aborted', usage: usage() },
  ] satisfies ModelForkResult[]) {
    test(`structured fork failure ${failure.reason} stops without retrying`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [failure])
      await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h every 1m'))
      const ui = await $.ui.mount({ plugin: 'cc-hud',surface: 'terminal', component: 'AbovePrompt', props: bandProps })
      await clock.advance(MIN)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await cacheLine(ui))).toMatch(/stopped/)
      await clock.advance(2 * HOUR)
      expect(w.forks.length).toBe(1)
    })
  }
})

describe('parse and format', () => {
  test('durations', async () => {
    expect(parseDuration('6h')).toBe(6 * HOUR)
    expect(parseDuration('90m')).toBe(90 * MIN)
    expect(parseDuration('2h30m')).toBe(150 * MIN)
    expect(parseDuration('soon')).toBe(null)
    expect(fmtDuration(150 * MIN)).toBe('2h30m')
    expect(fmtDuration(7 * MIN)).toBe('7m')
    expect(fmtDuration((15 * 24 + 9) * 60 * MIN)).toBe('15d 9h')
  })
})

describe('guard', () => {
  test('refuses a cold send once with the price, then lets the resend through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit(prompt('hi'))
    expect(first.drop).toMatch(/cache-tax: the prompt cache went cold 2h00m ago\. Sending this re-writes up to 200,502 tokens at \$20\/MTok = \$4\.01/)
    expect(w.entered).toEqual([])
    const second = await $.prompt.submit(prompt('hi'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
  })

  test('lets slash commands, warm sends and small contexts through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(30 * MIN)
    await $.prompt.submit(prompt('warm one'))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('/clear'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 20000 }) }))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('small one'))
    expect(w.entered).toEqual(['warm one', '/clear', 'small one'])
  })

  test('warn mode shows the price and sends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    const r = await $.command.run(run('cache-tax', 'guard warn'))
    expect(r.text).toMatch(/guard set to warn/)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/Sending anyway/)
  })

  test('a paid cold write is scored and does not turn keepwarm on', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.logs.at(-1)).toMatch(/cold write of 201k tokens paid \(\$4\.01\)\. Turn keepwarm on/)
    expect(w.status.filter(Boolean)).toEqual([])
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/session     1 cold write paid, \$4\.01/)
    expect(card.text).toMatch(/keepwarm    off \(\/keepwarm on keeps it warm for this session\)/)
  })

  test('context comes from the live window, not the turn\'s summed usage', async ($, on) => {
    mock.clock(on, { now: START })
    const live: { tokens?: number } = {}
    const w = world(on, [], { live })
    await $.session.start(session)
    await $.turn.complete(turn())
    live.tokens = 100000
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 500000, cache_creation_input_tokens: 2000 }) }))
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/context     100,000 tokens/)
    expect(card.text).toMatch(/0 cold writes paid/)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/clear forgets the context, the clock and the tally', async () => {
    const s = freshState()
    s.ctx = 200000
    s.lastRequestAt = START - 2 * HOUR
    s.ackedAt = s.lastRequestAt
    s.misses = [{ at: START, tokens: 200000, usd: 4 }]
    let cancelled = false
    s.pending = { cancel: () => { cancelled = true } }
    resetForClear(s)
    expect(s.ctx).toBe(0)
    expect(s.lastRequestAt).toBe(0)
    expect(s.ackedAt).toBe(0)
    expect(s.misses).toEqual([])
    expect(s.pending).toBe(null)
    expect(cancelled).toBe(true)
  })

  test('an unguarded full miss is scored too', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/1 cold write paid/)
    expect(w.status.filter(Boolean)).toEqual([])
  })

  test('stays quiet after a compaction until the first new turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
    await $.prompt.submit(prompt('after compact'))
    expect(w.entered).toEqual(['after compact'])
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/reset by compaction/)
  })

  test('a cold resume seeds the guard before any turn and returns the estimate line', async () => {
    const s = freshState()
    const now = START
    const line = seedFromResume(s, { source: 'resume', model: 'claude-fable-5-1', context_tokens: 396113, seconds_since_last_response: 3 * 3600, prompt_cache_likely_expired: true, estimated_cache_write_usd: 7.92 }, now)
    expect(line).toMatch(/resuming cold\. The first message re-writes 396,113 tokens, about \$7\.92/)
    expect(s.ctx).toBe(396113)
    expect(s.lastRequestAt).toBe(now - 3 * HOUR)
    expect(seedFromResume(freshState(), { source: 'startup' }, now)).toBe(null)
    expect(seedFromResume(freshState(), { source: 'resume', context_tokens: 20000, prompt_cache_likely_expired: true }, now)).toBe(null)
  })

  test('warns once when the hook form is installed beside it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { commands: ['cache-tax:status'] })
    await $.session.start(session)
    expect(w.logs.at(-1)).toMatch(/hook form .* is also installed/)
  })

  test('warns once when the original cache-tax mod is loaded beside it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { commands: [{ name: 'keepwarm', plugin: 'cache-tax' }, { name: 'cache-tax', plugin: 'cache-tax' }] })
    await $.session.start(session)
    await $.command.run(run('keepwarm', 'status'))
    expect(w.logs.filter(line => line.includes('also loaded'))).toEqual(['cache-tax is also loaded and registers /keepwarm: two guards and two keepwarm loops, and /keepwarm off reaches only one. Disable it (claude plugin disable cache-tax@claude-code-mods) and restart.'])
  })

  test('its own commands are not a twin', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { commands: [{ name: 'keepwarm', plugin: 'cc-hud' }, { name: 'cache-tax', plugin: 'cc-hud' }] })
    await $.session.start(session)
    await $.command.run(run('cache-tax', ''))
    expect(w.logs).toEqual([])
  })
})

describe('keepwarm', () => {
  test('pings 50 minutes after the last request, then again, and reports the read', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', '6h'))
    expect(r.text).toMatch(/keepwarm on for 6h00m/)
    await $.turn.complete(turn())
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm 5h10m left · ping in 50m · last ping read 200k \$0\.05/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a new turn resets the countdown', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('stops when a ping reads cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 180000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: the ping read 0 and wrote 180k tokens \(\$3\.60\)/)
    await clock.advance(120 * MIN)
    expect(w.forks.length).toBe(1)
    const s = await $.command.run(run('keepwarm', 'status'))
    expect(s.text).toMatch(/stopped/)
  })

  test('stops when the engine returns null, a cold snapshot or an API error', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [null])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/either the snapshot was cold or the API call failed/)
  })

  test('the window ends on its own, forgetting the every knob, and off cancels', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm, warm, warm], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '3m every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toBe(undefined)
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the every knob lasts one window only', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', 'off'))
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(3)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(3)
  })

  test('a bare /keepwarm and /keepwarm on keep the cache warm until the session ends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, Array.from({ length: 12 }, () => warm), { store })
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toMatch(/^keepwarm on for this session, a ping 50m after each idle stretch/)
    expect((await $.command.run(run('keepwarm', 'on'))).text).toMatch(/^keepwarm on for this session/)
    expect(store.get('session:S1')).toBe(true)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm on for this session · ping in 50m')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    // Past the old six-hour window it still pings.
    await clock.advance(7 * HOUR)
    expect(w.forks.length).toBeGreaterThan(6)
  })

  test('always is remembered, arms every session start, and off ends it for good', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true], ['deadline:S1', START - MIN], ['every:S1', MIN]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm on for this session · waiting for the first turn')
    expect(store.get('deadline:S1')).toBe(START + 20 * 24 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/keepwarm    on, for this session · ping in 50m · last ping read 200k \$0\.05 \(always\)/)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off, and no longer arms itself at session start')
    expect(store.has('always')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/keepwarm always sets the switch and arms now', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toMatch(/^keepwarm always on: every session starts with it on/)
    expect(store.get('always')).toBe(true)
    expect(store.get('deadline:S1')).toBe(START + 20 * 24 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm on for this session · waiting for the first turn')
  })

  test('the ping figure counts output tokens at the model\'s rate, Sonnet 5 priced as itself', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h10m left · ping in 50m · last ping read 200k $0.05')
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/cold cost   \$0\.80 to re-write it \(warm turn \$0\.04\)/)
    expect(card.text).toMatch(/break-even  up to 20 pings at the read rate cost one cold write, about 16h40m of idle at one ping per 50m/)
  })

  test('a partial write, a zero read, or a full write stops the loop; a ping\'s own few tokens do not', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 500 }, { read: 75000, write: 70000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/^keepwarm 5h59m left · ping in 1m · last ping read 200k/)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 75k and wrote 70k tokens/)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a ping that reads nothing stops the loop too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 0 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0 and wrote 0 tokens/)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the ping figure counts uncached input at the base rate', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, input: 50000, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h10m left · ping in 50m · last ping read 200k $0.15')
  })

  test('the card states the break-even for Fable 5.1', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/break-even  up to 80 pings at the read rate cost one cold write, about 2d 18h of idle at one ping per 50m/)
  })

  test('/keepwarm on a cold session schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(15 * 24 * HOUR)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toBe('keepwarm on for this session, a ping 50m after each idle stretch keeps the cache read, not re-written. The cache is cold now, so the first ping comes 50m after the next turn')
    expect(w.status.at(-1)).toBe('keepwarm on for this session · cold now, first ping 50m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/keepwarm    on, for this session · cold now, first ping 50m after the next turn/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm on for this session · ping in 50m')
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the always switch on a cold resume schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', 'off'))
    await clock.advance(15 * 24 * HOUR)
    // The test kit cannot raise classic.SessionStart, so the cold state comes from the turn above and a second start arms the switch over it.
    store.set('always', true)
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm on for this session · cold now, first ping 50m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toBe('keepwarm always on: every session starts with it on; /keepwarm off turns it off for good. The cache is cold now, so the first ping comes 50m after the next turn')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a cold window expires and nothing turns keepwarm back on', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('keepwarm', '90m every 1m'))
    await clock.advance(90 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('every:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await clock.advance(3 * HOUR)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('a turn after sleep clears the expired period before the overdue timer runs', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 2 * HOUR
    await $.command.run(run('keepwarm', '90m every 1m'))
    now += 91 * MIN
    expect(store.get('every:S1')).toBe(MIN)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    expect(w.forks.length).toBe(0)
  })

  test('subagent turns do not touch the timer', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn({ agentId: 'a1' }))
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('store per session', () => {
  test('another session\'s window does not arm this one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe(undefined)
    const r = await $.command.run(run('keepwarm', 'status'))
    expect(r.text).toBe('keepwarm is off')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
  })

  test('this session\'s own window is restored on start', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START + 2 * HOUR], ['every:mine', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a window that lapsed less than a week ago is left for its own session', async ($, on) => {
    const now = START + 30 * 24 * HOUR
    mock.clock(on, { now })
    const store = new Map<string, unknown>([['deadline:recent', now - HOUR], ['every:recent', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:recent', 'every:recent'])
  })

  test('/keepwarm off deletes only this session\'s keys', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN], ['always', true], ['guard', 'warn']])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    expect(store.get('deadline:mine')).toBe(START + HOUR)
    expect(store.get('every:mine')).toBe(MIN)
    await $.command.run(run('keepwarm', 'off'))
    expect(store.has('deadline:mine')).toBe(false)
    expect(store.has('every:mine')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
    expect(store.get('guard')).toBe('warn')
  })

  test('legacy bare keys are cleared on start; other sessions\' keys, live or dead, and the global switches stay', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([
      ['deadline:old1', START - 8 * 24 * HOUR], ['every:old1', MIN],
      ['deadline:old2', 0],
      ['deadline', 0], ['every', MIN],
      ['deadline:live', START + HOUR], ['every:live', 2 * MIN],
      ['guard', 'warn'],
    ])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:old1', 'every:old1', 'deadline:old2', 'deadline:live', 'every:live', 'guard'])
  })

  test('this session\'s own dead window is cleared on start', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START - MIN], ['every:mine', MIN], ['deadline:other', START - MIN], ['every:other', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:other', 'every:other'])
  })
})

describe('one row: compact and detailed', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const limits = (): SessionRateLimit[] => [
    { kind: 'seven_day', percentUsed: 39, resetsAt: iso(START + (4 * 24 + 7) * HOUR) },
    { kind: 'five_hour', percentUsed: 4, resetsAt: iso(START + 4 * HOUR + 50 * MIN) },
  ]
  // The line's text, without the show details / show less button at its end.
  const line = async (ui: Mounted<'desktop', 'AbovePrompt'>, key: string) => ((await ui.find({ key }))?.text ?? '').replace(/(show details|show less)$/, '')

  test('a new session starts compact: one line with the cache, the next ping and the plan windows', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: false, limits: limits(), ctxPercent: 35 })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', 'on'))
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await line(ui, 'cache-tax-compact')).toBe(' warm 1h00m left · ping in 50m · Session 4% ↻4h50m · Week 39% ↻4d 7h · 0 agents')
    expect((await ui.find({ key: 'cache-detail-toggle' }))?.props.label).toBe('show details')
    expect(await ui.find({ key: 'cache-toggle-on' })).toBeUndefined()
    expect(await ui.find({ key: 'cache-clock-row' })).toBeUndefined()
  })

  test('show details gives the keepwarm row and the usage line; show less folds them, and the choice is kept', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store, detailed: false, limits: limits(), ctxPercent: 35 })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await line(ui, 'cache-tax-compact')).toMatch(/^ warm 1h00m left · keepwarm off · Session 4%/)
    await ui.press({ key: 'cache-detail-toggle' })
    expect(store.get('detailed')).toBe(true)
    expect((await cacheLine(ui))).toMatch(/^ cache · warm 1h00m left · keepwarm off · saved \$[\d.]+$/)
    expect(await line(ui, 'cache-usage-row')).toBe(' Session 4% ↻4h50m · Week 39% ↻4d 7h · 0 agents')
    expect((await ui.find({ key: 'cache-detail-toggle' }))?.props.label).toBe('show less')
    expect(await ui.find({ key: 'cache-toggle-off' })).toBeDefined()
    await ui.press({ key: 'cache-detail-toggle' })
    expect(store.get('detailed')).toBe(false)
    expect(await ui.find({ key: 'cache-usage-row' })).toBeUndefined()
    expect(await ui.find({ key: 'cache-tax-compact' })).toBeDefined()
  })

  test('a measurement redraws the windows, and a window ahead of pace is marked', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: false, limits: limits() })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    // 60% used with a fifth of the five hours gone by.
    await $.session.measure({ context: { window: 1000000, percent: 40 }, rateLimits: [{ kind: 'five_hour', percentUsed: 60, resetsAt: iso(START + 4 * HOUR) }], changed: ['rateLimits'] })
    expect(await line(ui, 'cache-tax-compact')).toBe(' no request yet · keepwarm off · Session 60% ↻4h00m ⚠ out in 40m · 0 agents')
  })

  test('counts the subagents still at work, and leaves finished ones out', async ($, on) => {
    mock.clock(on, { now: START })
    const agent = (id: string, status: AgentInfo['status']): AgentInfo => ({ id, description: id, type: 'general-purpose', status })
    world(on, [], { store: new Map(), detailed: false, limits: limits(), agents: [agent('a', 'running'), agent('b', 'pending'), agent('c', 'completed'), agent('d', 'waiting')] })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await line(ui, 'cache-tax-compact')).toMatch(/Week 39% ↻4d 7h · 3 agents$/)
    await ui.press({ key: 'cache-detail-toggle' })
    expect(await line(ui, 'cache-usage-row')).toBe(' Session 4% ↻4h50m · Week 39% ↻4d 7h · 3 agents')
  })

  test('without plan limits the row shows the cache and the agents alone', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map([['detailed', true]]), ctxPercent: 12 })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await line(ui, 'cache-usage-row')).toBe(' 0 agents')
    await ui.press({ key: 'cache-detail-toggle' })
    expect(await line(ui, 'cache-tax-compact')).toBe(' no request yet · keepwarm off · 0 agents')
  })
})

describe('responsive row', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const limits = (): SessionRateLimit[] => [
    { kind: 'five_hour', percentUsed: 12, resetsAt: iso(START + 4 * HOUR + 28 * MIN) },
    { kind: 'seven_day', percentUsed: 41, resetsAt: iso(START + (4 * 24 + 7) * HOUR) },
  ]
  // The line's text, without the details button at its end.
  const line = async (ui: Mounted<'terminal', 'AbovePrompt'>, key: string) => ((await ui.find({ key }))?.text ?? '').replace(/(show details|show less|details|less)$/, '')

  test('the compact line drops its least important parts first as the band narrows, and always fits', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: false, limits: limits() })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    const at = async (bodyColumns: number) => {
      const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, bodyColumns } })
      return line(ui, 'cache-tax-compact')
    }
    // The text's budget is the band less the icon (4), the margin (2) and the button (12, or 7 under 60 columns).
    expect(await at(100)).toBe(' warm 1h00m left · keepwarm off · Session 12% ↻4h28m · Week 41% ↻4d 7h · 0 agents')
    expect(await at(95)).toBe(' warm 1h00m · keepwarm off · Session 12% ↻4h28m · Week 41% ↻4d 7h · 0 agents')
    expect(await at(80)).toBe(' warm 1h00m · keepwarm off · Session 12% · Week 41% · 0 agents')
    expect(await at(72)).toBe(' warm 1h00m · keepwarm off · 5h 12% · 7d 41% · 0 agents')
    expect(await at(55)).toBe(' warm 1h00m · 5h 12% · 7d 41% · 0 agents')
    // The agent count stays when everything else but the cache has gone.
    expect(await at(42)).toBe(' warm 1h00m · 0 agents')
    expect(await at(25)).toBe(' warm 1h00m')
    for (const bodyColumns of [200, 100, 95, 80, 72, 55, 42, 25]) {
      const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, bodyColumns } })
      const button = String((await ui.find({ key: 'cache-detail-toggle' }))?.props.label ?? '')
      // The icon (3), the text and its leading space, the margin and the button stay within the band.
      expect(3 + [...(await line(ui, 'cache-tax-compact'))].length + 1 + button.length).toBeLessThanOrEqual(bodyColumns)
    }
  })

  test('in the details, show less sits at the bottom right: the end of the last line', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: true, limits: limits(), usd: 1, ctxPercent: 20 })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, bodyColumns: 120 } })
    expect((await ui.find({ key: 'cache-session-row' }))?.text).toMatch(/ctx 20%show less$/)
    expect((await ui.find({ key: 'cache-usage-row' }))?.text).not.toContain('show less')
  })

  test('narrow bands shorten the button and the detailed lines too', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: true, limits: limits() })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', 'on'))
    const wide = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, bodyColumns: 120 } })
    expect((await cacheLine(wide))).toMatch(/^ cache · warm 1h00m left · keepwarm on for this session · ping in 50m · saved \$[\d.]+$/)
    const medium = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, bodyColumns: 60 } })
    expect((await medium.find({ type: 'Text', text: 'warm' }))?.text).toBe(' warm 1h00m left · keepwarm on · ping in 50m')
    const narrow = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, bodyColumns: 50 } })
    expect((await narrow.find({ key: 'cache-detail-toggle' }))?.props.label).toBe('less')
    expect((await narrow.find({ type: 'Text', text: 'warm' }))?.text).toBe(' warm 1h00m left')
    expect(await line(narrow, 'cache-usage-row')).toBe(' Session 12% · Week 41% · 0 agents')
  })
})

describe('hud features', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const line = async (ui: { find(q: { key: string }): Promise<{ text?: string } | undefined> }, key: string) =>
    ((await ui.find({ key }))?.text ?? '').replace(/(show details|show less|details|less)$/, '')
  const mount = ($: Parameters<TestBody>[0], bodyColumns = 200) =>
    $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, bodyColumns } })

  test('a window ahead of pace shows when it will run out, and alerts once at 80% and again at 95%', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { store: new Map(), detailed: false })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await mount($)
    // 85% used an hour into the five: ahead of pace, the last 15% gone in about 11 minutes.
    const at = (percentUsed: number) => $.session.measure({ context: { window: 1000000 }, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: iso(START + 4 * HOUR) }], changed: ['rateLimits'] })
    await at(85)
    expect(await line(ui, 'cache-tax-compact')).toMatch(/Session 85% ↻4h00m ⚠ out in 11m/)
    expect(w.toasts).toEqual(['Session limit at 85%, resets in 4h00m; at this pace it runs out in 11m'])
    await at(86)
    expect(w.toasts).toHaveLength(1)
    await at(96)
    expect(w.toasts).toHaveLength(2)
    expect(w.toasts[1]).toMatch(/^Session limit at 96%/)
  })

  test('a running turn shows its timer in place of keepwarm, and a long one ends with a toast and a chime', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: new Map(), detailed: false })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await mount($)
    await step($)
    await clock.advance(2 * MIN + 14 * 1000)
    expect(await line(ui, 'cache-tax-compact')).toContain('working 2m14s · 0 tools')
    await $.turn.complete(turn({ turnId: 'open' }))
    expect(w.toasts).toContain('Done in 2m14s · 0 tools')
    expect(w.sounds).toEqual(['sounds/done.wav'])
    expect(await line(ui, 'cache-tax-compact')).not.toContain('working')
  })

  test('/hud chime off keeps the toast and drops the sound; a short turn has neither', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store, detailed: false })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    expect((await $.command.run(run('hud', 'chime off'))).text).toMatch(/^chime off/)
    expect(store.get('chime')).toBe(false)
    await step($)
    await clock.advance(2 * MIN)
    await $.turn.complete(turn({ turnId: 'open' }))
    expect(w.toasts).toContain('Done in 2m00s · 0 tools')
    expect(w.sounds).toEqual([])
    await step($)
    await clock.advance(20 * 1000)
    await $.turn.complete(turn({ turnId: 'open' }))
    expect(w.toasts.filter(t => t.startsWith('Done'))).toHaveLength(1)
  })

  test('details show the cost and its rate, and a full context gets a compact button in both views', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: true, usd: 1.24, ctxPercent: 85 })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await clock.advance(30 * MIN)
    const ui = await mount($)
    expect(await line(ui, 'cache-session-row')).toBe(' $1.24 this session · $2.48/h · ctx 85% compact')
    expect(await ui.find({ key: 'cache-compact' })).toBeDefined()
    await ui.press({ key: 'cache-detail-toggle' })
    expect(await line(ui, 'cache-tax-compact')).toMatch(/· ctx 85% compact$/)
  })

  test('background shells and scheduled wake-ups are counted at the end of each turn, subagents left out', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: true })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await mount($)
    await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: [
        { id: '1', type: 'shell', status: 'running', description: 'dev server' },
        { id: '2', type: 'subagent', status: 'running', description: 'explore' },
      ],
      session_crons: [{ id: 'c', schedule: '*/5 * * * *', recurring: true, prompt: 'check' }],
    } as never)
    expect(await line(ui, 'cache-usage-row')).toBe(' 0 agents · 1 bg · 1 scheduled')
  })

  test('/hud prints the breakdown, and the window labels and the cache label are buttons', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: true, usd: 0.5, ctxPercent: 30, limits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: iso(START + 2 * HOUR) }] })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.session.measure({ context: { window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: iso(START + 2 * HOUR) }], changed: ['rateLimits'] })
    const text = (await $.command.run(run('hud', ''))).text
    expect(text).toMatch(/^Session  30% used · resets in 2h00m · 60% of the window gone, on pace/)
    expect(text).toMatch(/History  last 1 days, daily peak: Session ▃ · Week ▁/)
    expect(text).toMatch(/Cost     \$0\.50 this session/)
    expect(text).toMatch(/Chime    on/)
    const ui = await mount($)
    expect((await ui.find({ key: 'cache-usage-Session' }))?.props.label).toBe('Session')
    expect((await ui.find({ key: 'cache-cache' }))?.props.label).toBe('cache')
  })
})

describe('tool calls in the agents pane', () => {
  const paneProps = { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } } as RenderPropsOf['Pane']

  test('the tools count opens the agents pane with every row folded; the main Claude row lists each call and how it ended', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: new Map(), detailed: false })
    const panes = new Set<string>()
    on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isPlaced: true })) } as never))
    on('ui.open', ($, e) => { panes.add(e.id); return { value: { isPlaced: true } } as never })
    on('ui.close', ($, e) => { panes.delete(e.id); return { value: undefined } })
    on('tool.call', ($, e) => (e.tool === 'Edit' ? { result: null, text: 'no match', isError: true } : { result: null, text: 'ok' }) as never)
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, bodyColumns: 200 } })
    await step($)
    await $.tool.call({ tool: 'Bash', command: 'npm   test' } as never)
    await clock.advance(1500)
    await $.tool.call({ tool: 'Edit', file_path: 'hooks/register.ts', old_string: 'a', new_string: 'b' } as never)
    expect((await band.find({ key: 'cache-tools' }))?.props.label).toBe('2 tools')
    await band.press({ key: 'cache-tools' })
    expect([...panes]).toEqual(['hud-agents'])
    const pane = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-agents', props: paneProps } as never) as Mounted<'terminal', 'Pane'>
    expect(await pane.find({ key: 'agent-main-detail' })).toBeUndefined()
    await pane.press({ key: 'agent-open-main' })
    const open = (await pane.find({ key: 'agent-main-detail' }))?.text ?? ''
    expect(open).toContain('Tool calls this turn (2)')
    expect(open).toMatch(/✓ Bash npm test · 0ms/)
    expect(open).toMatch(/✗ Edit hooks\/register\.ts/)
    await $.turn.complete(turn({ turnId: 'open' }))
    expect((await pane.find({ key: 'agent-main-detail' }))?.text).toContain('Tool calls last turn (2)')
    expect((await $.command.run(run('hud', 'tools'))).text).toBe('Agents pane closed')
    expect([...panes]).toEqual([])
    // Opened again (the turn is over, so by the agent count), the pane starts folded, whatever was open before.
    await band.press({ key: 'cache-agents' })
    expect([...panes]).toEqual(['hud-agents'])
    expect(await pane.find({ key: 'agent-main-detail' })).toBeUndefined()
    expect(w.forks.length).toBe(0)
  })
})

describe('agents pane', () => {
  const paneProps = { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } } as RenderPropsOf['Pane']

  test('picks a skin from the agent type and its task', async () => {
    expect(skinOf('Explore', 'anything')).toBe('pirate')
    expect(skinOf('Plan', 'anything')).toBe('astronaut')
    expect(skinOf('general-purpose', 'Count lines in hook files')).toBe('detective')
    expect(skinOf('general-purpose', 'Fix the failing build')).toBe('builder')
    expect(skinOf('general-purpose', 'Run the tests and verify')).toBe('scientist')
    expect(skinOf('general-purpose', 'Name 10 foods')).toBe('chef')
    expect(skinOf('general-purpose', 'Ponder')).toBe('plain')
    // The earliest telling word wins: a summary of test names is the chef's, a test of the summary the scientist's.
    expect(skinOf('general-purpose', 'Summarize cc-hud test names')).toBe('chef')
    expect(skinOf('general-purpose', 'Test the summary output')).toBe('scientist')
    expect(skinOf('general-purpose', 'Debug the crash on startup')).toBe('doctor')
    expect(skinOf('general-purpose', 'Review PR #42')).toBe('judge')
    expect(skinOf('general-purpose', 'Security audit of the auth flow')).toBe('knight')
    expect(skinOf('general-purpose', 'Update the README')).toBe('scribe')
    expect(skinOf('general-purpose', 'Refactor the row layout')).toBe('janitor')
    expect(skinOf('general-purpose', 'Analyze the usage data')).toBe('miner')
    expect(skinOf('general-purpose', 'Style the settings UI')).toBe('painter')
    expect(skinOf('general-purpose', 'Optimize startup time')).toBe('racer')
    expect(skinOf('general-purpose', 'Rebase onto main and merge')).toBe('gardener')
    expect(skinOf('general-purpose', 'Deploy to staging')).toBe('courier')
    expect(skinOf('general-purpose', 'Translate the strings to Thai')).toBe('traveller')
    expect(skinOf('general-purpose', 'Monitor the build logs')).toBe('guard')
    expect(outfitsFit()).toBe(true)
    // Moods draw over any costume: a party hat once finished, a bandage once failed.
    expect(spriteSvg('chef', 'done', 28, { isParty: true })).not.toBe(spriteSvg('chef', 'done'))
    // A failed critter is gray and knocked out, costume and all; only a running one moves.
    expect(spriteSvg('chef', 'failed')).toContain('#3A3A3A')
    expect(spriteSvg('chef', 'failed')).not.toContain('#D97757')
    expect(spriteSvg('chef', 'running')).toContain('class="cch-run"')
    expect(spriteSvg('chef', 'running')).toContain('class="cch-stir"')
    expect(spriteSvg('chef', 'done')).not.toContain('class="cch-run"')
    expect(spriteSvg('builder', 'running', 28, { isWaiting: true })).toContain('class="cch-wait"')
    expect(spriteSvg('chef', 'done')).toMatch(/^<svg [^>]*viewBox="0 0 20 16"/)
  })

  test('lists each subagent with its skin, model, tokens, cost and time; the agent count opens it at once', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const list: AgentInfo[] = []
    // The world answers the agent list from this array, which the test fills as the engine would.
    world(on, [], { store: new Map(), detailed: false, agents: list })
    const panes = new Set<string>()
    on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isPlaced: true })) } as never))
    on('ui.open', ($, e) => { panes.add(e.id); return { value: { isPlaced: true } } as never })
    on('ui.close', ($, e) => { panes.delete(e.id); return { value: undefined } })
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: { ...bandProps, isWorking: true } })
    await $.agent.spawn({ tool_use_id: 't', prompt: 'Name ten foods', description: 'Name 10 foods', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, background: true } as never)
    list.push({ id: 'a1', description: 'Name 10 foods', type: 'general-purpose', status: 'running' })
    await band.press({ key: 'cache-agents' })
    expect([...panes]).toEqual(['hud-agents'])
    const pane = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'Pane', requestId: 'hud-agents', props: paneProps } as never) as Mounted<'desktop', 'Pane'>
    expect((await pane.find({ key: 'agent-a1' }))?.text).toMatch(/^▸ Name 10 foods●general-purpose · Haiku 5\.5/)
    // The main Claude is pinned first, asleep; the subagent wears the chef's toque.
    expect((await pane.findAll({ type: 'Svg' })).map(x => x.props.alt)).toEqual(['plain', 'chef'])
    await clock.advance(7000)
    await $.turn.complete(turn({ agentId: 'a1', usage: usage({ model: 'claude-haiku-5-5', input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 }) }))
    list[0]!.status = 'completed'
    const row = (await pane.find({ key: 'agent-a1' }))?.text ?? ''
    expect(row).toMatch(/✓/)
    expect(row).toMatch(/52k tokens · ≈\$0\.01 · 0:07$/)
    expect((await pane.findAll({ type: 'Text' })).map(t => t.text)).toContain('Claude idle · 0 running · 1 finished')
    expect((await $.command.run(run('hud', 'agents'))).text).toBe('Agents pane closed')
  })

  test('clicking an agent opens its row: what it does now, its task, its calls and its answer, secrets hidden', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const list: AgentInfo[] = []
    world(on, [], { store: new Map(), detailed: false, agents: list })
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a2' }))
    on('tool.call', () => ({ result: null, text: 'ok' }) as never)
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.agent.spawn({ tool_use_id: 't', prompt: 'Deploy with API_KEY=sk-abcdefghijklmnopqrstu and report back', description: 'Deploy to staging', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, background: true } as never)
    list.push({ id: 'a2', description: 'Deploy to staging', type: 'general-purpose', status: 'running' })
    const pane = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-agents', props: paneProps } as never) as Mounted<'terminal', 'Pane'>
    expect(await pane.find({ key: 'agent-a2-detail' })).toBeUndefined()
    await pane.press({ key: 'agent-open-a2' })
    let detail = (await pane.find({ key: 'agent-a2-detail' }))?.text ?? ''
    expect(detail).toMatch(/^Now thinking/)
    expect(detail).toContain('Task Deploy with API_KEY=••• and report back')
    expect(detail).not.toContain('sk-abcdefghijklmnopqrstu')
    await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: Bearer abc.def.ghi" https://example.com', agentId: 'a2' } as never)
    await clock.advance(3000)
    detail = (await pane.find({ key: 'agent-a2-detail' }))?.text ?? ''
    expect(detail).toContain('Tool calls (1)')
    expect(detail).toMatch(/✓ Bash curl -H "Authorization: Bearer •••" https:\/\/example\.com/)
    await $.turn.complete(turn({ agentId: 'a2', answer: 'Deployed build 42 to staging.', usage: usage({ model: 'claude-haiku-5-5' }) }))
    list[0]!.status = 'completed'
    detail = (await pane.find({ key: 'agent-a2-detail' }))?.text ?? ''
    expect(detail).not.toMatch(/^Now/)
    expect(detail).toContain('ResultDeployed build 42 to staging.')
    expect((await pane.find({ type: 'Svg' }))).toBeUndefined()
    await pane.press({ key: 'agent-open-a2' })
    expect(await pane.find({ key: 'agent-a2-detail' })).toBeUndefined()
  })
})

describe('the main Claude as an agent', () => {
  const paneProps = { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } } as RenderPropsOf['Pane']

  test('the row counts the main Claude while it works, and its pinned row dresses for its tool', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: false })
    on('tool.call', () => ({ result: null, text: 'ok' }) as never)
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    const pane = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'Pane', requestId: 'hud-agents', props: paneProps } as never) as Mounted<'desktop', 'Pane'>
    const count = async () => (await band.find({ key: 'cache-agents' }))?.props.label
    const mainSkin = async () => (await pane.findAll({ type: 'Svg' }))[0]?.props.alt
    expect(await count()).toBe('0 agents')
    expect(await mainSkin()).toBe('plain')
    expect((await pane.find({ key: 'agent-main' }))?.text).toMatch(/^▸ Claude \(main\)○main thread/)
    await $.prompt.submit(prompt('Read the sprites and fix the doctor'))
    await step($)
    expect(await count()).toBe('1 agent')
    await $.tool.call({ tool: 'Read', file_path: 'hooks/sprites.ts' } as never)
    expect(await mainSkin()).toBe('detective')
    await $.tool.call({ tool: 'Edit', file_path: 'hooks/sprites.ts', old_string: 'a', new_string: 'b' } as never)
    expect(await mainSkin()).toBe('builder')
    await clock.advance(5000)
    await pane.press({ key: 'agent-open-main' })
    const open = (await pane.find({ key: 'agent-main-detail' }))?.text ?? ''
    expect(open).toContain('You asked Read the sprites and fix the doctor')
    expect(open).toContain('Tool calls this turn (2)')
    expect((await pane.find({ key: 'agent-main' }))?.text).toContain('working 5s · 2 tools')
    await $.turn.complete(turn({ turnId: 'open', answer: 'Moved the stethoscope down a row.' }))
    expect(await count()).toBe('0 agents')
    expect(await mainSkin()).toBe('plain')
    expect((await pane.find({ key: 'agent-main-detail' }))?.text).toContain('Last answerMoved the stethoscope down a row.')
  })
})

describe('answers as markdown, and the retired tools pane', () => {
  test('an answer reaches the pane as markdown, table and all, cut at a whole line when long', async () => {
    const table = 'Done.\n\n| Step | Result |\n|---|---|\n| Read | 42 functions |\n| Test | 112 pass |'
    expect(answerMarkdown(table)).toBe(table)
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} of the answer`).join('\n')
    const cut = answerMarkdown(long)
    expect(cut.length).toBeLessThanOrEqual(4010)
    expect(cut.endsWith('\n\n…')).toBe(true)
    expect(cut.split('\n').slice(-3, -2)[0]).toMatch(/^line \d+ of the answer$/)
    expect(answerMarkdown('token ghp_abcdefghijklmnopqrstuvwxyz used')).toBe('token ••• used')
  })

  test('a Tool calls pane left open from before 3.10 is closed when cc-hud starts', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map(), detailed: false })
    const panes = new Set<string>(['hud-tools'])
    on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isPlaced: true })) } as never))
    on('ui.close', ($, e) => { panes.delete(e.id); return { value: undefined } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    expect([...panes]).toEqual([])
  })
})

describe('secrets on screen', () => {
  test('look-alike secrets are hidden, and ordinary text is left alone', async () => {
    expect(redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz npm publish')).toBe('GITHUB_TOKEN=••• npm publish')
    expect(redactSecrets('mysql --password hunter2 -u root')).toBe('mysql --password ••• -u root')
    expect(redactSecrets('git clone https://me:s3cret@github.com/x/y')).toBe('git clone https://me:•••@github.com/x/y')
    expect(redactSecrets('aws s3 ls AKIAABCDEFGHIJKLMNOP')).toBe('aws s3 ls •••')
    expect(redactSecrets('npm test -- --watch')).toBe('npm test -- --watch')
    expect(redactSecrets('Read hooks/register.ts')).toBe('Read hooks/register.ts')
  })
})

describe('live clock', () => {
  // The clock row's text starts " cache "; cache-tax's own row starts " cache-tax".
  const ROW = /^ cache /
  // The row's text is the cache-clock Client's: it counts on the drawing's frame clock, the hooks module on the mocked one.
  const CLIENT = 'cache-clock'
  type Drawing = Pick<Mounted<'terminal' | 'desktop', 'AbovePrompt'>, 'find' | 'advance'>
  const row = async (ui: Drawing) => (await ui.find({ type: 'Text', text: ROW, in: CLIENT }))?.text
  const shown = async (ui: Drawing) => (await ui.find({ key: CLIENT })) !== undefined
  // Both clocks move together, a second at a time, as they do on a surface: the frame's tick for a second,
  // then the hooks module's events at that second, which may hand the Client fresh props.
  async function pass(clock: MockClock, ui: Drawing, ms: number) {
    for (let left = ms; left > 0; left -= 1000) {
      const step = Math.min(1000, left)
      await ui.advance(step)
      await clock.advance(step)
    }
  }

  test('formats countdowns as m:ss and h:mm:ss, rounding up', async () => {
    expect(fmtClock(41 * MIN + 12000)).toBe('41:12')
    expect(fmtClock(9 * MIN + 5000)).toBe('9:05')
    expect(fmtClock(HOUR)).toBe('1:00:00')
    expect(fmtClock(5 * HOUR + 12 * MIN + 3000)).toBe('5:12:03')
    expect(fmtClock(1)).toBe('0:01')
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(-5000)).toBe('0:00')
  })

  test('the line follows the cache and the next ping', async () => {
    const s = freshState()
    expect(clockLine(s, START)).toEqual({ state: 'unknown', time: 'no request yet', isLow: false, keepwarm: 'keepwarm off' })
    s.lastRequestAt = START
    const now = START + 18 * MIN + 48000
    expect(clockLine(s, now)).toEqual({ state: 'warm', time: '41:12 left', isLow: false, keepwarm: 'keepwarm off' })
    s.deadline = START + 3 * HOUR
    expect(clockLine(s, now).keepwarm).toBe('keepwarm ping in 31:12 · window 2h41m')
    s.pinging = true
    expect(clockLine(s, now).keepwarm).toBe('keepwarm pinging now')
    s.pinging = false
    s.held = true
    expect(clockLine(s, now).keepwarm).toBe('keepwarm waits for this turn to finish · window 2h41m')
    s.held = false
    // ping() finds the cache cold at one TTL, so a period that long never sends; warm or cold, the row says so.
    s.every = HOUR
    expect(clockLine(s, now).keepwarm).toBe('keepwarm on, its 1h00m period outlasts the cache · window 2h41m')
    expect(clockLine(s, START + HOUR + MIN).keepwarm).toBe('keepwarm on, its 1h00m period outlasts the cache · window 1h59m')
    // A ping due at the deadline is stopped by it, not sent.
    s.every = 50 * MIN
    s.deadline = START + 50 * MIN
    expect(clockLine(s, now).keepwarm).toBe('keepwarm ends in 31:12, no ping before then')
    s.deadline = START + 30 * MIN
    expect(clockLine(s, now).keepwarm).toBe('keepwarm ends in 11:12, no ping before then')
    s.deadline = 0
    expect(clockLine(s, START + 56 * MIN).isLow).toBe(true)
    expect(clockLine(s, START + HOUR + 12 * MIN)).toMatchObject({ state: 'cold', time: 'expired 12m ago', isLow: false })
    s.compacted = true
    expect(clockLine(s, now)).toMatchObject({ state: 'unknown', time: 'reset by compaction' })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    // An hour of one-second redraws on the mocked clock: slower than the kit's default 5s on the terminal's image icon.
    test(`${surface}: on by default, it counts down every second, warns near the end, then counts the cold`, { timeoutMs: 60000 }, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [], { clock: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cc-hud', surface, component: 'AbovePrompt', props: bandProps })
      expect((await row(ui))).toBe(' cache unknown no request yet · keepwarm off')
      await $.turn.complete(turn())
      expect((await row(ui))).toBe(' cache warm 1:00:00 left · keepwarm off')
      await pass(clock, ui, 18 * MIN + 48 * 1000)
      expect((await row(ui))).toBe(' cache warm 41:12 left · keepwarm off')
      await pass(clock, ui, 1000)
      expect((await row(ui))).toBe(' cache warm 41:11 left · keepwarm off')
      expect((await ui.find({ type: 'Text', text: /^warm$/, in: CLIENT }))?.props.color).toBe('success')
      await pass(clock, ui, 36 * MIN + 11 * 1000)
      expect((await ui.find({ type: 'Text', text: /^5:00 left$/, in: CLIENT }))?.props.color).toBe('warning')
      await pass(clock, ui, 5 * MIN)
      expect((await row(ui))).toBe(' cache cold expired 0m ago · keepwarm off')
      expect((await ui.find({ type: 'Text', text: /^cold$/, in: CLIENT }))?.props.color).toBe('#d97757')
      await pass(clock, ui, 12 * MIN)
      expect((await row(ui))).toMatch(/expired 12m ago/)
      expect(w.forks.length).toBe(0)
    })

    test(`${surface}: keepwarm shows its next ping, and a ping restarts both countdowns`, { timeoutMs: 60000 }, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [warm], { clock: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cc-hud', surface, component: 'AbovePrompt', props: bandProps })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h'))
      expect((await row(ui))).toBe(' cache warm 1:00:00 left · keepwarm ping in 50:00 · window 3h00m')
      await pass(clock, ui, 10 * MIN)
      expect((await row(ui))).toBe(' cache warm 50:00 left · keepwarm ping in 40:00 · window 2h50m')
      await pass(clock, ui, 40 * MIN)
      expect(w.forks.length).toBe(1)
      expect((await row(ui))).toBe(' cache warm 1:00:00 left · keepwarm ping in 50:00 · window 2h10m · last ping just now read 200k $0.05')
      await pass(clock, ui, 2 * MIN)
      expect((await row(ui))).toBe(' cache warm 58:00 left · keepwarm ping in 48:00 · window 2h08m · last ping 2m ago read 200k $0.05')
    })

    test(`${surface}: hide and /cache-clock switch it per session; off brings back cache-tax's own row`, async ($, on) => {
      mock.clock(on, { now: START })
      const store = new Map<string, unknown>()
      world(on, [], { store, clock: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cc-hud', surface, component: 'AbovePrompt', props: bandProps })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      expect((await row(ui))).toMatch(/keepwarm ping in 50:00/)
      await ui.press({ key: 'cache-clock-hide' })
      expect(await shown(ui)).toBe(false)
      expect(store.get('clock:S1')).toBe(false)
      expect((await cacheLine(ui))).toMatch(/warm.*ping in 50m/)
      expect((await $.command.run(run('cache-clock', 'on'))).text).toBe('cache clock on for this session.')
      expect((await row(ui))).toMatch(/keepwarm ping in 50:00/)
      expect((await $.command.run(run('cache-clock', ''))).text).toBe('cache clock off for this session; /cache-clock on brings it back.')
      expect(store.get('clock:S1')).toBe(false)
      expect((await $.command.run(run('cache-clock', 'default off'))).text).toBe('new sessions start with the cache clock off; this session stays off (/cache-clock on|off)')
      expect(store.get('clock-default')).toBe(false)
      expect((await $.command.run(run('cache-clock', 'status'))).text).toBe('cache clock off in this session, off by default for new sessions.')
      expect((await $.command.run(run('cache-clock', 'sideways'))).text).toBe('/cache-clock takes on, off, default on, default off or status')
      expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/clock row   off in this session/)
    })

    test(`${surface}: the keepwarm switch goes on and off, marking the one in force`, async ($, on) => {
      mock.clock(on, { now: START })
      const store = new Map<string, unknown>()
      const w = world(on, [], { store, clock: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cc-hud', surface, component: 'AbovePrompt', props: bandProps })
      await $.turn.complete(turn())
      // The one in force is the primary Button; the other is plain and dim.
      const marked = async () => (await Promise.all(['on', 'off'].map(async k => (await ui.find({ key: `cache-keepwarm-${k}` }))?.props.variant === 'primary' ? k : null))).filter(Boolean)
      expect(await marked()).toEqual(['off'])
      expect(await ui.find({ key: 'cache-keepwarm-always' })).toBe(undefined)
      await ui.press({ key: 'cache-keepwarm-on' })
      expect(await row(ui)).toBe(' cache warm 1:00:00 left · keepwarm ping in 50:00 · for this session')
      expect(store.get('deadline:S1')).toBe(START + 20 * 24 * HOUR)
      expect(store.get('session:S1')).toBe(true)
      expect(store.has('always')).toBe(false)
      expect(await marked()).toEqual(['on'])
      // Pressing the one in force changes nothing.
      await ui.press({ key: 'cache-keepwarm-on' })
      expect(await marked()).toEqual(['on'])
      await ui.press({ key: 'cache-keepwarm-off' })
      expect(await row(ui)).toBe(' cache warm 1:00:00 left · keepwarm off')
      expect(store.has('deadline:S1')).toBe(false)
      expect(store.has('session:S1')).toBe(false)
      expect(await marked()).toEqual(['off'])
      expect(w.forks.length).toBe(0)
    })
  }

  test('a new session starts with keepwarm off', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map<string, unknown>(), clock: true })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ key: 'cache-keepwarm-off' }))?.props.variant).toBe('primary')
    expect(await row(ui)).toBe(' cache unknown no request yet · keepwarm off')
  })

  test('/keepwarm always turns it on at every session start, and off ends that', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    world(on, [], { store, clock: true })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ key: 'cache-keepwarm-on' }))?.props.variant).toBe('primary')
    expect(await row(ui)).toBe(' cache unknown no request yet · keepwarm on · waiting for the first turn · for this session')
    await ui.press({ key: 'cache-keepwarm-off' })
    expect(store.has('always')).toBe(false)
    expect(await row(ui)).toBe(' cache unknown no request yet · keepwarm off')
  })

  test('on, on a cold cache, sends nothing until the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [warm], { clock: true })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000 })
    await ui.press({ key: 'cache-keepwarm-on' })
    expect((await row(ui))).toBe(' cache cold expired 1h00m ago · keepwarm on · first ping 50m after the next turn · for this session')
    await pass(clock, ui, 55 * MIN)
    expect(w.forks.length).toBe(0)
  })

  test('a session keeps its own choice over the default', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map<string, unknown>([['clock-default', false], ['clock:S1', true]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await row(ui))).toBe(' cache unknown no request yet · keepwarm off')
  })

  test('a new session takes the default off and stays quiet', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map<string, unknown>([['clock-default', false], ['clock:other', true]]) })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await shown(ui)).toBe(false)
  })

  test('a survey keeps the band', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { clock: true, bandText: 'survey' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, hasSurvey: true } })
    expect(await shown(ui)).toBe(false)
    expect((await ui.find({ text: 'survey' }))?.text).toBe('survey')
  })

  test('a surface with no band says so and keeps the plain status', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { clock: true })
    await $.session.start({ ...session, surface: 'vscode' })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m'))
    expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 50m')
    expect((await $.command.run(run('cache-clock', 'on'))).text).toBe('cache clock on for this session. It draws in the terminal and the desktop app; this surface has no row above the prompt.')
    expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 50m')
    expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/clock row   on in this session \(\/cache-clock on\|off\); not drawn here, the row shows in the terminal and the desktop app only$/)
  })

  // The desktop app hosts the session through the SDK: session.start says surface null, and its client attaches after.
  const sdk: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

  test('desktop app: the row draws and ticks once the desktop client attaches after session start', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { clock: true })
    await $.session.start(sdk)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    expect(w.status.at(-1)).toBe(undefined)
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect((await row(ui))).toBe(' cache unknown no request yet · keepwarm off')
    await $.turn.complete(turn())
    await pass(clock, ui, 10 * 1000)
    expect((await row(ui))).toBe(' cache warm 59:50 left · keepwarm off')
    expect((await $.command.run(run('cache-clock', 'status'))).text).toBe('cache clock on in this session, on by default for new sessions.')
  })

  test('desktop app: a reload finds the client already attached', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { clock: true, surfaces: ['desktop'] })
    await $.session.start(sdk)
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await pass(clock, ui, 10 * 1000)
    expect((await row(ui))).toBe(' cache warm 59:50 left · keepwarm off')
  })

  test('desktop app: a draw asked before any attach still shows the row, and the next turn starts the tick', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { clock: true })
    await $.session.start(sdk)
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect((await row(ui))).toBe(' cache unknown no request yet · keepwarm off')
    expect(await ui.find({ type: 'Svg' })).not.toBe(undefined)
    await $.turn.complete(turn())
    await pass(clock, ui, 10 * 1000)
    expect((await row(ui))).toBe(' cache warm 59:50 left · keepwarm off')
  })

  test('desktop app: an attach after the first draw still clears the status line pinned before it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { clock: true, store: new Map<string, unknown>([['always', true]]) })
    await $.session.start(sdk)
    expect(w.status.at(-1)).toBe('keepwarm on for this session · waiting for the first turn')
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await row(ui)).toBe(' cache unknown no request yet · keepwarm on · waiting for the first turn · for this session')
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('desktop app: when the desktop client leaves a phone watching, keepwarm goes back to the status line', async ($, on) => {
    mock.clock(on, { now: START })
    const surfaces: Array<'desktop' | 'mobile'> = ['desktop']
    const w = world(on, [], { clock: true, surfaces })
    await $.session.start(sdk)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m'))
    surfaces.push('mobile')
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })
    surfaces.splice(0, 1)
    await $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' })
    expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 50m')
  })

  test('the keepwarm switch says what it armed and what a ping costs', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { clock: true })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await ui.press({ key: 'cache-keepwarm-on' })
    await ui.press({ key: 'cache-keepwarm-off' })
    expect(w.toasts).toEqual([
      'keepwarm on for this session; each ping reads the cache, about $0.05 at this context',
      'keepwarm off',
    ])
  })

  test('off and on again while a ping is out sends no second ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    // The ping's fork answers five seconds late; while it is out the window goes off and on again.
    const w = world(on, [warm], { clock: true, duringFork: async () => {
      await $.command.run(run('keepwarm', 'off'))
      await $.command.run(run('keepwarm', ''))
      await clock.sleep(5000)
    } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(10 * 1000)
    expect(w.forks.length).toBe(1)
    // The ping out re-armed from its readback: the next one is 50 minutes after it.
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(2)
  })

  test('/clear reads the new session\'s own choice, and its toggles write its own key', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const sid = { value: 'S1' }
    world(on, [], { store, clock: true, sid })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await ui.press({ key: 'cache-clock-hide' })
    expect(store.get('clock:S1')).toBe(false)
    // S2 never chose, so it takes the default (on), not S1's off.
    sid.value = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    expect((await row(ui))).toBe(' cache unknown no request yet · keepwarm off')
    await $.command.run(run('cache-clock', 'default off'))
    sid.value = 'S3'
    await $.classic.SessionStart({ source: 'clear' })
    expect(await shown(ui)).toBe(false)
    expect((await $.command.run(run('cache-clock', 'status'))).text).toBe('cache clock off in this session, off by default for new sessions.')
    await $.command.run(run('cache-clock', 'on'))
    expect([...store.entries()].filter(([key]) => key.startsWith('clock:'))).toEqual([['clock:S1', false], ['clock:S3', true]])
  })

  test('an in-process resume takes the resumed session\'s choice, and off stops the tick', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['clock:R', false]])
    const sid = { value: 'S1' }
    const w = world(on, [], { store, clock: true, sid })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    expect((await row(ui))).toBe(' cache warm 1:00:00 left · keepwarm off')
    sid.value = 'R'
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, context_tokens: 200000 })
    expect(await shown(ui)).toBe(false)
    const from = w.renders.n
    await pass(clock, ui, 10 * 1000)
    expect(w.renders.n).toBe(from)
    await $.command.run(run('cache-clock', 'on'))
    expect(store.get('clock:R')).toBe(true)
    expect(store.has('clock:S1')).toBe(false)
    expect((await row(ui))).toBe(' cache warm 49:50 left · keepwarm off')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: the Buttons are not drawn again while the countdown ticks, only when the cache turns cold`, { timeoutMs: 60000 }, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [], { clock: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cc-hud', surface, component: 'AbovePrompt', props: bandProps })
      await $.turn.complete(turn())
      // A read draws what the turn invalidated, so the count starts after it.
      expect(await row(ui)).toBe(' cache warm 1:00:00 left · keepwarm off')
      const from = w.renders.n
      // Three minutes take in the Client's minute checks of its time: none redraws the tree.
      await pass(clock, ui, 3 * MIN + 10 * 1000)
      expect(await row(ui)).toBe(' cache warm 56:50 left · keepwarm off')
      expect(w.renders.n).toBe(from)
      await pass(clock, ui, 56 * MIN + 50 * 1000)
      expect(await row(ui)).toBe(' cache cold expired 0m ago · keepwarm off')
      expect(w.renders.n).toBe(from + 1)
      if (surface === 'terminal') expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.cold.png })
      else expect((await ui.find({ type: 'Svg' }))?.props.source).toEqual(statusIcons.dark.cold.svg)
    })
  }

  test('a frame clock that paused catches up at the next minute ask', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { clock: true })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    // A hidden window: ten minutes pass while the surface's frame clock moves one.
    await clock.advance(10 * MIN)
    await ui.advance(MIN)
    expect(await row(ui)).toBe(' cache warm 50:00 left · keepwarm off')
  })

  test('a ping that comes due mid-turn says it waits for the turn, and the turn\'s end re-arms it', { timeoutMs: 60000 }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { clock: true })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await pass(clock, ui, 10 * MIN)
    await step($)
    expect((await row(ui))).toBe(' cache warm 1:00:00 left · keepwarm ping in 50:00 · window 2h50m')
    // The timer armed before the step comes due at 50m and stands down: the turn is still open.
    await pass(clock, ui, 40 * MIN)
    expect(w.forks.length).toBe(0)
    expect((await row(ui))).toBe(' cache warm 20:00 left · keepwarm waits for this turn to finish · window 2h10m')
    await $.turn.complete(turn({ durationMs: 40 * MIN + 5000 }))
    expect((await row(ui))).toBe(' cache warm 20:00 left · keepwarm ping in 10:00 · window 2h10m')
    await pass(clock, ui, 10 * MIN)
    expect(w.forks.length).toBe(1)
    expect((await row(ui))).toBe(' cache warm 1:00:00 left · keepwarm ping in 50:00 · window 2h00m · last ping just now read 200k $0.05')
  })

  test('a ping still out when /clear runs does not mark the new conversation warm', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const sid = { value: 'S1' }
    const w = world(on, [warm], { clock: true, sid, duringFork: async () => { sid.value = 'S2'; await $.classic.SessionStart({ source: 'clear' }) } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await pass(clock, ui, 50 * MIN)
    expect(w.forks.length).toBe(1)
    expect((await row(ui))).toBe(' cache unknown no request yet · keepwarm off')
    expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/state       no request yet this session/)
  })
})

describe('agents pane with a workflow of agents', () => {
  const paneProps = { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } } as RenderPropsOf['Pane']
  const agentAt = (i: number, status: AgentInfo['status']): AgentInfo => ({ id: `a${i}`, description: `write:b${i}:docs`, type: 'workflow-subagent', status })
  const hasSprite = async (pane: Mounted<'desktop', 'Pane'>, id: string) => JSON.stringify((await pane.find({ key: `agent-${id}` }))?.children ?? []).includes('"type":"Svg"')

  test('keeps the newest 100 agents, lets a dropped one go for good, and keeps the tree small', async ($, on) => {
    mock.clock(on, { now: START })
    // 150 agents the engine lists that this load never saw spawned, all stopped by a usage limit.
    const list = Array.from({ length: 150 }, (_, i) => agentAt(i + 1, 'killed'))
    world(on, [], { store: new Map(), detailed: false, agents: list })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const pane = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'Pane', requestId: 'hud-agents', props: paneProps } as never) as Mounted<'desktop', 'Pane'>
    const rows = async () => (await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('agent-open-a')).length
    expect(await rows()).toBe(100)
    expect(await pane.find({ key: 'agent-a150' })).toBeDefined()
    expect(await pane.find({ key: 'agent-a51' })).toBeDefined()
    expect(await pane.find({ key: 'agent-a50' })).toBeUndefined()
    // A redraw lists the same agents: the 50 let go do not come back as new and push others out.
    await pane.press({ key: 'agent-open-main' })
    await pane.press({ key: 'agent-open-main' })
    expect(await rows()).toBe(100)
    expect(await pane.find({ key: 'agent-a50' })).toBeUndefined()
    expect(await pane.find({ key: 'agent-a150' })).toBeDefined()
    // Twelve sprites at most; the other rows wear their costume's emoji. 150 agents drew about 2.2 MB before; 100 rows now about 160 K.
    expect(await pane.findAll({ type: 'Svg' })).toHaveLength(12)
    expect(JSON.stringify(await pane.drawn()).length).toBeLessThan(200_000)
  })

  test('gives the sprites to Claude (main) and the running agents before the newest finished ones', async ($, on) => {
    mock.clock(on, { now: START })
    // The oldest five still run; fifteen newer ones have finished.
    const list = Array.from({ length: 20 }, (_, i) => agentAt(i + 1, i < 5 ? 'running' : 'completed'))
    world(on, [], { store: new Map(), detailed: false, agents: list })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const pane = await $.ui.mount({ plugin: 'cc-hud', surface: 'desktop', component: 'Pane', requestId: 'hud-agents', props: paneProps } as never) as Mounted<'desktop', 'Pane'>
    expect(await pane.findAll({ type: 'Svg' })).toHaveLength(12)
    expect(await hasSprite(pane, 'main')).toBe(true)
    for (const i of [1, 2, 3, 4, 5]) expect(await hasSprite(pane, `a${i}`)).toBe(true)
    // Six sprites are left for the finished: the newest six, a20 down to a15.
    for (const i of [20, 15]) expect(await hasSprite(pane, `a${i}`)).toBe(true)
    for (const i of [14, 6]) expect(await hasSprite(pane, `a${i}`)).toBe(false)
    expect((await pane.find({ key: 'agent-a6' }))?.text?.startsWith(SKIN_GLYPH[skinOf('workflow-subagent', 'write:b6:docs')])).toBe(true)
  })
})

test('a sprite draws each run of same-colored pixels as one rect', () => {
  const svg = spriteSvg('chef', 'running')
  const rects = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="[^"]+"\/>/g)]
  expect(rects.length).toBeGreaterThan(0)
  expect(rects.some(r => Number(r[3]) > 1)).toBe(true)
  // No two rects cover the same pixel.
  const covered = new Set<string>()
  for (const r of rects) for (let i = 0; i < Number(r[3]); i++) {
    const at = `${Number(r[1]) + i},${r[2]}`
    expect(covered.has(at)).toBe(false)
    covered.add(at)
  }
  expect(svg.length).toBeLessThan(7000)
})
