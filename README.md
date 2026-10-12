<div align="center">
  <h1>Hexzie</h1>
  <p><b>HexTelegram (HTG)</b> - AI Telegram bot by <b>HexzoNetwork</b></p>
</div>

> ⚠️ **Project in active development**, some features may still be in progress.

**Hexzie** is a powerful and modern Telegram AI assistant built with:

* ✅ Telegraf + Node.js (bot framework)
* 📌 OpenAI-compatible API for chat + function-calling tools (**active development**)
* ✅ Go tool runner (`tools-go`) - shell, files, web, screenshots, sysinfo
* ✅ Full filesystem control from `/` - no workspace jail
* ✅ ChatGPT-style streaming replies with live progress labels

---

## Features

* 💬 **Chat** - streaming answers, auto-summary memory, per-chat history
* 💻 **Shell + files** - `shell_exec` (any command), `file_read` / `file_write` / `file_list` from `/`
* 🌐 **Web** - `web_search` (Bing), `web_fetch`, `web_check` (site recon), `web_screenshot` (chromium → PNG)
* ✉️ **Telegram tools** - send message/photo/document, inline buttons, edit, delete, forward, pin, chat actions, `get_chat`
* 🖼️ **Vision + files** - send photo/document, reply-to-file summarization, PDF text extraction (images sent as base64 data URLs - no token leak, always renderable)
* 💾 **AI storage** - persistent key-value notes (`storage.json`) the AI reads/writes via `store_*` tools; owner manages with `/str`
* 📌 **Side notes** - `/btw <msg>` injects guidance into a running task without restarting it
* 🔐 **Access control** - owner + allowlist, silently ignores strangers
* 👥 **Groups** - `/talk` `/t` triggers, `= ~ |` prefixes, @mention, reply-to-bot
* 📡 **Multi-API failover** - pool of endpoints, auto-rotate on 5xx/network errors
* 🧠 **Memory** - rolling window + model-generated summaries in `memory.json`
* 🤖 **Model picker** - `/model c` live-tests every model, paged button UI

---

## Getting Started

```bash
git clone https://github.com/HexZoNetwork/HexTelegram HTG
cd HTG

cp example.config.json config.json

bash setup.sh
npm start
```

Manual steps:

```bash
npm install
npm run build:tools   # go build -o tools ./tools-go
npm start             # node bot.js
```

Requirements: **Node 18+**, **Go 1.21+**, optional **chromium** (for `web_screenshot`).

---

## Config (`config.json`)

Core keys:

