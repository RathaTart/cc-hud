// Pixel skins for the agents pane: a fan-drawn pixel Claude critter in Claude's clay, dressed for the work its task
// describes. Drawn for cc-hud; the idea of costumed agents comes from savvy-progress (JohnnyVizz/claude-kit).
// Claude and its mascot are Anthropic's; cc-hud is not affiliated with Anthropic.

export type Skin =
  | 'detective' | 'builder' | 'chef' | 'scientist' | 'astronaut' | 'pirate'
  | 'doctor' | 'judge' | 'knight' | 'scribe' | 'janitor' | 'miner'
  | 'painter' | 'racer' | 'gardener' | 'courier' | 'traveller' | 'guard'
  | 'plain'

/** What each skin is for, as the README and the pane say it. */
export const SKIN_ROLE: Record<Skin, string> = {
  detective: 'searching and reading',
  builder: 'building and fixing',
  chef: 'writing, summarizing and listing',
  scientist: 'testing and checking',
  astronaut: 'planning and research',
  pirate: 'exploring',
  doctor: 'debugging',
  judge: 'code review',
  knight: 'security',
  scribe: 'docs',
  janitor: 'refactoring and cleanup',
  miner: 'data and analysis',
  painter: 'UI and styling',
  racer: 'performance',
  gardener: 'git and branches',
  courier: 'deploys and releases',
  traveller: 'translation',
  guard: 'watching and monitoring',
  plain: 'anything else',
}

/** A terminal has no SVG: each skin is one glyph there. */
export const SKIN_GLYPH: Record<Skin, string> = {
  detective: '🔍', builder: '🔧', chef: '🍳', scientist: '🧪', astronaut: '🚀', pirate: '⚓',
  doctor: '🩺', judge: '⚖️', knight: '🛡️', scribe: '📜', janitor: '🧹', miner: '⛏️',
  painter: '🎨', racer: '🏁', gardener: '🌱', courier: '📦', traveller: '🌍', guard: '🏮',
  plain: '✳',
}

// The words that dress an agent. The match that comes earliest in the task wins ("Summarize the test names" is the
// chef's), and a tie goes to the earlier rule, so the more specific skins sit first.
const RULES: ReadonlyArray<[Skin, RegExp]> = [
  ['knight', /\b(security|secure|vulnerab\w*|cve|exploit\w*|auth|authenticat\w*|secrets?|credentials?|permissions?|xss|injection)\b/i],
  ['doctor', /\b(debug\w*|diagnos\w*|errors?|crash\w*|bugs?|broken|stack ?traces?|exceptions?)\b/i],
  ['judge', /\b(review\w*|pr|pull requests?|critique|approve)\b/i],
  ['scientist', /\b(test|tests|testing|verify|validat\w*|check|checks|benchmark\w*|qa|audit\w*)\b/i],
  ['racer', /\b(optimi[sz]\w*|perf|performance|speed\w*|profil\w*|latency|faster|slow)\b/i],
  ['gardener', /\b(git|merge\w*|branch\w*|commits?|rebase\w*|cherry-pick\w*|stash)\b/i],
  ['courier', /\b(deploy\w*|release\w*|ship\w*|publish\w*|upload\w*|push)\b/i],
  ['janitor', /\b(refactor\w*|clean\w*|rename\w*|tidy|lint\w*|format\w*|dead code|simplif\w*)\b/i],
  ['scribe', /\b(docs?|readme|document\w*|comments?|changelog|jsdoc|docstrings?)\b/i],
  ['painter', /\b(ui|css|styl\w*|frontend|front-end|layout\w*|themes?|colou?rs?|icons?|animations?)\b/i],
  ['traveller', /\b(translat\w*|i18n|locali[sz]\w*|languages?)\b/i],
  ['miner', /\b(data|dataset\w*|sql|quer(y|ies)|metrics?|analy[sz]\w*|csv|database\w*|stats|statistics)\b/i],
  ['guard', /\b(monitor\w*|watch\w*|poll\w*|wait\w*|observ\w*|keep an eye)\b/i],
  ['builder', /\b(fix|fixes|build|implement\w*|edit|edits|add|create|code|migrat\w*|install|setup|set up|patch)\b/i],
  ['astronaut', /\b(plan|plans|planning|design|architect\w*|research\w*|investigat\w*|propos\w*|strateg\w*)\b/i],
  ['pirate', /\b(explore|exploring|scout\w*|browse|web|survey|map)\b/i],
  ['detective', /\b(find|search\w*|look\w*|read|count|scan\w*|grep|locate|inspect\w*|trace)\b/i],
  ['chef', /\b(summar\w*|list|lists|name|names|write|draft\w*|collect\w*|compil\w*|describe|explain\w*|generat\w*)\b/i],
]

