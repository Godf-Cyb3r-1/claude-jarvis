import { PERSONA } from "./persona"
import type { OpencodeClient, ModelRef } from "./opencode"
import type { Card } from "./ledger"
import { sanitizeTags, stripTagsInCode } from "./tags"

export type BrainAction = { tool: string; args: Record<string, any> }
export type BrainReply = { say: string; actions: BrainAction[]; remember: string[]; tags: string[]; dropped: string[] }

/** One stateless text generation. Real impl calls opencode; tests inject a script. */
export interface BrainLLM {
  generate(prompt: string): Promise<string>
  info(): { model: string; variant?: string; thinkingOff: boolean; note?: string }
}

const OFF = [/^(none|off|disabled?|no-?think(ing)?|non-?think(ing)?|nothink)$/i, /^minimal$/i, /^low$/i]
const DEFAULT_BRAIN = "opencode/deepseek-v4.1-flash-free"

/**
 * Resolve the brain model from opencode's own model list (never trusting a hardcoded ID) and pick the
 * variant that switches reasoning off. How a given model exposes that is not documented, so the choice is
 * reported in `info()` and logged: the user can see whether thinking really is off.
 */
export async function resolveBrain(client: OpencodeClient, wanted = process.env.JARVIS_BRAIN_MODEL ?? DEFAULT_BRAIN, fallbacks: string[] = (process.env.JARVIS_BRAIN_FALLBACKS ?? "").split(",").filter(Boolean)): Promise<BrainLLM> {
  const list = await client.models().catch(() => [])
  const find = (ref: string) => {
    const [providerID, ...rest] = ref.split("/")
    const id = rest.join("/")
    return list.find((m) => m.providerID === providerID && m.id === id) ??
      list.find((m) => m.providerID === providerID && m.id.toLowerCase().includes(id.toLowerCase().replace(/-free$/, "")) && /free/i.test(m.id) === /free/i.test(id))
  }
  const chain = [wanted, ...fallbacks]
  let model = chain.map(find).find(Boolean)
  let note: string | undefined
  if (!model) {
    note = `Model ${wanted} was not found in opencode's model list; using opencode's default model.`
  }
  const variant = model ? OFF.map((re) => model!.variants?.find((v) => re.test(v.id))).find(Boolean)?.id : undefined
  const ref: ModelRef | undefined = model ? { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) } : undefined
  const thinkingOff = !!variant || (!!model && (model.variants?.length ?? 0) === 0)
  if (model && !variant && model.variants?.length) note = `No variant that turns thinking off was found for ${model.providerID}/${model.id} (variants: ${model.variants.map((v) => v.id).join(", ")}). The prompt asks for direct answers instead.`
  return {
    generate: (prompt) => client.generate(prompt, ref),
    info: () => ({ model: ref ? `${ref.providerID}/${ref.id}` : "(opencode default)", variant, thinkingOff, note }),
  }
}

export type PromptContext = {
  profile: Record<string, string>
  notes: string[]
  cards: Card[]
  workers: { session: string; title: string; agent?: string; model?: string; state: string; summary: string }[]
  agents: { id: string; description?: string; mode: string }[]
  history: { role: "user" | "jarvis"; text: string }[]
  toolResults?: string
  event?: string
  user?: string
}

export function buildPrompt(c: PromptContext): string {
  const profile = Object.entries(c.profile).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(nothing yet)"
  const notes = c.notes.map((n) => `- ${n}`).join("\n") || "(none)"
  const cards = c.cards.map((k) => `- [${k.session_id}] ${k.title} (${k.state}) goal: ${k.goal} | keywords: ${k.keywords.join(", ")} | outcome: ${k.outcome}`).join("\n") || "(none matched)"
  const workers = c.workers.map((w) => `- [${w.session}] ${w.title} agent=${w.agent ?? "default"} model=${w.model ?? "default"} state=${w.state} :: ${w.summary || "no output yet"}`).join("\n") || "(no workers running)"
  const agents = c.agents.filter((a) => !a.mode || a.mode !== "subagent" || true).map((a) => `- ${a.id}: ${a.description ?? ""}`).join("\n") || "(unknown)"
  const hist = c.history.slice(-12).map((h) => `${h.role === "user" ? "USER" : "JARVIS"}: ${h.text}`).join("\n")
  return [
    PERSONA,
    `\n=== PROFILE ===\n${profile}\n=== NOTES ABOUT THE USER ===\n${notes}\n=== MEMORY CARDS (matched to the user's message) ===\n${cards}\n=== WORKERS (max 4 at once) ===\n${workers}\n=== AVAILABLE AGENTS ===\n${agents}`,
    `\n=== CONVERSATION ===\n${hist || "(start)"}`,
    c.event ? `\n=== EVENT (speak first about this, once, in one or two sentences) ===\n${c.event}` : "",
    c.user ? `\nUSER: ${c.user}` : "",
    c.toolResults ? `\n=== TOOL RESULTS (use them to answer; do not call the same tool again) ===\n${c.toolResults}` : "",
    "\nAnswer directly. Do not deliberate. Reply with the single JSON object only.",
  ].join("\n")
}

function firstJson(text: string): any | undefined {
  const start = text.indexOf("{")
  if (start < 0) return undefined
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') inStr = true
    else if (ch === "{") depth++
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)) } catch { return undefined }
    }
  }
  return undefined
}

export function parseReply(raw: string): BrainReply {
  const j = firstJson(raw.replace(/```(?:json)?/g, ""))
  const sayRaw = typeof j?.say === "string" ? j.say : j ? "" : raw.trim()
  const s = sanitizeTags(stripTagsInCode(sayRaw))
  const actions: BrainAction[] = Array.isArray(j?.actions)
    ? j.actions.filter((a: any) => a && typeof a.tool === "string").map((a: any) => ({ tool: a.tool, args: a.args && typeof a.args === "object" ? a.args : {} }))
    : []
  const remember: string[] = Array.isArray(j?.remember) ? j.remember.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : []
  return { say: s.text, actions, remember, tags: s.tags, dropped: s.dropped }
}
