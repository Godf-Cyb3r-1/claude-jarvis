import type { OpencodeClient, OpencodeEvent, ModelRef } from "./opencode"
import { Ledger, keywordsOf, type Card } from "./ledger"

export type WorkerState = "starting" | "running" | "waiting" | "done" | "failed" | "interrupted" | "queued"

export type Worker = {
  session: string
  title: string
  agent?: string
  model?: string
  state: WorkerState
  instruction: string
  summary: string
  tools: number
  lastTool?: string
  error?: string
  startedAt: number
  permissions: { id: string; action: string; resources: string[] }[]
}

export type StartSpec = { title: string; instruction: string; agent?: string; model?: string }

export type WorkerNote =
  | { kind: "finished"; worker: Worker }
  | { kind: "failed"; worker: Worker }
  | { kind: "needs-user"; worker: Worker; detail: string }
  | { kind: "started"; worker: Worker }
  | { kind: "changed" }

export const parseModelRef = (s: string): ModelRef => {
  const i = s.indexOf("/")
  if (i <= 0) throw new Error(`Model must look like provider/model, got "${s}"`)
  const [id, variant] = s.slice(i + 1).split("#")
  return { providerID: s.slice(0, i), id, ...(variant ? { variant } : {}) }
}

const ACTIVE: WorkerState[] = ["starting", "running", "waiting"]

export class Workers {
  readonly map = new Map<string, Worker>()
  readonly queue: StartSpec[] = []
  constructor(
    private client: OpencodeClient,
    private ledger: Ledger,
    private notify: (n: WorkerNote) => void,
    readonly max = 4,
    private directory?: string,
  ) {}

  get activeCount() {
    return [...this.map.values()].filter((w) => ACTIVE.includes(w.state)).length
  }

  list() {
    return [...this.map.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  async start(spec: StartSpec): Promise<{ queued: boolean; worker?: Worker; position?: number }> {
    if (this.activeCount >= this.max) {
      this.queue.push(spec)
      this.notify({ kind: "changed" })
      return { queued: true, position: this.queue.length }
    }
    const model = spec.model ? parseModelRef(spec.model) : undefined
    const s = await this.client.createSession({ title: spec.title, agent: spec.agent, model, directory: this.directory })
    const w: Worker = {
      session: s.id, title: spec.title, agent: spec.agent, model: spec.model, state: "starting",
      instruction: spec.instruction, summary: "", tools: 0, startedAt: Date.now(), permissions: [],
    }
    this.map.set(w.session, w)
    this.ledger.upsert({ session_id: w.session, title: w.title, goal: spec.instruction.slice(0, 240), keywords: keywordsOf(`${spec.title} ${spec.instruction}`), state: "running" })
    await this.client.prompt(w.session, spec.instruction)
    this.notify({ kind: "started", worker: w })
    return { queued: false, worker: w }
  }

  /** Find a worker by session id, title fragment, or a memory-card match. */
  resolve(ref: string): Worker | undefined {
    if (this.map.has(ref)) return this.map.get(ref)
    const low = ref.toLowerCase()
    const byTitle = this.list().find((w) => w.title.toLowerCase().includes(low) || low.includes(w.title.toLowerCase()))
    if (byTitle) return byTitle
    const card = this.ledger.find(ref, 1)[0]
    return card ? this.map.get(card.session_id) : undefined
  }

  /** Resolve to a session id even when the worker is not tracked here (an older session from the ledger). */
  resolveId(ref: string): string | undefined {
    return this.resolve(ref)?.session ?? this.ledger.get(ref)?.session_id ?? this.ledger.find(ref, 1)[0]?.session_id
  }

  private async drain() {
    while (this.queue.length && this.activeCount < this.max) {
      const next = this.queue.shift()!
      try { await this.start(next) } catch (e) { this.notify({ kind: "changed" }); console.error("queued start failed:", e) }
    }
  }

  onEvent(ev: OpencodeEvent) {
    const sid = ev.data?.sessionID as string | undefined
    if (!sid) return
    const w = this.map.get(sid)
    if (!w) return
    switch (ev.type) {
      case "session.execution.started":
        w.state = "running"; break
      case "session.text.delta":
        w.summary = (w.summary + (ev.data?.delta ?? "")).slice(-1500); break
      case "session.tool.input.started":
        w.tools++; w.lastTool = ev.data?.name; break
      case "session.execution.succeeded":
        w.state = "done"; this.finish(w, "finished"); return
      case "session.execution.failed":
        w.state = "failed"; w.error = JSON.stringify(ev.data?.error ?? "").slice(0, 300); this.finish(w, "failed"); return
      case "session.execution.interrupted":
        w.state = "interrupted"; this.finish(w, undefined); return
      case "permission.asked": {
        const p = { id: ev.data?.id as string, action: String(ev.data?.action ?? ""), resources: (ev.data?.resources as string[]) ?? [] }
        w.permissions.push(p); w.state = "waiting"
        this.notify({ kind: "needs-user", worker: w, detail: `${p.action} ${p.resources.join(", ")}`.trim() })
        return
      }
      case "permission.replied":
        w.permissions = w.permissions.filter((p) => p.id !== ev.data?.requestID)
        if (!w.permissions.length && w.state === "waiting") w.state = "running"
        break
      default:
        return
    }
    this.notify({ kind: "changed" })
  }

  private finish(w: Worker, kind: "finished" | "failed" | undefined) {
    this.ledger.upsert({ session_id: w.session, state: w.state === "done" ? "done" : w.state === "failed" ? "failed" : "interrupted", outcome: (w.error ?? w.summary).slice(-300) })
    if (kind === "finished") this.notify({ kind: "finished", worker: w })
    else if (kind === "failed") this.notify({ kind: "failed", worker: w })
    else this.notify({ kind: "changed" })
    void this.drain()
  }

  describe(w: Worker) {
    return { session: w.session, title: w.title, agent: w.agent, model: w.model, state: w.state, summary: w.error ? `error: ${w.error}` : w.summary.slice(-300).replace(/\s+/g, " "), tools: w.tools, lastTool: w.lastTool, waitingFor: w.permissions.map((p) => ({ request: p.id, what: `${p.action} ${p.resources.join(", ")}` })) }
  }
}

export type { Card }