/** The skin for an agent: its type first (Explore scouts, Plan plans), then the earliest telling word of its task. */
export function skinOf(type: string, task: string): Skin {
  const bare = type.replace(/^[^:]*:/, '')
  if (/^explore$/i.test(bare)) return 'pirate'
  if (/^plan$/i.test(bare)) return 'astronaut'
  let best: { skin: Skin; at: number } | null = null
  for (const [skin, re] of RULES) {
    const at = task.search(re)
    if (at >= 0 && (!best || at < best.at)) best = { skin, at }
  }
  return best?.skin ?? 'plain'
}

/** The main Claude's costume: what its current tool does, a Bash command by its words, else the plain critter. */
export function skinForTool(tool: string, detail: string): Skin {
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(tool)) return 'detective'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'builder'
  if (/^(WebFetch|WebSearch)$/.test(tool)) return 'pirate'
  if (/^(Agent|Task|Workflow)$/.test(tool)) return 'astronaut'
  if (/^(TodoWrite|TaskCreate|TaskUpdate)$/.test(tool)) return 'scribe'
  if (/^(Bash|PowerShell)$/.test(tool)) {
    const skin = skinOf('general-purpose', detail)
    return skin === 'plain' ? 'builder' : skin
  }
  return 'plain'
}

const W = 20
const H = 16

// The critter on a 20×16 grid: a wide clay body, two tall dark eyes, stubby arms at its sides and four short legs.
// `.` is clear, `b` the body, `e` an eye. Rows 0 to 4 stay clear for hats; columns 0 to 3 and 16 to 19 for props.
const BASE = [
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....bbbbbbbbbbbb....',
  '....bbbbbbbbbbbb....',
  '....bbebbbbbbebb....',
  '....bbebbbbbbebb....',
  '..bbbbbbbbbbbbbbbb..',
  '..bbbbbbbbbbbbbbbb..',
  '....bbbbbbbbbbbb....',
  '....bbbbbbbbbbbb....',
  '.....b.b....b.b.....',
  '.....b.b....b.b.....',
  '....................',
]

/** How a costume's prop or effect moves while its agent works. */
type Motion = 'swing' | 'tap' | 'sweep' | 'stir' | 'wave' | 'twinkle' | 'flicker' | 'drip' | 'spin' | 'float'

/**
 * A costume: rows of pixels over the critter and their colors. `prop` names the characters of the thing it holds,
 * which moves by `motion`; `fx` names a glint, a light or drops, which move by `fxMotion`. The rest rides the body.
 */
type Outfit = { rows: string[]; palette: Record<string, string>; prop?: string; motion?: Motion; fx?: string; fxMotion?: Motion }

