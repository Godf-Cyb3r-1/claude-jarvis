import { mkdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type ModelRef = { providerID: string; id: string; variant?: string }

export type OpencodeEvent = { id?: string; type: string; data?: Record<string, any>; created?: number }

/** An HTTP error from the opencode server, with the status kept so callers can react to 404s. */
export class OpencodeHttpError extends Error {
  constructor(
    readonly method: string,
    readonly route: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`opencode ${method} ${route} -> ${status} ${body.slice(0, 300)}`)
    this.name = "OpencodeHttpError"
  }
}

/**
 * Thin HTTP client for the opencode server API (routes taken from packages/protocol/src/groups).
 *
 * Two server generations exist in the wild:
 *  - 2.0+: the /api routes Jarvis was written against. 2.0/2.1 only have the legacy one-shot
 *    generate path; 2.2 moved it to /api/experimental/generate/text.
 *  - 1.18.x: the /api surface exists but does not execute prompts, so this client uses its /session
 *    routes instead. Those servers are still useful because their free models are not metered like
 *    the 2.x ones. `isLegacy()` detects the generation once and every call adapts.
 */
export class OpencodeClient {
  /** Stateless generation moved from /api/experimental/generate to .../text in 2.2. */
  static readonly GENERATE_ROUTES = ["/api/experimental/generate/text", "/api/experimental/generate"] as const
  private generateRoute?: string
  private legacyMode?: boolean
  private legacySessions = new Map<string, { agent?: string; model?: ModelRef }>()
  private legacyDefaultModel?: ModelRef
  private legacyDefaultResolved = false
  private emitEvent?: (e: OpencodeEvent) => void

