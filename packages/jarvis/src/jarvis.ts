import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { OpencodeClient } from "./opencode"
import { buildPrompt, parseReply, type BrainAction, type BrainLLM } from "./brain"
import { Ledger, keywordsOf } from "./ledger"
import { ConfirmGate, classify, targetOf } from "./safety"
import { Workers, parseModelRef, type Worker, type WorkerNote } from "./workers"
import { sanitizeTags, stripAllTags } from "./tags"

export type Message = { id: string; role: "user" | "jarvis"; text: string; tags: string[]; at: number; proactive?: boolean }
export type OrbState = "idle" | "thinking" | "replying" | "confirm"
export type Snapshot = ReturnType<Jarvis["snapshot"]>
export type JarvisEvent = { type: "message"; message: Message } | { type: "state"; state: Snapshot } | { type: "pulse"; tag: string }

const QUERY_TOOLS = new Set(["session_status", "agent_list", "model_list", "memory_find"])
const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)

export class Jarvis {
  readonly workers: Workers
  readonly gate: ConfirmGate
  history: Message[] = []
  orb: OrbState = "idle"
  private listeners = new Set<(e: JarvisEvent) => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private seq = 0
  private spoken = new Set<string>()
  private agentsCache: { id: string; description?: string; mode: string }[] = []

  constructor(
    readonly opts: {
      client: OpencodeClient
      brain: BrainLLM
      ledger: Ledger
      directory: string
      maxSessions?: number
      gate?: ConfirmGate
    },
  ) {
    this.gate = opts.gate ?? new ConfirmGate()
    this.workers = new Workers(opts.client, opts.ledger, (n) => this.onWorker(n), opts.maxSessions ?? 4, opts.directory)
  }

