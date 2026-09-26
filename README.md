<div align="center">
  <h1>Hexzie</h1>
  <p><b>HexTelegram (HTG)</b> — AI Telegram bot by <b>HexzoNetwork</b></p>
</div>

> ⚠️ **Project in active development**, some features may still be in progress.

**Hexzie** is a powerful and modern Telegram AI assistant built with:

* ✅ Telegraf + Node.js (bot framework)
* 📌 OpenAI-compatible API for chat + function-calling tools (**active development**)
* ✅ Go tool runner (`tools-go`) — shell, files, web, screenshots, sysinfo
* ✅ Full filesystem control from `/` — no workspace jail
* ✅ ChatGPT-style streaming replies with live progress labels

---

## Features

* 💬 **Chat** — streaming answers, auto-summary memory, per-chat history
* 💻 **Shell + files** — `shell_exec` (any command), `file_read` / `file_write` / `file_list` from `/`
* 🌐 **Web** — `web_search` (Bing), `web_fetch`, `web_check` (site recon), `web_screenshot` (chromium → PNG)
* ✉️ **Telegram tools** — send message/photo/document, inline buttons, edit, delete, forward, pin, chat actions, `get_chat`
* 🖼️ **Vision + files** — send photo/document, reply-to-file summarization, PDF text extraction
* 🔐 **Access control** — owner + allowlist, silently ignores strangers
* 👥 **Groups** — `/talk` `/t` triggers, `= ~ |` prefixes, @mention, reply-to-bot
* 📡 **Multi-API failover** — pool of endpoints, auto-rotate on 5xx/network errors
* 🧠 **Memory** — rolling window + model-generated summaries in `memory.json`
* 🤖 **Model picker** — `/model c` live-tests every model, paged button UI

---

## Getting Started

```bash
git clone https://github.com/HexZoNetwork/Htg HTG
cd HTG

cp example.config.json config.json

bash setup.sh
npm start
```

Manual steps (if you skip `setup.sh`):

```bash
npm install
npm run build:tools   # go build -o tools ./tools-go
npm start             # node bot.js
```

Requirements: **Node 18+**, **Go 1.21+**, optional **chromium** (for `web_screenshot`).

---

## Config (`config.json`)

Only 9 keys:

