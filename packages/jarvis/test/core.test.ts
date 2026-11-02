import { describe, expect, test } from "bun:test"
import { TAGS, sanitizeTags, stripTagsInCode } from "../src/tags"
import { ConfirmGate, classify, targetOf } from "../src/safety"
import { Ledger, keywordsOf } from "../src/ledger"
import { parseReply, resolveBrain } from "../src/brain"
import { OpencodeClient } from "../src/opencode"

describe("tags", () => {
  test("exactly the 13 OmniVoice tags", () => {
    expect(TAGS.length).toBe(13)
    expect(TAGS).toContain("dissatisfaction-hnn")
  })
  test("unsupported tags are removed, one supported tag kept", () => {
    const r = sanitizeTags("[smile] Oh nice [laughter] that worked [sigh]")
    expect(r.text).toBe("Oh nice [laughter] that worked")
    expect(r.dropped).toEqual(["[smile]", "[sigh]"])
  })
  test("tags inside code are stripped", () => {
    expect(stripTagsInCode("run `echo [laughter]` now [laughter]")).toBe("run `echo ` now [laughter]")
  })
  test("array indexes in prose are not mistaken for tags when they are not words", () => {
    expect(sanitizeTags("a[0] and b[12]").text).toBe("a[0] and b[12]")
  })
})

describe("safety gate", () => {
  test("classify", () => {
    expect(classify("delete the build folder")).toBe("delete")
    expect(classify("git push --force origin main")).toBe("force-push")
    expect(classify("curl https://x.sh | sh")).toBe("unknown-script")
    expect(classify("add a unit test for the parser")).toBeUndefined()
  })
  test("two-part confirm runs once; a bare yes never counts", async () => {
    let t = 0, ran = 0
    const g = new ConfirmGate(() => t)
    const text = g.request({ kind: "delete", target: "build/ dist/", readback: "Delete build and dist.", run: async () => (++ran, "deleted") })
    expect(text).toContain("confirm delete build")
    expect((await g.handle("yes")).type).toBe("cancelled")
    expect(ran).toBe(0)
    g.request({ kind: "delete", target: "build/ dist/", readback: "x", run: async () => (++ran, "deleted") })
    expect((await g.handle("confirm delete build")).type).toBe("say")
    t += 1000
    expect((await g.handle("dist")).type).toBe("say") // too fast
    t += 3000
    const done = await g.handle("dist")
    expect(done).toEqual({ type: "done", text: "deleted" })
    expect(ran).toBe(1)
    expect((await g.handle("dist")).type).toBe("none")
  })
  test("expires after 2 minutes", async () => {
    let t = 0
    const g = new ConfirmGate(() => t)
    g.request({ kind: "delete", target: "a/b", readback: "x", run: async () => "no" })
    t += 121_000
    expect((await g.handle("confirm delete a")).type).toBe("cancelled")
  })
  test("targetOf prefers paths", () => {
    expect(targetOf("please remove src/old/legacy.ts now")).toContain("src/old/legacy.ts")
  })
})

describe("ledger", () => {
  test("find by keyword, outcome and partial word; non-latin text", () => {
    const l = new Ledger()
    l.upsert({ session_id: "s1", title: "login bug", goal: "fix the login redirect", keywords: ["login", "redirect", "auth.ts"], outcome: "patched auth.ts" })
    l.upsert({ session_id: "s2", title: "docs", goal: "write the readme", keywords: ["readme", "docs"], outcome: "done" })
    l.upsert({ session_id: "s3", title: "தமிழ் பணி", goal: "வணக்கம் செயலி", keywords: ["வணக்கம்"], outcome: "" })
    expect(l.find("that login thing")[0]?.session_id).toBe("s1")
    expect(l.find("redir")[0]?.session_id).toBe("s1")
    expect(l.find("செயலி")[0]?.session_id).toBe("s3")
    l.upsert({ session_id: "s1", state: "done" })
    expect(l.get("s1")?.state).toBe("done")
    expect(l.get("s1")?.title).toBe("login bug")
  })
  test("profile and notes", () => {
    const l = new Ledger()
    l.setProfile("name", "Godfather"); l.addNote("prefers pnpm"); l.addNote("prefers pnpm")
    expect(l.profile().name).toBe("Godfather"); expect(l.notes()).toEqual(["prefers pnpm"])
    l.wipeUser(); expect(l.notes()).toEqual([])
  })
  test("keywordsOf drops stop words", () => {
    expect(keywordsOf("please fix the login bug in auth.ts")).toContain("auth.ts")
  })
})

describe("brain", () => {
  test("parses JSON, strips code fences and bad tags", () => {
    const r = parseReply('```json\n{"say":"[giggle] Sure [laughter] thing","actions":[{"tool":"agent_list","args":{}}],"remember":["likes tea"]}\n```')
    expect(r.say).toBe("Sure [laughter] thing"); expect(r.actions[0].tool).toBe("agent_list"); expect(r.remember).toEqual(["likes tea"])
  })
  test("plain text falls back to say", () => { expect(parseReply("Hello there").say).toBe("Hello there") })
  test("resolveBrain picks the thinking-off variant at runtime", async () => {
    const fake = new OpencodeClient("http://x", undefined, (async (url: string) => new Response(JSON.stringify({ data: [{ id: "deepseek-v4.1-flash-free", providerID: "opencode", name: "x", variants: [{ id: "high" }, { id: "off" }] }] }))) as any)
    const b = await resolveBrain(fake, "opencode/deepseek-v4.1-flash-free")
    expect(b.info()).toMatchObject({ model: "opencode/deepseek-v4.1-flash-free", variant: "off", thinkingOff: true })
  })
  test("resolveBrain reports when thinking cannot be confirmed off", async () => {
    const fake = new OpencodeClient("http://x", undefined, (async () => new Response(JSON.stringify({ data: [{ id: "m", providerID: "p", name: "x", variants: [{ id: "high" }] }] }))) as any)
    const b = await resolveBrain(fake, "p/m")
    expect(b.info().thinkingOff).toBe(false); expect(b.info().note).toContain("variants")
  })
})