  on(fn: (e: JarvisEvent) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit(e: JarvisEvent) { for (const l of this.listeners) l(e) }

  snapshot() {
    return {
      orb: this.orb,
      brain: this.opts.brain.info(),
      workers: this.workers.list().map((w) => this.workers.describe(w)),
      queued: this.workers.queue.length,
      max: this.workers.max,
      confirm: this.gate.summary() ?? null,
    }
  }
  private setOrb(o: OrbState) { this.orb = o; this.emit({ type: "state", state: this.snapshot() }) }

  private push(role: Message["role"], raw: string, proactive = false): Message {
    const s = role === "jarvis" ? sanitizeTags(raw) : { text: raw, tags: [] as string[], dropped: [] as string[] }
    const m: Message = { id: `m${++this.seq}`, role, text: s.text, tags: s.tags, at: Date.now(), proactive: proactive || undefined }
    this.history.push(m)
    this.emit({ type: "message", message: m })
    if (s.tags[0]) this.emit({ type: "pulse", tag: s.tags[0] })
    return m
  }

  /** Serialised: one conversation turn at a time, so history and gating stay consistent. */
  handle(userText: string): Promise<Message[]> {
    const run = this.chain.then(() => this.turn(userText))
    this.chain = run.catch(() => {})
    return run
  }

  private async turn(userText: string): Promise<Message[]> {
    const out: Message[] = []
    this.push("user", userText)
    // A pending confirmation is handled by code, before the model sees anything.
    const g = await this.gate.handle(userText).catch((e) => ({ type: "say" as const, text: `That did not work: ${e instanceof Error ? e.message : e}` }))
    if (g.type !== "none") {
      if (g.type === "done") this.opts.ledger.audit("confirmed", g.text)
      if (g.type === "cancelled") this.opts.ledger.audit("cancelled", g.text)
      out.push(this.push("jarvis", g.text))
      this.setOrb(this.gate.active ? "confirm" : "idle")
      return out
    }
    this.setOrb("thinking")
    try {
      const say = await this.think(userText)
      this.setOrb("replying")
      out.push(this.push("jarvis", say))
    } catch (e) {
      out.push(this.push("jarvis", `My thinking model isn't answering right now (${e instanceof Error ? e.message.slice(0, 160) : e}). Your message is saved; try again in a moment.`))
    }
    this.setOrb(this.gate.active ? "confirm" : "idle")
    return out
  }

  private async context(extra: { user?: string; event?: string; toolResults?: string }) {
    if (!this.agentsCache.length) this.agentsCache = await this.opts.client.agents().catch(() => [])
    const l = this.opts.ledger
    const q = extra.user ?? extra.event ?? ""
    return buildPrompt({
      profile: l.profile(),
      notes: l.notes(),
      cards: q ? l.find(q, 3) : [],
      workers: this.workers.list().map((w) => ({ session: w.session, title: w.title, agent: w.agent, model: w.model, state: w.state, summary: w.summary.slice(-200).replace(/\s+/g, " ") })),
      agents: this.agentsCache,
      history: this.history.filter((m) => !(extra.user && m === this.history.at(-1) && m.role === "user")).map((m) => ({ role: m.role, text: stripAllTags(m.text) })),
      ...extra,
    })
  }

  /** Up to 3 brain rounds: the brain may call query tools and then speak about the results. */
  private async think(userText: string): Promise<string> {
    let toolResults: string | undefined
    let firstSay = ""
    for (let round = 0; round < 3; round++) {
      const prompt = await this.context({ user: userText, toolResults })
      const reply = parseReply(await this.opts.brain.generate(prompt))
      if (reply.dropped.length) this.opts.ledger.audit("tag-dropped", reply.dropped.join(" "))
      for (const n of reply.remember) this.opts.ledger.addNote(n)
      const results: string[] = []
      let gated: string | undefined
      let queried = false
      for (const a of reply.actions) {
        const r = await this.exec(a).catch((e) => ({ text: `error: ${e instanceof Error ? e.message : e}`, gated: undefined as string | undefined }))
        if (r.gated) gated = r.gated
        if (QUERY_TOOLS.has(a.tool)) queried = true
        results.push(`${a.tool}: ${r.text}`)
      }
      if (gated) return gated
      if (!firstSay) firstSay = reply.say
      if (queried && round < 2) { toolResults = results.join("\n"); continue }
      if (results.length && !reply.say) return results.join(" ")
      return reply.say || firstSay || "Done."
    }
    return firstSay || "Done."
  }

  // ---- actions ----
  private async exec(a: BrainAction): Promise<{ text: string; gated?: string }> {
    const x = a.args
    const str = (k: string) => (typeof x[k] === "string" ? (x[k] as string) : "")
    const need = (k: string) => { const v = str(k); if (!v) throw new Error(`missing "${k}" for ${a.tool}`); return v }
    const L = this.opts.ledger
    const guarded = (text: string, label: string, run: () => Promise<string>) => {
      const kind = classify(text)
      if (!kind) return undefined
      const readback = this.gate.request({ kind, readback: `${label}: "${text.slice(0, 200)}".`, target: targetOf(text), run })
      L.audit("gate-requested", `${kind} :: ${text.slice(0, 200)}`)
      return { text: "needs confirmation", gated: readback }
    }

    switch (a.tool) {
      case "session_create": {
        const instruction = need("instruction"); const title = str("title") || instruction.slice(0, 40)
        const run = async () => {
          const r = await this.workers.start({ title, instruction, agent: str("agent") || undefined, model: str("model") || undefined })
          return r.queued ? `All ${this.workers.max} workers are busy, so "${title}" is queued at position ${r.position}.` : `Started "${title}" (${r.worker!.session}).`
        }
        return guarded(instruction, `I'm about to start a worker "${title}" to do`, run) ?? { text: await run() }
      }
      case "session_send": {
        const id = this.workers.resolveId(need("session")); if (!id) throw new Error(`no session matches "${str("session")}"`)
        const instruction = need("instruction")
        const run = async () => { await this.opts.client.prompt(id, instruction); return `Sent to ${id}.` }
        return guarded(instruction, `I'm about to tell session ${id} to do`, run) ?? { text: await run() }
      }
      case "session_status": {
        const w = this.workers.resolve(need("session"))
        if (w) return { text: JSON.stringify(this.workers.describe(w)) }
        const c = L.find(str("session"), 1)[0]
        return { text: c ? JSON.stringify(c) : "no matching session" }
      }
      case "session_interrupt": {
        const id = this.workers.resolveId(need("session")); if (!id) throw new Error("no matching session")
        return { text: JSON.stringify(await this.opts.client.interrupt(id)) }
      }
      case "session_switch_agent": {
        const id = this.workers.resolveId(need("session")); if (!id) throw new Error("no matching session")
        await this.opts.client.switchAgent(id, need("agent")); const w = this.workers.map.get(id); if (w) w.agent = str("agent")
        return { text: `Session ${id} now uses agent ${str("agent")}.` }
      }
      case "session_switch_model": {
        const id = this.workers.resolveId(need("session")); if (!id) throw new Error("no matching session")
        await this.opts.client.switchModel(id, parseModelRef(need("model"))); const w = this.workers.map.get(id); if (w) w.model = str("model")
        return { text: `Session ${id} now uses model ${str("model")}.` }
      }
      case "session_compact": {
        const id = this.workers.resolveId(need("session")); if (!id) throw new Error("no matching session")
        await this.opts.client.compact(id); return { text: `Compaction started for ${id}.` }
      }
      case "command_run": {
        const id = this.workers.resolveId(need("session")); if (!id) throw new Error("no matching session")
        const name = need("name").replace(/^\//, ""); const text = str("text")
        const run = async () => { await this.opts.client.command(id, name, text); return `Ran /${name} on ${id}.` }
        return guarded(`${name} ${text}`, `I'm about to run /${name} on session ${id} with`, run) ?? { text: await run() }
      }
      case "agent_list": {
        this.agentsCache = await this.opts.client.agents()
        return { text: this.agentsCache.map((g) => `${g.id}${g.description ? " - " + g.description : ""}`).join("; ") || "none" }
      }
      case "model_list": {
        const list = await this.opts.client.models()
        return { text: list.filter((m) => m.enabled !== false).slice(0, 40).map((m) => `${m.providerID}/${m.id}`).join(", ") || "none" }
      }
      case "memory_find": {
        const cards = L.find(need("query"), 3)
        return { text: cards.length ? cards.map((c) => `[${c.session_id}] ${c.title} (${c.state}) ${c.goal} -> ${c.outcome}`).join("\n") : "no matching card" }
      }
      case "agent_create": return { text: await this.createAgent(x) }
      case "plugin_create": {
        const name = safeName(need("name")); const code = need("code")
        if (code.length > 20_000) throw new Error("plugin code is too long (limit 20 KB)")
        const file = path.join(this.opts.directory, ".opencode", "plugins", `${name}.ts`)
        const readback = this.gate.request({
          kind: "create-plugin", target: name,
          readback: `I'm about to write a plugin to ${file}. Plugins run code with your permissions. This is the full source:\n${code.slice(0, 1500)}${code.length > 1500 ? "\n..." : ""}\n`,
          run: async () => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, code); return `Plugin ${name} written to ${file}. opencode may need a restart to load it.` },
        })
        L.audit("gate-requested", `create-plugin :: ${name}`)
        return { text: "needs confirmation", gated: readback }
      }
      case "permission_reply": {
        const decision = need("decision") as "once" | "always" | "reject"
        if (!["once", "always", "reject"].includes(decision)) throw new Error("decision must be once, always or reject")
        const id = this.workers.resolveId(need("session")); if (!id) throw new Error("no matching session")
        const run = async () => { await this.opts.client.permissionReply(id, need("request"), decision); return `Permission ${decision} sent to ${id}.` }
        if (decision === "always") {
          const readback = this.gate.request({ kind: "permissions", target: `${id} always`, readback: `I'm about to permanently allow a permission request on session ${id}.`, run })
          return { text: "needs confirmation", gated: readback }
        }
        return { text: await run() }
      }
      default:
        throw new Error(`unknown tool ${a.tool}`)
    }
  }