// Each costume lays its own pixels over the critter; a space leaves the critter's pixel showing.
const OUTFITS: Record<Skin, Outfit> = {
  // A deerstalker, and a magnifier held out to the right.
  detective: {
    rows: [
      '', '',
      '       hhhhhh',
      '     hhHhhhhHhh',
      '   ddddddddddddddd',
      '', '',
      '                kk',
      '               kggk',
      '               kggk',
      '                kk',
      '               w',
      '              w',
    ],
    palette: { h: '#7A4A26', H: '#A0703F', d: '#5A3519', k: '#3A3A3C', g: '#A9D6F5', w: '#7A4A26' },
    prop: 'kgw', motion: 'sweep',
  },
  // A hard hat with its brim, and a wrench in the left hand.
  builder: {
    rows: [
      '', '',
      '       yyyyyy',
      '     yyyyYYyyyy',
      '   YYYYYYYYYYYYYY',
      '', '',
      ' s s',
      ' sss',
      '  s',
      '  s',
    ],
    palette: { y: '#F5C542', Y: '#C99A1E', s: '#8E929A' },
    prop: 's', motion: 'swing',
  },
  // A tall white toque, and a wooden spoon.
  chef: {
    rows: [
      '      wwwwwwww',
      '     wwwwwwwwww',
      '     wwwwwwwwww',
      '      wwwwwwww',
      '      gggggggg',
      '',
      '                 nn',
      '                 nn',
      '                 n',
      '                 n',
      '                 n',
    ],
    palette: { w: '#F4F3EE', g: '#D2D1C8', n: '#B07A45' },
    prop: 'n', motion: 'stir',
  },
  // Goggles over the eyes, and a green flask.
  scientist: {
    rows: [
      '', '', '', '', '', '',
      '    GGGGGGGGGGGG',
      '     GoG    GoG',
      '     GoG    GoG',
      '                 t',
      '                 t',
      '                fff',
      '               fFFFf',
      '               fFFFf',
      '                fff',
    ],
    palette: { G: '#6FC3DF', o: '#1F1E1D', t: '#C9CCD2', f: '#C9CCD2', F: '#7BD389' },
    prop: 'tfF', motion: 'tap',
  },
  // A glass helmet with an antenna, and a star.
  astronaut: {
    rows: [
      '         a       *',
      '         a      ***',
      '         a       *',
      '   dddddddddddddd',
      '  d              d',
      '  d              d',
      '  d              d',
      '  d              d',
      ' d                d',
      ' d                d',
      '  dddddddddddddddd',
    ],
    palette: { a: '#C9CCD2', d: '#A9D6F5', '*': '#F5C542' },
    fx: '*', fxMotion: 'twinkle',
  },
  // A red bandana with white dots, an eye patch, and a cutlass.
  pirate: {
    rows: [
      '', '', '',
      '    rrrrrrrrrrrrr',
      '   rrwrrrwrrrwrrrrr',
      '    k',
      '     kk',
      '      kk',
      '      kk',
      '                 c',
      '                 c',
      '                 c',
      '                ccc',
      '                 n',
    ],
    palette: { r: '#C0392B', w: '#F8F6F1', k: '#1F1E1D', c: '#C9CCD2', n: '#7A4A26' },
    prop: 'cn', motion: 'swing',
  },
  // A head mirror on a white band, and a stethoscope round the neck.
  doctor: {
    rows: [
      '', '',
      '        mmmm',
      '        mMMm',
      '    hhhhmmmmhhhh',
      '', '', '', '', '',
      '      s      s',
      '       s    s',
      '        ssss',
      '          c',
    ],
    palette: { m: '#C9CCD2', M: '#F4F3EE', h: '#F4F3EE', s: '#3A3A3C', c: '#8E929A' },
    prop: 'c', motion: 'sweep', fx: 'M', fxMotion: 'twinkle',
  },
  // A curly white wig, and a gavel.
  judge: {
    rows: [
      '',
      '      wwwwwwww',
      '     wWwWwWwWww',
      '    wwwwwwwwwwww',
      '   wWwwwwwwwwwwWw',
      '   w            w',
      '   W            W',
      '   w            w',
      '   W            W',
      '',
      '                 nnn',
      '                 nnn',
      '                  g',
      '                  g',
    ],
    palette: { w: '#F4F3EE', W: '#D2D1C8', n: '#7A4A26', g: '#5A3519' },
    prop: 'ng', motion: 'tap',
  },
  // A plumed helmet with cheek guards, and a shield.
  knight: {
    rows: [
      '         rr',
      '        rrr',
      '      gggggggg',
      '     gGGGGGGGGg',
      '    gggggggggggg',
      '    g          g',
      '    g          g',
      '',
      'BByBB',
      'yyyyy',
      'BByBB',
      ' ByB',
      '  B',
    ],
    palette: { g: '#8E929A', G: '#C9CCD2', r: '#C0392B', B: '#3B6FB6', y: '#F5C542' },
    prop: 'r', motion: 'wave',
  },
  // Round reading glasses, and a feather quill.
  scribe: {
    rows: [
      '', '', '', '',
      '                 ff',
      '                 fF',
      '     ooo    ooo  fF',
      '     o oooooo o  ff',
      '     o o    o o   k',
      '     ooo    ooo',
    ],
    palette: { o: '#3A3A3C', f: '#F4F3EE', F: '#D2D1C8', k: '#1F1E1D' },
    prop: 'fFk', motion: 'sweep',
  },
  // A blue cap, and a broom.
  janitor: {
    rows: [
      '', '', '',
      ' n    cccccccc',
      ' n   cccccccccCCC',
      ' n',
      ' n',
      ' n',
      ' n',
      ' n',
      ' n',
      'yyy',
      'yyy',
      'yYy',
    ],
    palette: { c: '#3B6FB6', C: '#2A4F86', n: '#7A4A26', y: '#E3B85B', Y: '#C99A1E' },
    prop: 'nyY', motion: 'sweep',
  },
  // A mining helmet with its lamp lit, and a pickaxe.
  miner: {
    rows: [
      '', '',
      '       hhhhhh',
      '      hhhLLhhh',
      '    HHHHHHHHHHHH',
      '',
      '              ppppp',
      '             p  k  p',
      '                k',
      '                k',
      '                k',
    ],
    palette: { h: '#F5C542', H: '#C99A1E', L: '#FFF7C2', p: '#8E929A', k: '#7A4A26' },
    prop: 'pk', motion: 'swing', fx: 'L', fxMotion: 'flicker',
  },
  // A purple beret, and a paintbrush dipped in red.
  painter: {
    rows: [
      '',
      '          s',
      '      bbbbbbbb',
      '     bbbbbbbbbbb',
      '      BBBBBBBBBB',
      '                  r',
      '                 rr',
      '                 nn',
      '                 k',
      '                 k',
      '                 k',
      '                 k',
    ],
    palette: { b: '#7D4CB0', B: '#5E3790', s: '#5E3790', r: '#E5534B', n: '#C9CCD2', k: '#7A4A26' },
    prop: 'rnk', motion: 'swing',
  },
  // A striped racing helmet, and a checkered flag.
  racer: {
    rows: [
      '', '',
      'wkwp  rrrrrrrr',
      'kwkp rrrrWWrrrr',
      'wkwprrrrrWWrrrrr',
      '   p',
      '   p',
      '   p',
      '   p',
      '   p',
      '   p',
      '   p',
      '   p',
    ],
    palette: { r: '#E5534B', w: '#F8F6F1', W: '#F8F6F1', k: '#1F1E1D', p: '#8E929A' },
    prop: 'wk', motion: 'wave',
  },
  // A wide straw hat with a sprout, and a watering can.
  gardener: {
    rows: [
      '',
      '         gg',
      '       tttttt',
      '      tTTTTTTt',
      '  tttttttttttttttt',
      '', '', '', '', '',
      '                cccs',
      '                ccc',
      '                cccw',
      '                   w',
    ],
    palette: { t: '#E3C27A', T: '#C9A04F', c: '#4F9D69', s: '#4F9D69', w: '#6FC3DF', g: '#7BD389' },
    prop: 'cs', motion: 'tap', fx: 'w', fxMotion: 'drip',
  },
  // A courier's cap, and a taped parcel.
  courier: {
    rows: [
      '', '', '',
      '      cccccccc',
      '     cccccccccCCC',
      '', '', '', '',
      'xtxx',
      'tttt',
      'xtxx',
      'xtxx',
    ],
    palette: { c: '#6B4A2B', C: '#4A3220', x: '#C9955B', t: '#8A6A3F' },
    prop: 'xt', motion: 'tap',
  },
  // A sun hat with a red band, and a small globe.
  traveller: {
    rows: [
      '', '',
      '       hhhhhh',
      '       rrrrrr',
      '   hhhhhhhhhhhhhh',
      '', '', '', '',
      '                 bb',
      '                bggb',
      '                bbgb',
      '                 bb',
    ],
    palette: { h: '#E3C27A', r: '#C0392B', b: '#3B6FB6', g: '#4F9D69' },
    prop: 'bg', motion: 'spin',
  },
  // A night watchman's cap with a badge, and a lit lantern.
  guard: {
    rows: [
      '', '', '',
      '      nnnnnnnn',
      '    NNNNNyNNNNNN',
      '', '', '',
      ' k',
      'kLk',
      'kLk',
      'kkk',
    ],
    palette: { n: '#2A3550', N: '#1E2740', y: '#F5C542', k: '#3A3A3C', L: '#FFD86B' },
    fx: 'L', fxMotion: 'flicker',
  },
  plain: { rows: [], palette: {} },
}

