# Jarvis

A human-like personal assistant that sits **above** opencode and controls it. You talk to Jarvis in text; he thinks with a fast opencode model (`opencode/deepseek-v4.1-flash-free`, thinking off) and runs up to **4** opencode sessions as workers.

```
You (Web UI) -> Jarvis brain -> control tools -> worker sessions (opencode)
                    |                 ^
              memory cards <- worker events
```

## Install and run (Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/Godf-Cyb3r-1/claude-jarvis/main/install-jarvis.sh | bash
cd your-project && jarvis                             # then open http://127.0.0.1:4747
```

The installer also puts a pinned opencode server in `~/.local/share/jarvis/bin/opencode`; Jarvis prefers it over whatever is on `PATH`. The default pin is **1.18.33**, because its free models are not metered (2.x answers free-tier calls with `Free usage limit reached`). Set `OPENCODE_VERSION=2.2.5` to use a 2.x server instead, or `JARVIS_SKIP_OPENCODE=1` to use your own install.

Jarvis starts `opencode serve` on a private loopback port with a random password, or attach to a running one with `--opencode-url URL --opencode-password PW`.

> **Server compatibility.** Jarvis speaks the 2.x `/api` routes and adapts to the server it finds:
> - **2.2+**: one-shot generation is `POST /api/experimental/generate/text`.
> - **2.0 / 2.1**: only the legacy `POST /api/experimental/generate` exists; Jarvis detects the 404 and uses it.
> - **1.18.x**: the `/api` surface does not execute prompts, so Jarvis switches to the `/session` routes (`/session/{id}/message`, `/event`, `/session/{id}/permissions/{id}`) and runs one throwaway session per brain call. Worker events are translated to the names the worker tracker uses.
>
> When a brain call fails on one free model, Jarvis retries the next entry in `JARVIS_BRAIN_FALLBACKS`.

## What is where

| File | Job |
| --- | --- |
| `src/brain.ts` | Resolves the brain model from opencode's model list, picks the variant that turns thinking off, builds the prompt, parses replies |
| `src/persona.ts` | The persona and the exact tool list given to the brain |
| `src/tags.ts` | The 13 supported expression tags and the sanitiser (any other `[word]` is removed) |
| `src/jarvis.ts` | The conversation engine and all control tools |
| `src/workers.ts` | Up to 4 worker sessions, a queue, opencode event tracking |
| `src/ledger.ts` | SQLite + FTS5 session cards (trigram fallback), user profile and notes, audit log |
| `src/safety.ts` | Two-part text confirmation, enforced in code |
| `src/opencode.ts` | HTTP client for the opencode server API, and launcher |
| `web/index.html` | Chat, worker tray, memory panel and the WebGL orb |

## Expression tags

Only these 13 may be written (OmniVoice's supported set): `[laughter] [sigh] [confirmation-en] [question-en] [question-ah] [question-oh] [question-ei] [question-yi] [surprise-ah] [surprise-oh] [surprise-wa] [surprise-yo] [dissatisfaction-hnn]`. At most one per reply. Anything else is removed and logged.

## Safety

Deleting, force pushes, unknown scripts, permission widening and plugin creation are gated in code. Jarvis reads the action back, you type `confirm <kind> <target>`, and then the last word of the target a few seconds later. A bare "yes" never counts; it expires after 2 minutes. Every gated request and outcome is in the audit log (`/api/audit`).

## Develop

```bash
cd packages/jarvis
bun test
bun run src/main.ts --opencode-url http://127.0.0.1:PORT
bun build --compile --minify --target=bun-linux-x64 src/main.ts --outfile dist/jarvis-linux-x64
```

## Live-server status

Verified against a live opencode **1.18.33** server: brain replies on `opencode/deepseek-v4.1-flash-free`, worker creation, streamed worker summaries, completion events and the proactive "done" message all work. The 2.x path (2.0.27 and a 2.2.5 build from this tree) is verified through the same client, including the generate-route fallback and startup version check. Basic auth uses the `opencode` username on both generations.

Still worth checking on first run: whether the chosen free model exposes a thinking-off variant (the startup line says so), whether new agent files load without a restart, and 4 parallel sessions on a 1.18.x server.
