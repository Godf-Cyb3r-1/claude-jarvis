/** Two-part text confirmation for destructive actions, enforced in code (the model cannot skip it). */

export type GatedAction = {
  kind: string
  /** Plain-words description read back to the user. */
  readback: string
  /** The real target (path, branch, command, plugin name). */
  target: string
  run: () => Promise<string>
}

export type GateResult =
  | { type: "none" }
  | { type: "say"; text: string }
  | { type: "done"; text: string }
  | { type: "cancelled"; text: string }

const TTL_MS = 2 * 60 * 1000
const MIN_STEP2_DELAY_MS = 3000

const DESTRUCTIVE: { kind: string; re: RegExp }[] = [
  { kind: "delete", re: /\brm\s+(-[a-z]*\s+)*[^\s]|\brmdir\b|\bunlink\b|\bdelete\b|\bremove (the )?(file|folder|directory)|\bshred\b|\bwipe\b|\btruncate\b/i },
  { kind: "force-push", re: /git\s+push\b[^\n]*(--force|-f\b|--force-with-lease)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|rewrite (the )?history|git\s+filter-(branch|repo)/i },
  { kind: "unknown-script", re: /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh|\bsudo\b|\bchmod\s+-R\b|\bdd\s+if=|\bmkfs\b|run (this|the|an?) (unknown |downloaded )?script/i },
  { kind: "permissions", re: /(widen|grant|allow)[^\n]{0,30}permission|permission[^\n]{0,20}(\*|all|everything)/i },
  { kind: "database", re: /\bdrop\s+(table|database)\b|\bdelete\s+from\b/i },
]

/** Returns the destructive kind of an instruction, or undefined when it is safe. */
export function classify(text: string): string | undefined {
  return DESTRUCTIVE.find((d) => d.re.test(text))?.kind
}

function lastWord(target: string) {
  const words = target.replace(/[`"']/g, "").split(/[\s/\\]+/).filter(Boolean)
  return (words.at(-1) ?? target).toLowerCase()
}

function firstWord(target: string) {
  const words = target.replace(/[`"']/g, "").split(/[\s/\\]+/).filter(Boolean)
  return (words[0] ?? target).toLowerCase()
}

type Pending = { action: GatedAction; created: number; stage: 1 | 2; challengeAt?: number; phrase: string; word: string }

export class ConfirmGate {
  private pending?: Pending
  constructor(private now: () => number = Date.now) {}

  get active() {
    return !!this.pending && this.now() - this.pending.created < TTL_MS
  }

  summary() {
    if (!this.pending) return undefined
    return { kind: this.pending.action.kind, readback: this.pending.action.readback, stage: this.pending.stage }
  }

  /** Start a confirmation. Replaces any earlier pending one. Returns the read-back to show the user. */
  request(action: GatedAction): string {
    const phrase = `confirm ${action.kind} ${firstWord(action.target)}`
    this.pending = { action, created: this.now(), stage: 1, phrase, word: lastWord(action.target) }
    return `${action.readback} This needs your confirmation. Type exactly: ${phrase}`
  }

  cancel() {
    this.pending = undefined
  }

  /**
   * Feed every user message here first. A confirmation applies to one action only, expires after 2 minutes,
   * and any non-matching reply cancels it. A bare "yes" never counts.
   */
  async handle(userText: string): Promise<GateResult> {
    const p = this.pending
    if (!p) return { type: "none" }
    const t = userText.trim().toLowerCase().replace(/\s+/g, " ")
    if (this.now() - p.created >= TTL_MS) {
      this.pending = undefined
      return { type: "cancelled", text: "That confirmation timed out, so I cancelled it. Nothing was changed." }
    }
    if (p.stage === 1) {
      if (t !== p.phrase) {
        this.pending = undefined
        return { type: "cancelled", text: "That didn't match, so I cancelled it. Nothing was changed." }
      }
      p.stage = 2
      p.challengeAt = this.now()
      return { type: "say", text: `Second check: type the last word of the target, "${p.word}", to go ahead.` }
    }
    if (this.now() - (p.challengeAt ?? 0) < MIN_STEP2_DELAY_MS) {
      return { type: "say", text: "Take a moment and read the target again, then type the word." }
    }
    if (t !== p.word) {
      this.pending = undefined
      return { type: "cancelled", text: "That wasn't the word, so I cancelled it. Nothing was changed." }
    }
    this.pending = undefined
    const text = await p.action.run()
    return { type: "done", text }
  }
}

/** Pick the thing a destructive instruction acts on: a path-like token if there is one, else the last words. */
export function targetOf(text: string): string {
  const paths = text.match(/(?:~\/|\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]*)+|\b[\w-]+\.[a-z]{1,5}\b/gi)
  if (paths?.length) return paths.slice(0, 3).join(" ")
  const words = text.replace(/[^\p{L}\p{N}_ -]/gu, " ").split(/\s+/).filter(Boolean)
  return words.slice(-3).join(" ") || text.slice(0, 40)
}