// Status costumes, laid over whatever the agent wears.
/** Just finished: a party hat and confetti, for a few seconds. */
const PARTY: Outfit = {
  rows: [
    '    c    P      c',
    '        pPp   c',
    '  c    pPpPp',
    '      pPpPpPp    c',
    '     yyyyyyyyy',
  ],
  palette: { p: '#E5534B', P: '#F5C542', y: '#7D4CB0', c: '#6FC3DF' },
  fx: 'c', fxMotion: 'twinkle',
}
/** Waiting on something: eyes shut to a line, and a floating z. */
const SLEEPING: Outfit = {
  rows: [
    '                zzzz',
    '                  z',
    '                 z',
    '                zzzz',
    '', '',
    '',
    '      b      b',
    '     ee     ee',
  ],
  palette: { z: '#C9CCD2', e: '#1F1E1D' },
  fx: 'z', fxMotion: 'float',
}
/** Failed or stopped: knocked out, with crossed eyes and a puff of smoke. The eyes' own pixels are cleared first. */
const KNOCKED_OUT: Outfit = {
  rows: [
    '                 ss',
    '               ssss',
    '                ss',
    '', '', '',
    '     x x    x x',
    '      x      x',
    '     x x    x x',
  ],
  palette: { s: '#BDBDBD', x: '#3A3A3A' },
}

