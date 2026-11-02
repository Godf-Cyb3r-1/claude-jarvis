import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Jarvis } from "../src/jarvis"
import { Ledger } from "../src/ledger"
import { OpencodeClient } from "../src/opencode"
import { ConfirmGate } from "../src/safety"
import type { BrainLLM } from "../src/brain"

/** A tiny stand-in for the opencode server: records calls, hands out session ids. */
function fakeOpencode() {
  const calls: { method: string; path: string; body?: any }[] = []
  let n = 0
  const agents: any[] = [{ id: "build", name: "build", description: "general coding", mode: "primary" }]
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined
      calls.push({ method: req.method, path: u.pathname, body })
      if (u.pathname === "/api/session" && req.method === "POST") return Response.json({ data: { id: `ses_${++n}` } })
      if (u.pathname === "/api/agent") return Response.json({ data: agents })
      if (u.pathname === "/api/model") return Response.json({ data: [] })
      if (u.pathname.endsWith("/interrupt")) return Response.json({ interrupted: true })
      return new Response(null, { status: 204 })
    },
  })
  return { server, calls, agents, client: new OpencodeClient(`http://127.0.0.1:${server.port}`) }
}

function script(...replies: (string | ((p: string) => string))[]): BrainLLM & { prompts: string[] } {
  const prompts: string[] = []
  let i = 0
  return { prompts, info: () => ({ model: "fake", thinkingOff: true }), async generate(p) { prompts.push(p); const r = replies[Math.min(i++, replies.length - 1)]; return typeof r === "function" ? r(p) : r } }
}
const J = (o: object) => JSON.stringify(o)
const tick = () => new Promise((r) => setTimeout(r, 30))
const tmp = () => mkdtemp(path.join(os.tmpdir(), "jarvis-"))