| Key | Required | Default | What |
|---|---|---|---|
| `telegramToken` | yes | - | From [@BotFather](https://t.me/BotFather) |
| `ownerUserId` | yes | - | Your numeric Telegram ID (ask the bot `/id`) |
| `allowedUserIds` | no | `[]` | Extra user IDs, e.g. `[111, 222]` |
| `baseURL` | yes* | - | OpenAI-compatible endpoint (*only needed for `apikey` provider) |
| `apiKey` | yes* | - | API key for `baseURL` (*only needed for `apikey` provider) |
| `model` | no | `jmbot/mimo-v2.6-flash` | Chat model for apikey (change live with `/model c`) |
| `systemPrompt` | no | `""` | Extra persona text, prepended to system prompt |
| `temperature` | no | `0.7` | Sampling temperature |
| `maxTokens` | no | `2048` | Max completion tokens |
| `auth.provider` | no | `apikey` | `apikey` \| `antigravity` \| `chatgpt` (switch live with `/login use`) |
| `auth.antigravity.model` | no | `gemini-3-pro-high` | Model when provider=antigravity |
| `auth.chatgpt.model` | no | `gpt-4o-mini` | Model when provider=chatgpt |
| `auth.chatgpt.baseURL` | no | `https://api.openai.com/v1` | Endpoint when provider=chatgpt |

**Filesystem scope:** shell/file tools run from `/` by default. Run the bot as root for full control, or pass `workDir` per `shell_exec` call to scope it:

```json
{ "command": "ls -la", "workDir": "/home/hex" }
```

Everything else (streaming interval, group triggers, history window, timeouts) uses built-in defaults - search `bot.js` for `??` / `||` fallbacks to tune them.

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
| `/btw <msg>` | anyone allowed | Inject a side note into the currently running task|

### Owner only

| Command | What |
|---|---|
| `/adduser <id\|@user>` (or reply) | Grant access |
| `/deluser <id\|@user>` (or reply) | Revoke access |
| `/users` | List owner + allowed users |
| `/apis` | List API pool (★ = active) |
| `/addapi <url> <key>` | Live-test + add API endpoint |
| `/delapi <n>` | Remove API #n (keeps at least one) |
| `/login` | Auth status + provider buttons (apikey/antigravity/chatgpt) |
| `/login antigravity` | Google OAuth → Antigravity gateway (PKCE + copy-paste callback) |
| `/login chatgpt` | ChatGPT OAuth (experimental) |
| `/login code <code>` | Paste OAuth code after browser login |
| `/login callback <url>` | Paste full localhost redirect URL |
| `/login token <tok>` | ChatGPT manual token paste |
| `/login use <provider>` | Switch provider (apikey/antigravity/chatgpt) |
| `/login status` | Accounts + active provider |
| `/login logout [all]` | Remove OAuth accounts → back to apikey |
| `/logout` | Same as `/login logout` |
| `/plugin` (reply to .js/.zip) | Install plugin from replied file |
| `/plugin <url> [id]` | Install plugin from URL |
| `/pl ls` | List plugins |
| `/pl info <id>` | Plugin details |
| `/pl reload` | Reload all plugins |
| `/pl on <id>` / `/pl off <id>` | Enable / disable plugin |
| `/pl del <id>` | Delete plugin + files |
| `/str ls` | List AI storage entries (id + size + preview) |
| `/str inspect <id>` | View one storage entry |
| `/str send <id> <text>` (or reply to a message/file) | Save text into AI storage |
| `/str del <id>` | Delete a storage entry |
| `/str rn <id> <newname>` | Rename a storage entry |

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
| `sysinfo` | - | OS, arch, CPU, mem%, disk% |

### Node built-ins (`bot.js` `runTool`)

`tg_send_message`, `tg_send_buttons` (inline keyboards), `tg_send_photo`, `tg_send_document`, `tg_edit_message`, `tg_delete_message`, `tg_forward`, `tg_chat_action`, `tg_get_chat`, `tg_pin`, `tg_unpin`, plus media/composite/API tools (`tg_send_audio/video/voice/animation/sticker/location/venue/contact/dice/poll/media_group/copy`, `tg_edit_caption/buttons`, `tg_delete_messages`, `tg_get_chat_member/admins/member_count/user_photos`, `tg_ban/unban/restrict/promote`, `tg_invite_link/leave`, `tg_answer_callback/react/stop_poll/set_title/set_description/approve_join/decline_join/unpin_all/get_file`, `tg_say_and_pin/broadcast/user_info`, universal `tg_api` + `tg_event`), AI storage tools (`store_save/read/list/delete/rename`), and `read_skill` (reads one `SKILLS.md` section on demand).

Local file paths (e.g. `/tmp/shot-….png`) work for photo/document sends.

---

## How it works

```
Telegram update → Telegraf middleware (stop-signal, auth by sender ID, plugin dispatcher)
  → event handler (text/photo/doc/voice/callback/…)
  → processText: builds [Context:] block (chat/sender/reply/forward IDs)
  → handlePrompt: agentic loop (max 8 rounds)
      → chatStream: routes by provider -
          apikey: POST {model, messages, tools} to active API (SSE)
          antigravity: translate OpenAI → Gemini contents, call cloudcode-pa gateway (SSE)
          chatgpt: Bearer OAuth token against OpenAI-compatible endpoint (SSE)
      → on tool_calls: show progress label → runTool → push result → re-query
      → on text: finalizeStream (edit "💭 Thinking…" into Markdown answer)
```

Key details:

* **Auth providers** - `config.auth.provider`: `apikey` (legacy pool), `antigravity` (Google OAuth PKCE → Antigravity Unified Gateway, full port of opencode-antigravity-auth translation: PKCE, refresh, project discovery, Gemini `contents` mapping, schema cleaning, SSE unwrap, multi-account rotation), `chatgpt` (experimental OAuth PKCE + manual token paste → Bearer against OpenAI-compatible `auth.chatgpt.baseURL`). Switch live with `/login use <provider>`; tokens in `auth.json` (gitignored). ⚠️ Unofficial OAuth carries the same ToS/account risk as the upstream plugin.
* **Plugins** - `plugins/` + `plugins.json` registry, loaded via `plugins.js` dispatcher middleware (dynamic, no Telegraf unregister needed). Install: reply to `.js` (≤500KB) or `.zip` (≤5MB, `index.js` at root) with `/plugin`, or `/plugin <url> [id]`. Manage: `/pl ls|info|reload|on|off|del`. Only owner can install/manage; any allowed user can run plugin commands. Safety scan flags env/secret/network/shell patterns on install.
* **SDK** - repo `HexZoNetwork/htsdk` (non-commercial HXZ, also at `/home/hex/htsdk`): `definePlugin`, `createAgent`, `defineProvider`, examples (`hello-plugin.js`, `custom-agent.js`, `antigravity-provider.js`). Install with no publish step: `npm install github:HexZoNetwork/htsdk`, then `require("htsdk")`. Copy a plugin file, send it to the bot, reply `/plugin` to install.

Key details:

* **Streaming UI** - one progress message, edited per state (`Thinking…` → `🔍 Checking…` → `✅ done` → final answer). Native `sendMessageDraft` path exists but the progress-message loop is the active one.
* **Stale-supersede** - each chat keeps only the newest request; older ones abort and never render (`⏭ Skipped…`).
* **Failover** - API pool (`config.apis`, migrated from legacy `baseURL`/`apiKey`); 5xx/network errors rotate to next API; 502/503/504 retried with backoff (8s, 20s) then non-stream fallback.
* **Memory** - `conversations` map (last 30 turns) + `memory.json` summaries; overflow beyond 12 recent turns is async-summarized by the chat model.
* **Vision** - Telegram photos/docs/thumbnails are downloaded server-side and sent to the model as base64 data URLs (provider fetch of `api.telegram.org` links is unreliable and would leak the bot token); old image blocks are scrubbed from history so payloads stay small.
* **AI storage** - `storage.json` key-value notes (`[A-Za-z0-9_-]`, ≤64-char ids, ≤50000-char content); AI uses `store_*` tools, owner uses `/str`; missing/corrupt runtime JSON files (`storage/memory/models_cache/text`) are auto-created on boot via `ensureJson`.
* **Side notes** - `/btw` queues guidance into the live run for that chat; drained into the message list before every model round as `[SIDE NOTE ...]`; run liveness tracked via `activeReq` (cleaned on all exits).
* **Auth** - `isAllowed(senderId)` checked FIRST on every update (groups included); strangers get silence. Owner-only gates on `/model c`, `/str`, user/API management.
* **IPv4** - forced (`dns.setDefaultResultOrder("ipv4first")` + pinned lookup + Go `tcp4` dialer) because the host has broken IPv6.
* **Boot** - `getMe` + `launch` retried forever (2s→60s backoff); `unhandledRejection`/`telegraf error` logged, kept alive up to 10/min then exit for a clean restart; `uncaughtException` exits immediately (state may be corrupt).
* **Skills** - `SKILLS.md` loaded once; `SHORT_PROMPT` (in `bot.js`) is the hot system prompt; `read_skill(section)` fetches detail on demand to save tokens.

---

## Project Structure

```
HexTelegram/
├── bot.js                      ← Bot entry: streaming, agentic loop, all handlers
├── auth.js                     ← OAuth providers (antigravity full clone + chatgpt starter)
├── plugins.js                  ← Plugin loader/dispatcher (+ /plugin /pl handlers in bot.js)
├── plugins/
│   ├── hello.js.example        ← Example plugin (reply-install with /plugin)
│   └── .gitkeep
├── auth.json                   ← OAuth tokens (gitignored, created on /login)
├── plugins.json                ← Plugin registry (gitignored)
├── tools-go/
│   └── main.go                 ← Go tool runner
├── tools                       ← Built binary
├── config.json                 ← Your secrets (+ auth.provider)
├── example.config.json         ← Template config
├── SKILLS.md                   ← AI skill book
├── memory.json                 ← Auto-summary memory
├── models_cache.json           ← Live-tested model list cache
├── storage.json                ← AI storage notes
├── text.json                   ← Tips/splashes shown in progress messages
├── setup.sh                    ← Install deps + build + sanity check
└── package.json                ← Node deps (telegraf)

htsdk/               ← SDK clone (repo HexZoNetwork/htsdk, non-commercial, not in this git)
├── index.js                   ← definePlugin, createAgent, helpers (`npm install github:HexZoNetwork/htsdk`)
├── plugin.js / auth-providers.js
└── examples/                  ← hello-plugin, custom-agent, provider skeleton
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

HXZ License © 2026 - HexzoNetwork. See [LICENCE](./LICENCE).
Non-commercial use only; commercial use needs written permission.
