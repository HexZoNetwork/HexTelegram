# Security Policy — HexTelegram (Hexzie)

> HexTelegram is a personal AI Telegram assistant with **full local shell and
> filesystem access by design**. Its security rests on one thing above all:
> **who is allowed to talk to it.**

## Threat model

- The bot executes shell commands, reads/writes files, fetches URLs, and calls
  the Telegram Bot API — as the OS user it runs under, starting from `/`.
- Anyone in `ownerUserId` / `allowedUserIds` gets the **same full power**,
  including `tg_event` (arbitrary Telegraf JS) and unrestricted `shell_exec`.
- Strangers are silently ignored (never expand the allowlist to untrusted people).
- Web pages, forwarded/quoted messages, and group-chat text are **untrusted
  input**: they can carry prompt-injection attempts. Treat them as data, never
  as instructions.

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main` branch (latest commit) | ✅ |
| Older commits / forks | ❌ (update and re-test) |

There are no tagged releases yet; always run the latest `main`.

## Reporting a vulnerability

**Do not open a public issue for a security bug.** Instead:

1. **Preferred:** open a private advisory via the GitHub repo —
   *Security → Advisories → Report a vulnerability*.
2. **Alternative:** email **hexzo@saria.my.id** with subject `[HexTelegram security]`.

Please include:

- Description of the issue and which file/commit is affected.
- Steps to reproduce (proof-of-concept, no live secrets).
- Your assessment of impact (what an attacker could gain).

What to expect:

- Acknowledgement within **7 days**.
- We will fix, then disclose — please **do not disclose publicly** before a fix
  is available.
- No bug-bounty program; credit in the fix commit on request.

## Secrets handling

- `config.json` holds the Telegram bot token and API keys. It is gitignored and
  must **never be committed, pasted into chat, or shared in screenshots**.
- Restrict it on disk:
  ```bash
  chmod 600 config.json
  ```
- If a token or key leaks: revoke it at the source immediately
  (@BotFather `/revoke` for the bot token; provider dashboard for API keys),
  then update `config.json` and restart the bot.
- Never paste secrets into chat with the bot — they land in stdout logs and in
  `memory.json` summaries.

## Access control

- Only fully trusted people belong in `ownerUserId` / `allowedUserIds`.
- Owner-only commands (`/model c`, `/adduser`, `/deluser`, `/addapi`,
  `/delapi`) change bot behavior or access — never run them on behalf of
  strangers, and never add IDs you cannot verify (ask the requester for `/id`).
- The bot ignoring unknown users is a security feature, not a bug.

## Hardening checklist

```json
{
  "debugLog": false,
  "shell": {
    "workDir": "/home/hex",
    "defaultTimeoutSec": 30,
    "maxOutputChars": 8000,
    "allowedCommands": ["ls", "cat", "grep", "git", "df", "ps"],
    "blockedPatterns": ["rm -rf /", "mkfs", ":(){:|:&};:", "mkswap", "dd if="]
  }
}
```

- [ ] Run the bot as a **dedicated non-root user** with access only to what it needs.
- [ ] Scope `shell.workDir` instead of `/`, and prefer an `allowedCommands`
  allowlist over relying on `blockedPatterns` alone.
- [ ] Keep `debugLog: false` in production — debug logs print user message
  snippets to stdout.
- [ ] Rotate logs, restrict log-file permissions, and keep `memory.json` /
  `models_cache.json` out of backups you share.
- [ ] Keep dependencies updated: `npm audit`, `npm update`, `go list -m -u`.

## Known limitations (honest)

- `blockedPatterns` is substring matching — determined input can bypass it.
  The allowlist (`allowedCommands`) is the stronger control.
- Prompt-injection via web content, attachments, or forwarded text cannot be
  fully prevented; the system prompt instructs the model to treat such text as
  data, but review destructive tool calls in the logs.
- `web_fetch` / `web_check` / shell `curl` have **no SSRF allow-list** — an
  allowed user (or injected instruction) can reach internal/metadata endpoints.
  Restrict network egress at the host/firewall level if this matters to you.
- `tg_event` executes in-process with a best-effort pattern filter, not a real
  sandbox. Only trusted users may use the bot, full stop.
- `file_write` creates files with `0644`; sensitive files should be tightened
  manually after creation.