/** The critter keeps Claude's clay while it runs or has finished; a failed or stopped one turns gray, costume and all. */
const BODY = {
  running: { b: '#D97757', e: '#1F1E1D' },
  done: { b: '#D97757', e: '#1F1E1D' },
  failed: { b: '#9A9A9A', e: '#9A9A9A' },
} as const

export type SpriteState = keyof typeof BODY
/** Momentary looks: `waiting` closes the eyes; `party` swaps the costume for a party hat. */
export type SpriteMood = { isWaiting?: boolean; isParty?: boolean }

/** A color as the gray of the same lightness, for a costume on a knocked-out critter. */
function gray(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const l = Math.round(0.3 * (n >> 16) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255))
  const v = Math.round(110 + (l / 255) * 100).toString(16).padStart(2, '0')
  return `#${v}${v}${v}`
}

// One stylesheet for every sprite: steps, not easing, so the pixels hop like a sprite sheet. Only a sprite drawn
// with the `run` class moves, and none does for someone who asked their system for less motion.
const MOTION_CSS = `<style>
.cch-run .cch-body{animation:cch-bob .8s steps(1,end) infinite}
.cch-run .cch-la{animation:cch-step .8s steps(1,end) infinite}
.cch-run .cch-lb{animation:cch-step .8s steps(1,end) -.4s infinite}
.cch-run .cch-swing{transform-box:fill-box;transform-origin:50% 100%;animation:cch-swing .8s steps(1,end) infinite}
.cch-run .cch-tap{animation:cch-tap .6s steps(1,end) infinite}
.cch-run .cch-sweep{animation:cch-sweep 1.2s steps(1,end) infinite}
.cch-run .cch-stir{transform-box:fill-box;transform-origin:50% 0;animation:cch-stir 1s steps(1,end) infinite}
.cch-run .cch-wave{animation:cch-wave .5s steps(1,end) infinite}
.cch-run .cch-spin{transform-box:fill-box;transform-origin:50% 50%;animation:cch-spin 1.2s steps(1,end) infinite}
.cch-run .cch-twinkle,.cch-party .cch-twinkle{animation:cch-twinkle 1s steps(1,end) infinite}
.cch-run .cch-flicker{animation:cch-flicker .7s steps(1,end) infinite}
.cch-run .cch-drip{animation:cch-drip .9s steps(1,end) infinite}
.cch-wait .cch-float{animation:cch-float 1.6s steps(1,end) infinite}
@keyframes cch-bob{0%{transform:translateY(0)}50%{transform:translateY(-1px)}}
@keyframes cch-step{0%{transform:translateY(0)}50%{transform:translateY(-1px)}}
@keyframes cch-swing{0%{transform:rotate(-18deg)}50%{transform:rotate(14deg)}}
@keyframes cch-tap{0%{transform:translateY(-1px)}50%{transform:translateY(1px)}}
@keyframes cch-sweep{0%{transform:translateX(0)}25%{transform:translateX(-1px)}50%{transform:translateX(0)}75%{transform:translateX(1px)}}
@keyframes cch-stir{0%{transform:rotate(-12deg)}50%{transform:rotate(12deg)}}
@keyframes cch-wave{0%{transform:translateY(0)}50%{transform:translateY(-1px)}}
@keyframes cch-spin{0%{transform:scaleX(1)}50%{transform:scaleX(-1)}}
@keyframes cch-twinkle{0%{opacity:1}50%{opacity:.25}}
@keyframes cch-flicker{0%{opacity:1}33%{opacity:.55}66%{opacity:.85}}
@keyframes cch-drip{0%{transform:translateY(0);opacity:1}50%{transform:translateY(1px);opacity:.6}}
@keyframes cch-float{0%{transform:translate(0,0);opacity:1}50%{transform:translate(1px,-1px);opacity:.6}}
@media (prefers-reduced-motion:reduce){.cch-run *,.cch-wait *,.cch-party *{animation:none!important}}
</style>`

