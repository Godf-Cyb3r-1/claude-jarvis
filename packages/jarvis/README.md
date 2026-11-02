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
curl -fsSL https://opencode.ai/install | bash        # if opencode is not installed yet
opencode auth login                                   # once, so opencode models are available
cd your-project && jarvis                             # then open http://127.0.0.1:4747
```

Jarvis starts `opencode serve` on a private loopback port with a random password, or attach to a running one with `--opencode-url URL --opencode-password PW`.

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

## Not verified against a live opencode

Written against the v2.2.5 HTTP routes in `packages/protocol`; unit tests use a stand-in server. Check on first run: Basic-auth username handling, whether the free model exposes a thinking-off variant (the startup line says so), whether new agent files load without a restart, and 4 parallel sessions.
