#!/usr/bin/env bun
import os from "node:os"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { launchOpencode, OpencodeClient } from "./opencode"
import { resolveBrain } from "./brain"
import { Ledger } from "./ledger"
import { Jarvis } from "./jarvis"
import { startServer } from "./server"

const HELP = `jarvis - a personal assistant that sits above opencode

Usage: jarvis [options]
  --dir <path>                 project directory the workers run in (default: current directory)
  --port <n>                   Web UI port (default 4747)
  --opencode-url <url>         attach to a running opencode server instead of starting one
  --opencode-password <pw>     password for that server
  --brain <provider/model>     brain model (default opencode/deepseek-v4.1-flash-free)
  --max-sessions <n>           most workers at once (default 4)
  --data <path>                where Jarvis keeps memory (default ~/.local/share/jarvis)
  -h, --help
Env: JARVIS_OPENCODE_BIN, JARVIS_BRAIN_MODEL, JARVIS_BRAIN_FALLBACKS (comma separated)`

function arg(name: string) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (process.argv.includes("-h") || process.argv.includes("--help")) { console.log(HELP); process.exit(0) }

const directory = path.resolve(arg("--dir") ?? process.cwd())
const port = Number(arg("--port") ?? 4747)
const dataDir = path.resolve(arg("--data") ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "jarvis"))
await mkdir(dataDir, { recursive: true })

let oc
try {
  oc = await launchOpencode({ directory, url: arg("--opencode-url"), password: arg("--opencode-password") })
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}

const brain = await resolveBrain(oc.client, arg("--brain"))
const info = brain.info()
const ledger = new Ledger(path.join(dataDir, "jarvis.db"))
const jarvis = new Jarvis({ client: oc.client, brain, ledger, directory, maxSessions: Number(arg("--max-sessions") ?? 4) })

const abort = new AbortController()
void oc.client.subscribe((ev) => jarvis.workers.onEvent(ev), abort.signal)
const server = startServer(jarvis, ledger, { port })

console.log(`Jarvis is up: http://127.0.0.1:${server.port}`)
console.log(`  workers run in: ${directory}`)
console.log(`  brain: ${info.model}${info.variant ? " #" + info.variant : ""}  thinking ${info.thinkingOff ? "off" : "NOT confirmed off"}`)
if (info.note) console.log(`  note: ${info.note}`)

const stop = () => { abort.abort(); server.stop(true); oc.stop(); process.exit(0) }
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