  private async createAgent(x: Record<string, any>) {
    const name = safeName(String(x.name ?? "")); if (!name) throw new Error("agent name is required")
    const description = String(x.description ?? "").replace(/\n/g, " ").trim(); if (!description) throw new Error("agent description is required")
    const prompt = String(x.prompt ?? "").trim()
    const mode = ["primary", "subagent", "all"].includes(x.mode) ? x.mode : "all"
    const lines = ["---", `description: ${JSON.stringify(description)}`, `mode: ${mode}`]
    if (typeof x.model === "string" && x.model.includes("/")) lines.push(`model: ${x.model}`)
    lines.push("permission:", "  edit: ask", "  bash: ask", "---", "", prompt || `You are ${name}. ${description}`, "")
    const file = path.join(this.opts.directory, ".opencode", "agents", `${name}.md`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, lines.join("\n"))
    this.opts.ledger.audit("agent-created", file)
    for (let i = 0; i < 4; i++) {
      this.agentsCache = await this.opts.client.agents().catch(() => this.agentsCache)
      if (this.agentsCache.some((a) => a.id === name)) return `Agent ${name} created at ${file} and visible to opencode.`
      await new Promise((r) => setTimeout(r, 750))
    }
    return `Agent ${name} written to ${file}, but opencode does not list it yet. It may need a restart before a worker can use it.`
  }