/** The leg pixels: columns 5 and 12 step together, then 7 and 14. */
const LEG_ROWS = new Set([13, 14])
const legGroup = (x: number): 'cch-la' | 'cch-lb' | null => (x === 5 || x === 12 ? 'cch-la' : x === 7 || x === 14 ? 'cch-lb' : null)

/**
 * The skin as an SVG `width` pixels wide, for the desktop pane. A running agent bobs, walks on the spot and works
 * its prop; a waiting one sleeps, its z floating; a finished one stands still, in a party hat for a moment.
 */
export function spriteSvg(skin: Skin, state: SpriteState, width = 28, mood: SpriteMood = {}): string {
  const body: Record<string, string> = { ...BODY[state] }
  const outfit = mood.isParty ? PARTY : OUTFITS[skin]
  const isFailed = state === 'failed'
  const isWaiting = !!mood.isWaiting && state === 'running'
  const layers: Outfit[] = [isFailed ? { ...outfit, palette: Object.fromEntries(Object.entries(outfit.palette).map(([k, v]) => [k, gray(v)])) } : outfit]
  if (isFailed) layers.push(KNOCKED_OUT)
  if (isWaiting) layers.push({ ...SLEEPING, palette: { ...SLEEPING.palette, b: body.b! } })
  const groups: Record<string, string[]> = { 'cch-body': [], 'cch-la': [], 'cch-lb': [], prop: [], fx: [] }
  let propMotion: Motion | undefined
  let fxMotion: Motion | undefined
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const base = BASE[y]![x]!
      let fill = body[base]
      let group = LEG_ROWS.has(y) && base === 'b' ? legGroup(x) ?? 'cch-body' : 'cch-body'
      for (const layer of layers) {
        const over = layer.rows[y]?.[x]
        if (over === undefined || over === ' ' || !layer.palette[over]) continue
        fill = layer.palette[over]
        group = layer.prop?.includes(over) ? 'prop' : layer.fx?.includes(over) ? 'fx' : 'cch-body'
        if (group === 'prop') propMotion = layer.motion
        if (group === 'fx') fxMotion = layer.fxMotion
      }
      if (fill) groups[group]!.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`)
    }
  }
  const g = (cls: string, rects: string[]) => (rects.length ? `<g class="${cls}">${rects.join('')}</g>` : '')
  const mode = isFailed || state === 'done' ? (mood.isParty ? 'cch-party' : '') : isWaiting ? 'cch-wait' : 'cch-run'
  const height = Math.round((width * H) / W)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${MOTION_CSS}`
    + `<g class="${mode}">${g('cch-la', groups['cch-la']!)}${g('cch-lb', groups['cch-lb']!)}`
    + `<g class="cch-body">${groups['cch-body']!.join('')}${g(`cch-${propMotion ?? 'still'}`, groups.prop!)}</g>`
    + `${g(`cch-${fxMotion ?? 'still'}`, groups.fx!)}</g></svg>`
}

/** Every costume's rows fit the grid: at most 20 columns and 16 rows. */
export function outfitsFit(): boolean {
  return [...Object.values(OUTFITS), PARTY, SLEEPING, KNOCKED_OUT].every(o => o.rows.length <= H && o.rows.every(r => r.length <= W))
}

/** The desktop pane draws each skin this many pixels wide; its height keeps the 20×16 grid. */
export const SPRITE_WIDTH = 30
export const SPRITE_HEIGHT = Math.round((SPRITE_WIDTH * H) / W)
/** How long a finished agent wears the party hat. */
export const PARTY_MS = 6000