describe("engine", () => {
  test("delegates to a worker, tracks it, speaks first when it finishes", async () => {
    const oc = fakeOpencode(); const dir = await tmp()
    const brain = script(
      J({ say: "On it. [laughter]", actions: [{ tool: "session_create", args: { title: "login bug", instruction: "fix the login redirect in auth.ts", agent: "build" } }], remember: ["working on auth.ts"] }),
      J({ goal: "fix login redirect", keywords: ["login", "auth.ts"], outcome: "patched" }),
      J({ say: "The login fix is done; tests pass.", actions: [], remember: [] }),
    )
    const j = new Jarvis({ client: oc.client, brain, ledger: new Ledger(), directory: dir })
    const out = await j.handle("fix the login redirect")
    expect(out[0].text).toBe("On it. [laughter]"); expect(out[0].tags).toEqual(["laughter"])
    expect(oc.calls.find((c) => c.path === "/api/session")?.body).toMatchObject({ title: "login bug", agent: "build" })
    expect(oc.calls.some((c) => c.path === "/api/session/ses_1/prompt")).toBe(true)
    expect(j.opts.ledger.notes()).toEqual(["working on auth.ts"])
    j.workers.onEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    j.workers.onEvent({ type: "session.text.delta", data: { sessionID: "ses_1", delta: "all tests pass" } })
    j.workers.onEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    await tick(); await tick()
    expect(j.history.at(-1)).toMatchObject({ role: "jarvis", proactive: true, text: "The login fix is done; tests pass." })
    expect(j.opts.ledger.get("ses_1")).toMatchObject({ state: "done", goal: "fix login redirect" })
    expect(j.opts.ledger.find("that login thing")[0]?.session_id).toBe("ses_1")
    oc.server.stop(true)
  })

  test("at most 4 run at once; the fifth is queued and starts when one finishes", async () => {
    const oc = fakeOpencode(); const dir = await tmp()
    const j = new Jarvis({ client: oc.client, brain: script(J({ say: "ok", actions: [] })), ledger: new Ledger(), directory: dir })
    for (let i = 1; i <= 5; i++) await j.workers.start({ title: `t${i}`, instruction: `do ${i}` })
    expect(j.workers.activeCount).toBe(4); expect(j.workers.queue.length).toBe(1)
    expect(oc.calls.filter((c) => c.path === "/api/session" && c.method === "POST").length).toBe(4)
    j.workers.onEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    await tick(); await tick()
    expect(j.workers.queue.length).toBe(0); expect(j.workers.activeCount).toBe(4)
    oc.server.stop(true)
  })

  test("a destructive instruction never reaches opencode without both confirmations", async () => {
    const oc = fakeOpencode(); const dir = await tmp(); let t = 0
    const brain = script(J({ say: "Sure, deleting it.", actions: [{ tool: "session_create", args: { title: "cleanup", instruction: "delete the build/ folder" } }] }))
    const j = new Jarvis({ client: oc.client, brain, ledger: new Ledger(), directory: dir, gate: new ConfirmGate(() => t) })
    const out = await j.handle("clean up the build output")
    expect(out[0].text).toContain("confirmation"); expect(out[0].text).toContain("confirm delete build")
    expect(oc.calls.some((c) => c.path === "/api/session")).toBe(false)
    expect(j.snapshot().orb).toBe("confirm")
    expect((await j.handle("confirm delete build"))[0].text).toContain("Second check")
    t += 4000
    const done = await j.handle("build")
    expect(done[0].text).toContain("Started")
    expect(oc.calls.some((c) => c.path === "/api/session")).toBe(true)
    oc.server.stop(true)
  })

  test("agent_create writes a narrow agent file; plugin_create is always gated", async () => {
    const oc = fakeOpencode(); const dir = await tmp(); let t = 0
    oc.agents.push({ id: "sql-helper", name: "sql-helper", mode: "all" })
    const brain = script(
      J({ say: "Making one.", actions: [{ tool: "agent_create", args: { name: "SQL Helper", description: "writes safe SQL migrations", prompt: "You write migrations." } }] }),
      J({ say: "Plugin ready.", actions: [{ tool: "plugin_create", args: { name: "notify", code: "export default {}" } }] }),
    )
    const j = new Jarvis({ client: oc.client, brain, ledger: new Ledger(), directory: dir, gate: new ConfirmGate(() => t) })
    await j.handle("I need a SQL migration specialist")
    const md = await readFile(path.join(dir, ".opencode/agents/sql-helper.md"), "utf8")
    expect(md).toContain('description: "writes safe SQL migrations"'); expect(md).toContain("bash: ask")
    const out = await j.handle("make a notify plugin")
    expect(out[0].text).toContain("confirm create-plugin notify")
    await expect(readFile(path.join(dir, ".opencode/plugins/notify.ts"), "utf8")).rejects.toThrow()
    await j.handle("confirm create-plugin notify"); t += 4000
    expect((await j.handle("notify"))[0].text).toContain("written")
    expect(await readFile(path.join(dir, ".opencode/plugins/notify.ts"), "utf8")).toBe("export default {}")
    oc.server.stop(true)
  })

  test("query tools feed a second brain round; model errors are reported honestly", async () => {
    const oc = fakeOpencode(); const dir = await tmp()
    const brain = script(
      J({ say: "Let me look.", actions: [{ tool: "agent_list", args: {} }] }),
      (p) => J({ say: p.includes("build - general coding") ? "I'd use the build agent." : "no data", actions: [] }),
    )
    const j = new Jarvis({ client: oc.client, brain, ledger: new Ledger(), directory: dir })
    expect((await j.handle("who should do this?"))[0].text).toBe("I'd use the build agent.")
    const bad: BrainLLM = { info: () => ({ model: "x", thinkingOff: false }), generate: async () => { throw new Error("rate limited") } }
    const j2 = new Jarvis({ client: oc.client, brain: bad, ledger: new Ledger(), directory: dir })
    expect((await j2.handle("hi"))[0].text).toContain("isn't answering")
    oc.server.stop(true)
  })

  test("unsupported tags from the model never reach the user", async () => {
    const oc = fakeOpencode(); const dir = await tmp()
    const j = new Jarvis({ client: oc.client, brain: script(J({ say: "[smile] Hi there [giggle]", actions: [] })), ledger: new Ledger(), directory: dir })
    expect((await j.handle("hello"))[0].text).toBe("Hi there")
    oc.server.stop(true)
  })
})