  // ---- worker events: Jarvis speaks first, once ----
  private onWorker(n: WorkerNote) {
    if (n.kind === "changed" || n.kind === "started") { this.emit({ type: "state", state: this.snapshot() }); return }
    const w = n.worker
    const key = `${w.session}:${n.kind}`
    if (this.spoken.has(key)) return
    this.spoken.add(key)
    void this.refreshCard(w).then(() => this.proactive(n)).catch(() => {})
    this.emit({ type: "state", state: this.snapshot() })
  }

  private async refreshCard(w: Worker) {
    const l = this.opts.ledger
    let goal = w.instruction.slice(0, 240), outcome = (w.error ?? w.summary).slice(-300).replace(/\s+/g, " "), keywords = keywordsOf(`${w.title} ${w.instruction} ${w.summary}`)
    try {
      const raw = await this.opts.brain.generate(`Summarise a finished coding session as JSON {"goal": "one sentence", "keywords": ["5 to 12 terms: files, features, errors, in the user's own words"], "outcome": "two sentences: what changed and what is left"}. Reply with JSON only.\nTITLE: ${w.title}\nINSTRUCTION: ${w.instruction}\nLATEST OUTPUT: ${w.summary.slice(-1200)}${w.error ? "\nERROR: " + w.error : ""}`)
      const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1))
      if (typeof j.goal === "string") goal = j.goal
      if (Array.isArray(j.keywords) && j.keywords.length) keywords = j.keywords.map(String).slice(0, 12)
      if (typeof j.outcome === "string") outcome = j.outcome
    } catch {}
    l.upsert({ session_id: w.session, goal, keywords, outcome })
  }

  private proactive(n: Extract<WorkerNote, { kind: "finished" | "failed" | "needs-user" }>) {
    const w = n.worker
    const event = n.kind === "finished" ? `Worker "${w.title}" finished. Latest output: ${w.summary.slice(-300)}`
      : n.kind === "failed" ? `Worker "${w.title}" failed: ${w.error ?? "unknown error"}`
      : `Worker "${w.title}" is waiting for the user's permission: ${n.detail} (session ${w.session}, request ${w.permissions.at(-1)?.id}).`
    const fallback = n.kind === "finished" ? `"${w.title}" is done.` : n.kind === "failed" ? `"${w.title}" hit an error.` : `"${w.title}" needs your OK for: ${n.detail}.`
    this.chain = this.chain.then(async () => {
      let say = fallback
      try { say = parseReply(await this.opts.brain.generate(await this.context({ event }))).say || fallback } catch {}
      this.push("jarvis", say, true)
    }).catch(() => {})
  }
}
