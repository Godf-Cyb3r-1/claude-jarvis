import { mkdir } from "node:fs/promises"
import path from "node:path"

export type ModelRef = { providerID: string; id: string; variant?: string }

export type OpencodeEvent = { id?: string; type: string; data?: Record<string, any>; created?: number }

/** Thin HTTP client for the opencode server API (routes taken from packages/protocol/src/groups). */
export class OpencodeClient {
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
    if (!res.ok) throw new Error(`opencode ${method} ${route} -> ${res.status} ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : undefined) as T
  }

  info() { return this.req("GET", "/api/info") }
  async agents(): Promise<{ id: string; name: string; description?: string; mode: string; hidden?: boolean }[]> {
    const r = await this.req("GET", "/api/agent")
    return r?.data ?? r ?? []
  }
  async models(): Promise<{ id: string; providerID: string; name: string; variants: { id: string }[]; enabled?: boolean }[]> {
    const r = await this.req("GET", "/api/model")
    return r?.data ?? r ?? []
  }
  async createSession(input: { title?: string; agent?: string; model?: ModelRef; directory?: string }): Promise<{ id: string; title?: string }> {
    const r = await this.req("POST", "/api/session", {
      title: input.title,
      agent: input.agent,
      model: input.model,
      location: input.directory ? { directory: input.directory } : undefined,
    })
    return r.data
  }
  prompt(sessionID: string, text: string) { return this.req("POST", `/api/session/${sessionID}/prompt`, { text }) }
  interrupt(sessionID: string) { return this.req("POST", `/api/session/${sessionID}/interrupt`) }
  switchAgent(sessionID: string, agent: string) { return this.req("POST", `/api/session/${sessionID}/agent`, { agent }) }
  switchModel(sessionID: string, model: ModelRef) { return this.req("POST", `/api/session/${sessionID}/model`, { model }) }
  compact(sessionID: string) { return this.req("POST", `/api/session/${sessionID}/compact`, {}) }
  command(sessionID: string, name: string, text = "") { return this.req("POST", `/api/session/${sessionID}/command`, { name, text }) }
  permissionReply(sessionID: string, requestID: string, decision: "once" | "always" | "reject") {
    return this.req("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, { decision })
  }
  async generate(prompt: string, model?: ModelRef): Promise<string> {
    const r = await this.req("POST", "/api/experimental/generate/text", { prompt, model })
    return r.data.text
  }

  /** Server-sent events from /api/event. Reconnects until `signal` aborts. */
  async subscribe(onEvent: (e: OpencodeEvent) => void, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const res = await this.fetcher(this.baseUrl.replace(/\/$/, "") + "/api/event", { headers: this.headers({ accept: "text/event-stream" }), signal })
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
            try { onEvent(JSON.parse(data)) } catch {}
          }
        }
      } catch {
        if (signal.aborted) return
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

/** Start `opencode serve` on a free port with a random password, or attach to a given server. */
export async function launchOpencode(opts: { directory: string; bin?: string; url?: string; password?: string }) {
  if (opts.url) return { client: new OpencodeClient(opts.url, opts.password), stop: () => {} }
  const bin = opts.bin ?? process.env.JARVIS_OPENCODE_BIN ?? "opencode"
  if (!Bun.which(bin)) {
    throw new Error(
      `Could not find "${bin}" on PATH. Install opencode first (curl -fsSL https://opencode.ai/install | bash), or pass --opencode-url and --opencode-password to attach to a running server.`,
    )
  }
  await mkdir(opts.directory, { recursive: true })
  const password = crypto.randomUUID().replaceAll("-", "")
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = probe.port
  probe.stop(true)
  const proc = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: opts.directory,
    env: { ...process.env, OPENCODE_PASSWORD: password },
    stdout: "pipe",
    stderr: "pipe",
  })
  const url = await new Promise<string>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("opencode did not report a listening URL within 60s")), 60_000)
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return reject(new Error("opencode exited before it was ready: " + buf.slice(-400)))
      buf += dec.decode(value, { stream: true })
      const m = /server listening on (https?:\/\/\S+)/.exec(buf)
      if (m) { clearTimeout(timer); resolve(m[1]); break }
    }
    ;(async () => { for (;;) { const r = await reader.read(); if (r.done) break } })()
  })
  return { client: new OpencodeClient(url, password), stop: () => proc.kill(), dir: path.resolve(opts.directory) }
}
