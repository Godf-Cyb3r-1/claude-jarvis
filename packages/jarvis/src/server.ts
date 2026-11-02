import type { Jarvis, JarvisEvent } from "./jarvis"
import type { Ledger } from "./ledger"
import html from "../web/index.html" with { type: "text" }

/** Local Web UI + JSON/SSE API. Binds to loopback only; the page holds no logic, it only shows Jarvis state. */
export function startServer(jarvis: Jarvis, ledger: Ledger, opts: { port: number; hostname?: string }) {
  const enc = new TextEncoder()
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
      if (req.method === "GET" && url.pathname === "/api/state")
        return json({ state: jarvis.snapshot(), history: jarvis.history, cards: ledger.recent(20), profile: ledger.profile(), notes: ledger.notes() })
      if (req.method === "GET" && url.pathname === "/api/events") {
        let off = () => {}
        const stream = new ReadableStream({
          start(c) {
            const send = (e: JarvisEvent) => { try { c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)) } catch { off() } }
            send({ type: "state", state: jarvis.snapshot() })
            off = jarvis.on(send)
            const ping = setInterval(() => { try { c.enqueue(enc.encode(": ping\n\n")) } catch { clearInterval(ping) } }, 15000)
            req.signal.addEventListener("abort", () => { clearInterval(ping); off() })
          },
          cancel() { off() },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = (await req.json().catch(() => ({}))) as { text?: string }
        const text = (body.text ?? "").trim()
        if (!text) return json({ error: "empty message" }, 400)
        if (text.length > 8000) return json({ error: "message too long" }, 400)
        void jarvis.handle(text)
        return json({ ok: true })
      }
      if (req.method === "DELETE" && url.pathname === "/api/profile") { ledger.wipeUser(); return json({ ok: true }) }
      if (req.method === "GET" && url.pathname === "/api/audit") return json(ledger.auditLog())
      return new Response("not found", { status: 404 })
    },
  })
  return server
}
