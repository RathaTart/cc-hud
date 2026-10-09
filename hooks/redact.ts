// Hides what looks like a secret before a pane shows a command, a task or an answer: the panes draw on screen,
// where a screenshot or a shared screen would carry a token further than the terminal it was typed in.

const MASK = '•••'

const RULES: ReadonlyArray<[RegExp, string]> = [
  // NAME=value where the name says what it holds: API_KEY=…, GITHUB_TOKEN=…, DB_PASSWORD="…"
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, `$1=${MASK}`],
  // An Authorization header's credentials: Authorization: Bearer …
  [/(authorization\s*:\s*)(bearer\s+|basic\s+|token\s+)?("[^"]*"|'[^']*'|[^\s"']+)/gi, `$1$2${MASK}`],
  // A flag that takes a secret: --password …, --token=…, -p …
  [/(--?(?:password|passwd|pass|token|secret|api[-_]?key|apikey)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
  // Credentials inside a URL: https://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, `$1${MASK}$3`],
  // Token shapes that are secret wherever they appear.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
]

/** `text` with anything that looks like a secret replaced by •••. */
export function redactSecrets(text: string): string {
  return RULES.reduce((t, [re, to]) => t.replace(re, to), text)
}