| Key | Required | Default | What |
|---|---|---|---|
| `telegramToken` | yes | — | From [@BotFather](https://t.me/BotFather) |
| `ownerUserId` | yes | — | Your numeric Telegram ID (ask the bot `/id`) |
| `allowedUserIds` | no | `[]` | Extra user IDs, e.g. `[111, 222]` |
| `baseURL` | yes | — | OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1` |
| `apiKey` | yes | — | API key for `baseURL` |
| `model` | no | `jmbot/mimo-v2.6-flash` | Chat model (change live with `/model c`) |
| `systemPrompt` | no | `""` | Extra persona text, prepended to system prompt |
| `temperature` | no | `0.7` | Sampling temperature |
| `maxTokens` | no | `2048` | Max completion tokens |

**Filesystem scope:** shell/file tools run from `/` by default. Run the bot as root for full control, or pass `workDir` per `shell_exec` call to scope it:

```json
{ "command": "ls -la", "workDir": "/home/hex" }
```

Everything else (streaming interval, group triggers, history window, timeouts) uses built-in defaults — search `bot.js` for `??` / `||` fallbacks to tune them.

---

## Commands

### General

| Command | Who | What |
|---|---|---|
| `/start` | anyone allowed | Intro + help |
| `/new` | anyone allowed | Clear chat history |
| `/forget` | anyone allowed | Clear memory + history |
| `/id` | anyone allowed | Show your user ID + chat ID |
| `/chatid` | anyone allowed | Show chat info (title, type, username) |
| `/model` | anyone allowed | Show current chat model |
| `/model c` | owner | Live-tested model picker (paged buttons) |
| `/img ...` | anyone allowed | Replies "generation is turned off" (disabled) |

### Owner only

| Command | What |
|---|---|
| `/adduser <id\|@user>` (or reply) | Grant access |
| `/deluser <id\|@user>` (or reply) | Revoke access |
| `/users` | List owner + allowed users |
| `/apis` | List API pool (★ = active) |
| `/addapi <url> <key>` | Live-test + add API endpoint |
| `/delapi <n>` | Remove API #n (keeps at least one) |

### Groups / channels

Private chat: everything is a prompt. Groups: bot only answers on trigger:

* `/talk <question>` or `/t <question>`
* Prefix: `=question`, `~question`, `|question`
* `@BotUsername question`
* Reply to the bot's message

Extra: `| <instruction>` replying to a message = instruction + quoted text (e.g. `| summarize`).

---

## Tools

### Go runner (`tools`, via `execFile`)

| Tool | Args | Returns |
|---|---|---|
| `shell_exec` | `command` (req), `workDir` (default `/`), `timeoutSec` (default 30, max 300) | stdout + stderr, truncated ~8KB |
| `file_read` | `path` | Text, truncated ~8KB |
| `file_write` | `path`, `content` | `wrote <path>` (creates dirs) |
| `file_list` | `path` (default `/`) | Up to 100 entries `[D]/[F] name (bytes)` |
| `get_time` | `timezone` (IANA, default UTC) | RFC3339 timestamp |
| `calc` | `expression` (e.g. `(2+3)*4^2`) | `expr = result` |
| `web_fetch` | `url`, `format` | Raw text/markdown, ~8KB |
| `web_search` | `query`, `max` (1–15) | Numbered titles + URLs + snippets (Bing) |
| `web_check` | `url` | Status, final URL, server, title, meta, H1/H2/link counts, tech hints, snippet |
| `web_screenshot` | `url`, `width`, `height`, `timeoutSec` | Local PNG path → send via `tg_send_photo` |
| `sysinfo` | — | OS, arch, CPU, mem%, disk% |

### Node built-ins (`bot.js` `runTool`)

`tg_send_message`, `tg_send_buttons` (inline keyboards), `tg_send_photo`, `tg_send_document`, `tg_edit_message`, `tg_delete_message`, `tg_forward`, `tg_chat_action`, `tg_get_chat`, `tg_pin`, `tg_unpin`, `read_skill` (reads one `SKILLS.md` section on demand).

Local file paths (e.g. `/tmp/shot-….png`) work for photo/document sends.

---

## How it works

```
Telegram update → Telegraf middleware (stop-signal, auth by sender ID)
  → event handler (text/photo/doc/voice/callback/…)
  → processText: builds [Context:] block (chat/sender/reply/forward IDs)
  → handlePrompt: agentic loop (max 8 rounds)
      → chatStream: POST {model, messages, tools} to active API (SSE)
      → on tool_calls: show progress label → runTool → push result → re-query
      → on text: finalizeStream (edit "💭 Thinking…" into Markdown answer)
```

Key details:

* **Streaming UI** — one progress message, edited per state (`Thinking…` → `🔍 Checking…` → `✅ done` → final answer). Native `sendMessageDraft` path exists but the progress-message loop is the active one.
* **Stale-supersede** — each chat keeps only the newest request; older ones abort and never render (`⏭ Skipped…`).
* **Failover** — API pool (`config.apis`, migrated from legacy `baseURL`/`apiKey`); 5xx/network errors rotate to next API; 502/503/504 retried with backoff (8s, 20s) then non-stream fallback.
* **Memory** — `conversations` map (last 30 turns) + `memory.json` summaries; overflow beyond 12 recent turns is async-summarized by the chat model.
* **Auth** — `isAllowed(senderId)` checked FIRST on every update (groups included); strangers get silence. Owner-only gates on `/model c`, user/API management.
* **IPv4** — forced (`dns.setDefaultResultOrder("ipv4first")` + pinned lookup + Go `tcp4` dialer) because the host has broken IPv6.
* **Boot** — `getMe` + `launch` retried forever (2s→60s backoff); `unhandledRejection`/`uncaughtException` logged, never crash.
* **Skills** — `SKILLS.md` loaded once; `SHORT_PROMPT` (in `bot.js`) is the hot system prompt; `read_skill(section)` fetches detail on demand to save tokens.

---

## Project Structure

```
HTG/
├── bot.js                      ← Bot entry: streaming, agentic loop, all handlers
├── tools-go/
│   └── main.go                 ← Go tool runner (shell, files, web, sysinfo)
├── tools                       ← Built binary (`npm run build:tools`)
├── config.json                 ← Your secrets (DO NOT commit)
├── example.config.json         ← Template config (commit this)
├── SKILLS.md                   ← AI skill book (tool recipes the model reads)
├── memory.json                 ← Auto-summary memory (generated at runtime)
├── models_cache.json           ← Live-tested model list cache (generated)
├── setup.sh                    ← Install deps + build + sanity check
└── package.json                ← Node deps (telegraf)
```

---

## 🧪 Disclaimer

> Hexzie runs shell commands with full filesystem access from `/`. Only allow people you trust (`ownerUserId` + `allowedUserIds`). HexzoNetwork is **not responsible for misuse**.

Fory you that dont wan't your file get attack, add this into your config
```
"shell": {
    "enabled": true,
    "workDir": "/home",
    "defaultTimeoutSec": 30,
    "maxOutputChars": 8000,
    "allowedCommands": [],
    "blockedPatterns": [
      "rm -rf /",
      "mkfs",
      ":(){:|:&};:"
    ]
  },
```

---

## License

HXZ License © 2026 — HexzoNetwork. See [LICENCE](./LICENCE).
Non-commercial use only; commercial use needs written permission.