  constructor(
    readonly baseUrl: string,
    private password?: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      "content-type": "application/json",
      ...(this.password ? { authorization: "Basic " + btoa(`opencode:${this.password}`) } : {}),
      ...extra,
    }
  }

  async req<T = any>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(this.baseUrl.replace(/\/$/, "") + route, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new OpencodeHttpError(method, route, res.status, text)
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(
        `opencode ${method} ${route} returned ${res.status} but the body was not JSON. Body starts with: ${text.slice(0, 120).replace(/\s+/g, " ")}`,
      )
    }
  }

  /**
   * 2.x answers /api/info. 1.18.x has no /api/info (the web UI answers with HTML) but does expose
   * /api/health. Detect once; a server that answers neither is treated as 2.x so its real error shows.
   */
  async isLegacy(): Promise<boolean> {
    if (this.legacyMode !== undefined) return this.legacyMode
    try {
      await this.req("GET", "/api/info")
      this.legacyMode = false
    } catch {
      this.legacyMode = await this.req("GET", "/api/health").then(() => true).catch(() => false)
    }
    return this.legacyMode
  }

  async info(): Promise<Record<string, any>> {
    if (!(await this.isLegacy())) return this.req("GET", "/api/info")
    const health = await this.req<{ healthy?: boolean }>("GET", "/api/health")
    return { version: "1.x (legacy /session API)", healthy: health?.healthy ?? true }
  }

  async agents(): Promise<{ id: string; name?: string; description?: string; mode: string; hidden?: boolean }[]> {
    const r = await this.req("GET", "/api/agent")
    return r?.data ?? r ?? []
  }
  async models(): Promise<{ id: string; providerID: string; name: string; variants: { id: string }[]; enabled?: boolean }[]> {
    const r = await this.req("GET", "/api/model")
    return r?.data ?? r ?? []
  }
  async createSession(input: { title?: string; agent?: string; model?: ModelRef; directory?: string }): Promise<{ id: string; title?: string }> {
    if (await this.isLegacy()) {
      // 1.x fails a turn when the session has no model, so fall back to the first free one.
      const model = input.model ?? await this.defaultLegacyModel()
      const r = await this.req("POST", "/session", { title: input.title, agent: input.agent, model })
      const s = r.data ?? r
      this.legacySessions.set(s.id, { agent: input.agent, model })
      return { id: s.id, title: s.title ?? input.title }
    }
    const r = await this.req("POST", "/api/session", {
      title: input.title,
      agent: input.agent,
      model: input.model,
      location: input.directory ? { directory: input.directory } : undefined,
    })
    return r.data
  }
  async prompt(sessionID: string, text: string) {
    if (!(await this.isLegacy())) return this.req("POST", `/api/session/${sessionID}/prompt`, { text })
    const cfg = this.legacySessions.get(sessionID)
    // 1.x message calls block until the whole turn is done. Workers are tracked through events, so
    // start the call and return immediately; a failure is surfaced as an execution.failed event.
    void this.req("POST", `/session/${sessionID}/message`, legacyMessage(text, cfg?.model, cfg?.agent)).catch((e) => {
      this.emitEvent?.({ type: "session.execution.failed", data: { sessionID, error: { message: String(e?.message ?? e) } } })
    })
    return { admitted: true }
  }
  async interrupt(sessionID: string) {
    if (await this.isLegacy()) return this.req("POST", `/session/${sessionID}/abort`)
    return this.req("POST", `/api/session/${sessionID}/interrupt`)
  }
  async switchAgent(sessionID: string, agent: string) {
    if (await this.isLegacy()) {
      const cfg = this.legacySessions.get(sessionID) ?? {}
      this.legacySessions.set(sessionID, { ...cfg, agent })
      return { agent }
    }
    return this.req("POST", `/api/session/${sessionID}/agent`, { agent })
  }
  async switchModel(sessionID: string, model: ModelRef) {
    if (await this.isLegacy()) {
      const cfg = this.legacySessions.get(sessionID) ?? {}
      this.legacySessions.set(sessionID, { ...cfg, model })
      return { model }
    }
    return this.req("POST", `/api/session/${sessionID}/model`, { model })
  }
  async compact(sessionID: string) {
    if (await this.isLegacy()) {
      const model = this.legacySessions.get(sessionID)?.model
      if (!model) throw new Error("opencode 1.x needs an explicit model to compact a session; switch the session to one first")
      return this.req("POST", `/session/${sessionID}/summarize`, { providerID: model.providerID, modelID: model.id })
    }
    return this.req("POST", `/api/session/${sessionID}/compact`, {})
  }
  async command(sessionID: string, name: string, text = "") {
    if (await this.isLegacy()) return this.req("POST", `/session/${sessionID}/command`, { command: name, arguments: text })
    return this.req("POST", `/api/session/${sessionID}/command`, { name, text })
  }
  async permissionReply(sessionID: string, requestID: string, decision: "once" | "always" | "reject") {
    if (await this.isLegacy()) return this.req("POST", `/session/${sessionID}/permissions/${requestID}`, { response: decision })
    return this.req("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, { decision })
  }

  async generate(prompt: string, model?: ModelRef): Promise<string> {
    if (await this.isLegacy()) return this.generateLegacy(prompt, model)
    const order = this.generateRoute
      ? [this.generateRoute, ...OpencodeClient.GENERATE_ROUTES.filter((r) => r !== this.generateRoute)]
      : [...OpencodeClient.GENERATE_ROUTES]
    let last: unknown
    for (const route of order) {
      try {
        const r = await this.req<{ data: { text: string } }>("POST", route, { prompt, model })
        this.generateRoute = route
        return r.data.text
      } catch (e) {
        last = e
        // A 404 means this server does not have this route; try the other one. Anything else is a real failure.
        if (!(e instanceof OpencodeHttpError) || e.status !== 404) throw e
      }
    }
    if (last instanceof OpencodeHttpError && last.status === 404) {
      throw new Error(
        `This opencode server (${this.baseUrl}) has no stateless generate endpoint. Jarvis needs opencode 2.x or 1.18.x; run \`opencode --version\` and update it, or point JARVIS_OPENCODE_BIN at a supported binary.`,
      )
    }
    throw last
  }

  /** 1.18.x has no stateless generate: run one turn in a throwaway session and delete it. */
  private async generateLegacy(prompt: string, model?: ModelRef): Promise<string> {
    const chosen = model ?? await this.defaultLegacyModel()
    const created = await this.req("POST", "/session", chosen ? { model: chosen } : {})
    const sessionID = (created.data ?? created).id as string
    try {
      const res = await this.req<{ parts?: { type: string; text?: string }[] }>("POST", `/session/${sessionID}/message`, legacyMessage(prompt, chosen))
      return (res.parts ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("")
    } finally {
      await this.req("DELETE", `/session/${sessionID}`).catch(() => {})
    }
  }

  /** First enabled free model on a 1.18.x server, cached. */
  private async defaultLegacyModel(): Promise<ModelRef | undefined> {
    if (this.legacyDefaultResolved) return this.legacyDefaultModel
    const list = await this.models().catch(() => [])
    const model = list.find((m) => m.providerID === "opencode" && /-free$/.test(m.id) && m.enabled !== false) ??
      list.find((m) => m.enabled !== false)
    this.legacyDefaultModel = model ? { providerID: model.providerID, id: model.id } : undefined
    this.legacyDefaultResolved = true
    return this.legacyDefaultModel
  }

  /** Server-sent events from /api/event (2.x) or /event (1.18.x). Reconnects until `signal` aborts. */
  async subscribe(onEvent: (e: OpencodeEvent) => void, signal: AbortSignal) {
    this.emitEvent = onEvent
    const legacy = await this.isLegacy()
    const route = legacy ? "/event" : "/api/event"
    const partTypes = new Map<string, string>()
    while (!signal.aborted) {
      try {
        const res = await this.fetcher(this.baseUrl.replace(/\/$/, "") + route, { headers: this.headers({ accept: "text/event-stream" }), signal })
        if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`)
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")
            if (!data) continue
            try {
              const ev = JSON.parse(data)
              if (legacy) for (const translated of translateLegacyEvent(ev, partTypes)) onEvent(translated)
              else onEvent(ev)
            } catch {}
          }
        }
      } catch {
        if (signal.aborted) return
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

/** 1.x message payload: {providerID, modelID}, with the variant at the top level. */
function legacyMessage(text: string, model?: ModelRef, agent?: string) {
  return {
    parts: [{ type: "text", text }],
    ...(model ? { model: { providerID: model.providerID, modelID: model.id }, ...(model.variant ? { variant: model.variant } : {}) } : {}),
    ...(agent ? { agent } : {}),
  }
}

/** 1.18.x event names and shapes -> the 2.x names Jarvis tracks. */
function translateLegacyEvent(ev: any, partTypes: Map<string, string>): OpencodeEvent[] {
  const p = ev?.properties ?? {}
  switch (ev?.type) {
    case "session.status":
      return p.status?.type === "busy" ? [{ type: "session.execution.started", data: { sessionID: p.sessionID } }] : []
    case "session.idle":
      return [{ type: "session.execution.succeeded", data: { sessionID: p.sessionID } }]
    case "session.error":
      return [{ type: "session.execution.failed", data: { sessionID: p.sessionID, error: p.error ?? p } }]
    case "message.part.updated": {
      const part = p.part ?? {}
      if (part.id) partTypes.set(part.id, part.type)
      if (part.type !== "tool") return []
      return [{ type: "session.tool.input.started", data: { sessionID: p.sessionID, name: part.tool } }]
    }
    case "message.part.delta":
      // Reasoning parts stream text deltas too; only answer text belongs in the worker summary.
      return p.field === "text" && p.delta && partTypes.get(p.partID) === "text"
        ? [{ type: "session.text.delta", data: { sessionID: p.sessionID, delta: p.delta } }]
        : []
    case "permission.updated":
      return [{
        type: "permission.asked",
        data: {
          sessionID: p.sessionID,
          id: p.id,
          action: p.title ?? p.type ?? "permission",
          resources: [p.metadata?.command, p.metadata?.path].filter(Boolean),
        },
      }]
    case "permission.replied":
      return [{ type: "permission.replied", data: { sessionID: p.sessionID, requestID: p.permissionID ?? p.requestID } }]
    default:
      return [{ type: ev?.type ?? "unknown", data: p }]
  }
}

async function isFile(p: string) {
  try { return (await stat(p)).isFile() } catch { return false }
}

/**
 * Where to look for an opencode server binary, in order: an explicit path, JARVIS_OPENCODE_BIN, a binary
 * shipped next to the jarvis executable, the copy install-jarvis.sh downloads, then PATH.
 */
export async function resolveOpencodeBin(explicit?: string) {
  for (const p of [explicit, process.env.JARVIS_OPENCODE_BIN]) {
    if (p) return p
  }
  const bundled = [
    path.join(path.dirname(process.execPath), "opencode"),
    ...(process.env.JARVIS_DATA ? [path.join(process.env.JARVIS_DATA, "bin", "opencode")] : []),
    path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "jarvis", "bin", "opencode"),
  ]
  for (const p of bundled) {
    if (await isFile(p)) return p
  }
  return "opencode"
}

/** Start `opencode serve` on a free port with a random password, or attach to a given server. */
export async function launchOpencode(opts: { directory: string; bin?: string; url?: string; password?: string }) {
  if (opts.url) return { client: new OpencodeClient(opts.url, opts.password), stop: () => {}, url: opts.url }
  const bin = await resolveOpencodeBin(opts.bin)
  if (!Bun.which(bin)) {
    throw new Error(
      `Could not find "${bin}" on PATH. Install opencode first (curl -fsSL https://opencode.ai/v2/install | bash), or pass --opencode-url and --opencode-password to attach to a running server.\n` +
        `Jarvis needs opencode 2.x or 1.18.x; older 1.x servers do not expose the API Jarvis uses.`,
    )
  }
  await mkdir(opts.directory, { recursive: true })
  const password = crypto.randomUUID().replaceAll("-", "")
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = probe.port
  probe.stop(true)
  const version = await binaryVersion(bin)
  // 1.18.x cannot read a database written by 2.x, so give it a private data directory.
  const isolated = !!version && /^v?1\./.test(version)
  const shared = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  const env = { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password }
  if (isolated) env.XDG_DATA_HOME = path.join(shared, "jarvis", "opencode-data")
  const proc = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: opts.directory,
    // 2.x reads OPENCODE_PASSWORD, 1.x reads OPENCODE_SERVER_PASSWORD. Set both so either build is secured.
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  let errBuf = ""
  void (async () => {
    const reader = proc.stderr.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      errBuf += dec.decode(value, { stream: true })
    }
  })()
  const url = await new Promise<string>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("opencode did not report a listening URL within 60s")), 60_000)
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return reject(new Error("opencode exited before it was ready: " + (buf + errBuf).slice(-600)))
      buf += dec.decode(value, { stream: true })
      const m = /server listening on (https?:\/\/\S+)/.exec(buf)
      if (m) { clearTimeout(timer); resolve(m[1]); break }
    }
    ;(async () => { for (;;) { const r = await reader.read(); if (r.done) break } })()
  })
  return { client: new OpencodeClient(url, password), stop: () => proc.kill(), url, bin, version, dir: path.resolve(opts.directory) }
}

/** `opencode --version`, used to pick the data directory and the right launch env. */
async function binaryVersion(bin: string) {
  const resolved = Bun.which(bin)
  if (!resolved) return undefined
  const proc = Bun.spawn([resolved, "--version"], { stdout: "pipe", stderr: "ignore" })
  const out = await new Response(proc.stdout).text().catch(() => "")
  await proc.exited
  return out.trim().split("\n")[0] || undefined
}
