#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PASS=0; FAIL=0; WARN=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
warn() { WARN=$((WARN+1)); echo "  ⚠️ $1"; }
info() { echo "  $1"; }
MODE=""
NONINTERACTIVE=0
CHECK_ONLY=0
[ "${SETUP_NONINTERACTIVE:-0}" = "1" ] && NONINTERACTIVE=1
for a in "$@"; do
  case "$a" in
    -y|--yes|--non-interactive) NONINTERACTIVE=1 ;;
    --advanced) MODE="advanced" ;;
    --normal) MODE="normal" ;;
    --check-only) CHECK_ONLY=1; NONINTERACTIVE=1 ;;
    -h|--help)
      printf '%s\n' "Usage: bash setup.sh [--advanced|--normal|--yes|--check-only]" \
        "" \
        "  (no flags)     interactive, Normal config by default" \
        "  --advanced     start in Advanced config mode" \
        "  --normal       force Normal mode" \
        "  --yes          non-interactive: keep existing values, fill defaults" \
        "  --check-only   verify only: no prompts, no installs, no writes" \
        "  SETUP_NONINTERACTIVE=1 bash setup.sh   same as --yes"
      exit 0 ;;
    *) echo "Unknown flag: $a (try --help)"; exit 2 ;;
  esac
done
[ -t 0 ] || NONINTERACTIVE=1
[ "$CHECK_ONLY" = "1" ] && NONINTERACTIVE=1
ask() {
  local prompt="$1" def="$2" var="$3" ans
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$var" '%s' "$def"; return 0; fi
  if [ -n "$def" ]; then printf '%s [%s]: ' "$prompt" "$def" >&2
  else printf '%s: ' "$prompt" >&2; fi
  IFS= read -r ans < /dev/tty || ans=""
  [ -z "$ans" ] && ans="$def"
  printf -v "$var" '%s' "$ans"
}
ask_secret() {
  local prompt="$1" def="$2" var="$3" ans
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$var" '%s' "$def"; return 0; fi
  if [ -n "$def" ]; then printf '%s [keep current]: ' "$prompt" >&2
  else printf '%s: ' "$prompt" >&2; fi
  IFS= read -rs ans < /dev/tty || ans=""
  echo >&2
  [ -z "$ans" ] && ans="$def"
  printf -v "$var" '%s' "$ans"
}
ask_yn() {
  local prompt="$1" def="${2:-N}" var="$3" ans
  def="$(echo "$def" | tr '[:upper:]' '[:lower:]')"
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$var" '%s' "$def"; return 0; fi
  local hint="(y/N)"; [ "$def" = "y" ] && hint="(Y/n)"
  printf '%s %s: ' "$prompt" "$hint" >&2
  IFS= read -r ans < /dev/tty || ans=""
  ans="$(echo "${ans:-$def}" | tr '[:upper:]' '[:lower:]' | cut -c1)"
  [ "$ans" != "y" ] && ans="n"
  [ "$ans" != "n" ] && ans="$def"
  printf -v "$var" '%s' "$ans"
}
is_yn_yes() { [ "${1:-n}" = "y" ]; }
mask() {
  local s="${1:-}"
  if [ ${#s} -le 10 ]; then echo "(set)"; else echo "${s:0:6}...${s: -4}"; fi
}
need_cmd() { command -v "$1" >/dev/null 2>&1; }
json_get() {
  node -e '
    const fs=require("fs"); let c={};
    try { c=JSON.parse(fs.readFileSync("config.json","utf8")); } catch {}
    const k=process.argv[1];
    const pick=(o,p)=>p.split(".").reduce((a,x)=>(a==null?a:a[x]),o);
    let v=pick(c,k);
    if(Array.isArray(v)) v=v.join(",");
    if(v==null||typeof v==="object") v=v==null?"":JSON.stringify(v);
    process.stdout.write(String(v??""));
  ' "$1" 2>/dev/null || true
}
json_merge() {
  node -e '
    const fs=require("fs");
    const patch=JSON.parse(process.argv[1]);
    let c={};
    try { c=JSON.parse(fs.readFileSync("config.json","utf8")); } catch {}
    const deep=(a,b)=>{ for(const k of Object.keys(b)){ if(b[k]&&typeof b[k]==="object"&&!Array.isArray(b[k])&&a[k]&&typeof a[k]==="object"&&!Array.isArray(a[k])) deep(a[k],b[k]); else a[k]=b[k]; } return a; };
    deep(c,patch);
    fs.writeFileSync("config.json", JSON.stringify(c,null,2)+"\n");
  ' "$1"
}
echo "=== HexTelegram setup ==="
[ "$CHECK_ONLY" = "1" ] && echo "  (check-only: verifying, no installs / no writes)"
echo
echo "=== 0/7 setup mode ==="
ADV="n"
if [ "$MODE" = "advanced" ]; then ADV="y"; info "Advanced mode forced via --advanced"
elif [ "$MODE" = "normal" ]; then ADV="n"; info "Normal mode forced via --normal"
else ask_yn "Advanced config?" "N" ADV; fi
if is_yn_yes "$ADV"; then ok "mode: Advanced (all settings asked)"; else ok "mode: Normal (essentials only)"; fi
echo
echo "=== 1/7 Node.js ==="
if ! need_cmd node; then echo "ERROR: node not found — install Node 18+ first"; exit 1; fi
NODE_V=$(node -p "process.versions.node" 2>/dev/null || echo "?")
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
echo "  node v$NODE_V"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then fail "node $NODE_V < 18 — upgrade required"; else ok "node >= 18 (v$NODE_V)"; fi
if ! need_cmd npm; then fail "npm not found"; else ok "npm available ($(npm --version 2>/dev/null))"; fi
if [ "$CHECK_ONLY" = "0" ]; then
  if [ -f package-lock.json ]; then npm ci 2>&1 | tail -2 || npm install 2>&1 | tail -2
  else npm install 2>&1 | tail -2; fi
fi
if node -e "require('telegraf')" 2>/dev/null; then ok "telegraf module loads (runnable)"; else fail "telegraf module missing — run: npm install"; fi
echo
echo "=== 2/7 Go toolchain + tool runner ==="
if ! need_cmd go; then fail "go not found — install Go 1.21+ first"; echo; else
  echo "  $(go version)"
  GO_MAJOR=$(go version | sed -n 's/.*go\([0-9]*\)\..*/\1/p'); GO_MINOR=$(go version | sed -n 's/.*go[0-9]*\.\([0-9]*\).*/\1/p')
  if [ "${GO_MAJOR:-0}" -lt 1 ] || { [ "${GO_MAJOR:-0}" -eq 1 ] && [ "${GO_MINOR:-0}" -lt 21 ]; }; then
    fail "go < 1.21 — upgrade required"
  else ok "go >= 1.21"; fi
  if [ "$CHECK_ONLY" = "0" ]; then
    go mod download 2>/dev/null || true
    go build -o tools ./tools-go && ok "go build ./tools-go (runnable)" || { fail "go build failed"; exit 1; }
    chmod +x tools
  else
    [ -x ./tools ] && ok "tools binary present" || fail "tools binary missing — run without --check-only to build"
  fi
fi
if [ -x ./tools ]; then
  ok "tools binary executable"
  run_tool() {
    local name="$1" args="$2" want="$3" out
    out=$(./tools "{\"name\":\"$name\",\"args\":$args}" 2>&1 || true)
    if echo "$out" | grep -q "$want"; then ok "$name runnable"; else fail "$name broken — got: $(echo "$out" | head -c 160)"; fi
  }
  run_tool sysinfo   '{}' 'OS:'
  run_tool calc      '{"expression":"(2+3)*4"}' '(2+3)\*4 = 20'
  run_tool get_time  '{"timezone":"UTC"}' 'UTC)'
  run_tool file_list '{"path":"."}' 'listing'
  if echo "setup-probe $(date -u +%FT%TZ)" > .setup-probe.txt 2>/dev/null \
    && ./tools '{"name":"file_write","args":{"path":".setup-probe.txt","content":"setup-probe ok"}}' 2>/dev/null | grep -q "wrote" \
    && ./tools '{"name":"file_read","args":{"path":".setup-probe.txt"}}' 2>/dev/null | grep -q "setup-probe ok"; then
    ok "file_write/file_read runnable (round-trip)"
  else fail "file_write/file_read broken"; fi
  rm -f .setup-probe.txt
  run_tool web_fetch  '{"url":"https://example.com"}' 'HTTP'
  run_tool web_check  '{"url":"https://example.com"}' 'SITE:'
  run_tool web_search '{"query":"telegram bot","max":2}' 'SEARCH:'
  if ./tools '{"name":"web_screenshot","args":{"url":"https://example.com"}}' 2>&1 | grep -q "^SCREENSHOT:"; then
    ok "web_screenshot runnable"
  else
    warn "web_screenshot not working yet — see 3/7 chromium section"
  fi
else
  fail "tools binary not executable — Go section failed, skipping tool smoke tests"
fi
echo
echo "=== 3/7 chromium (for web_screenshot) ==="
find_chrome() {
  for v in CHROME_BIN CHROMIUM_PATH CHROME_PATH; do
    if [ -n "${!v:-}" ] && [ -x "${!v:-}" ]; then echo "${!v}"; return 0; fi
  done
  for c in chromium chromium-browser google-chrome google-chrome-stable google-chrome-stable_current chrome headless_shell; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  [ -x /snap/bin/chromium ] && { echo "/snap/bin/chromium"; return 0; }
  [ -x /usr/bin/chromium ] && { echo "/usr/bin/chromium"; return 0; }
  [ -x /usr/bin/chromium-browser ] && { echo "/usr/bin/chromium-browser"; return 0; }
  [ -x /opt/google/chrome/chrome ] && { echo "/opt/google/chrome/chrome"; return 0; }
  return 1
}
CHROME_BIN="$(find_chrome || true)"
CHROMIUM_OK=0
OS_ID=""; OS_LIKE=""
if [ -f /etc/os-release ]; then
  OS_ID=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | tr '[:upper:]' '[:lower:]')
  OS_LIKE=$(sed -n 's/^ID_LIKE=//p' /etc/os-release | tr -d '"' | tr '[:upper:]' '[:lower:]')
fi
os_is() {
  local w; for w in "$@"; do
    [ "$OS_ID" = "$w" ] && return 0
    case " $OS_LIKE " in *" $w "*) return 0;; esac
  done
  return 1
}
manual_chrome_cmd() {
  if os_is ubuntu linuxmint pop zorin elementary neon kubuntu xubuntu lubuntu; then
    echo "sudo snap install chromium"
  elif os_is debian raspbian; then
    echo "sudo apt-get update && sudo apt-get install -y chromium"
  elif os_is fedora rhel centos rocky alma; then
    echo "sudo dnf install -y chromium"
  elif os_is arch manjaro endeavouros; then
    echo "sudo pacman -S --noconfirm chromium"
  elif os_is opensuse suse; then
    echo "sudo zypper install -y chromium"
  elif os_is alpine; then
    echo "sudo apk add chromium"
  elif need_cmd snap; then
    echo "sudo snap install chromium"
  else
    echo "sudo apt-get update && sudo apt-get install -y chromium"
  fi
}
install_chrome_snap() {
  if ! need_cmd snap; then
    info "snapd not found — installing snapd first (needs sudo)…"
    need_cmd apt-get || { warn "no apt-get to install snapd"; return 1; }
    sudo apt-get update && sudo apt-get install -y snapd || { warn "snapd install failed"; return 1; }
  fi
  snap list >/dev/null 2>&1 || warn "snapd not responding yet (first boot?) — continuing anyway"
  info "installing chromium via snap (needs sudo)…"
  sudo snap install chromium || { warn "snap install chromium failed"; return 1; }
  for _ in 1 2 3 4 5 6; do
    CHROME_BIN="$(find_chrome || true)"
    [ -n "$CHROME_BIN" ] && break
    sleep 5
  done
  CHROME_BIN="$(find_chrome || true)"
  if [ -z "$CHROME_BIN" ]; then warn "snap installed but no chromium binary appeared yet (try: sudo snap run chromium --version)"; return 1; fi
  if ! "$CHROME_BIN" --version >/dev/null 2>&1 && ! "$CHROME_BIN" --version 2>&1 | grep -qi "chrom"; then
    warn "chromium binary present but --version failed"; return 1
  fi
  ok "chromium installed via snap ($CHROME_BIN)"
  return 0
}
install_chrome_apt() {
  need_cmd apt-get || { warn "no apt-get on this system"; return 1; }
  info "installing chromium via apt (needs sudo)…"
  sudo apt-get update && sudo apt-get install -y chromium || { warn "apt install chromium failed"; return 1; }
  CHROME_BIN="$(find_chrome || true)"
  [ -n "$CHROME_BIN" ] || { warn "apt claimed success but no chromium binary found"; return 1; }
  ok "chromium installed via apt ($CHROME_BIN)"
  return 0
}
install_chrome_dnf() {
  if need_cmd dnf; then SUDO_PM="sudo dnf install -y chromium";
  elif need_cmd yum; then SUDO_PM="sudo yum install -y chromium";
  else warn "no dnf/yum on this system"; return 1; fi
  info "installing chromium via $SUDO_PM (needs sudo)…"
  eval "$SUDO_PM" || { warn "dnf/yum install failed"; return 1; }
  CHROME_BIN="$(find_chrome || true)"
  [ -n "$CHROME_BIN" ] || { warn "package manager claimed success but no chromium binary found"; return 1; }
  ok "chromium installed ($CHROME_BIN)"
  return 0
}
install_chrome_pacman() {
  need_cmd pacman || { warn "no pacman on this system"; return 1; }
  info "installing chromium via pacman (needs sudo)…"
  sudo pacman -S --noconfirm chromium || { warn "pacman install failed"; return 1; }
  CHROME_BIN="$(find_chrome || true)"
  [ -n "$CHROME_BIN" ] || { warn "pacman claimed success but no chromium binary found"; return 1; }
  ok "chromium installed via pacman ($CHROME_BIN)"
  return 0
}
install_chrome_zypper() {
  need_cmd zypper || { warn "no zypper on this system"; return 1; }
  sudo zypper install -y chromium || { warn "zypper install failed"; return 1; }
  CHROME_BIN="$(find_chrome || true)"
  [ -n "$CHROME_BIN" ] || { warn "zypper claimed success but no chromium binary found"; return 1; }
  ok "chromium installed via zypper ($CHROME_BIN)"
  return 0
}
install_chrome_apk() {
  need_cmd apk || { warn "no apk on this system"; return 1; }
  sudo apk add chromium || { warn "apk install failed"; return 1; }
  CHROME_BIN="$(find_chrome || true)"
  [ -n "$CHROME_BIN" ] || { warn "apk claimed success but no chromium binary found"; return 1; }
  ok "chromium installed via apk ($CHROME_BIN)"
  return 0
}
install_chrome_deb_official() {
  local deb="/tmp/google-chrome-stable_current_amd64.deb" ans="n"
  ask_yn "Download official Google Chrome .deb from dl.google.com instead?" "N" ans
  is_yn_yes "$ans" || return 1
  if need_cmd curl; then curl -fsSL -o "$deb" "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
    || { warn "Chrome .deb download failed"; return 1; }
  elif need_cmd wget; then wget -q -O "$deb" "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
    || { warn "Chrome .deb download failed"; return 1; }
  else warn "need curl or wget to download Chrome"; return 1; fi
  sudo apt-get update && sudo apt-get install -y "$deb" || { warn "Chrome .deb install failed"; rm -f "$deb"; return 1; }
  rm -f "$deb"
  CHROME_BIN="$(find_chrome || true)"
  [ -n "$CHROME_BIN" ] || { warn "Chrome .deb claimed success but no google-chrome binary found"; return 1; }
  ok "Google Chrome installed from official .deb ($CHROME_BIN)"
  return 0
}
try_install_chromium() {
  [ "$CHECK_ONLY" = "1" ] && { warn "check-only: skipping chromium install attempt"; return 1; }
  local ans="n"
  if [ "$NONINTERACTIVE" = "1" ]; then
    warn "chromium missing — non-interactive run, skipping auto-install (install manually: $(manual_chrome_cmd))"
    return 1
  fi
  ask_yn "Chromium not found. Try to install it now (needs sudo)?" "N" ans
  is_yn_yes "$ans" || { warn "skipped chromium install — web_screenshot will fall back to text"; return 1; }
  if os_is ubuntu linuxmint pop zorin elementary neon kubuntu xubuntu lubuntu; then
    install_chrome_snap && return 0
    install_chrome_deb_official && return 0
    return 1
  elif os_is debian raspbian; then
    install_chrome_apt && return 0
    install_chrome_deb_official && return 0
    return 1
  elif os_is fedora rhel centos rocky alma; then
    install_chrome_dnf && return 0; return 1
  elif os_is arch manjaro endeavouros; then
    install_chrome_pacman && return 0; return 1
  elif os_is opensuse suse; then
    install_chrome_zypper && return 0; return 1
  elif os_is alpine; then
    install_chrome_apk && return 0; return 1
  fi
  if need_cmd snap; then install_chrome_snap && return 0; fi
  if need_cmd apt-get; then install_chrome_apt && return 0; install_chrome_deb_official && return 0; fi
  warn "no supported installer (need snap, apt, dnf, pacman, zypper or apk) — install chromium manually for web_screenshot"
  return 1
}
verify_chromium() {
  local bin="$1" ver shot
  ver=$("$bin" --version 2>/dev/null | grep -iv "cannot change mount\|update.go" | head -1 || true)
  [ -z "$ver" ] && ver=$("$bin" --version 2>&1 | head -1 || true)
  echo "  version: ${ver:-(no version output)}"
  if file "$bin" 2>/dev/null | grep -q "shell script"; then
    warn "snap wrapper detected — screenshots write under ~/snap/chromium (tool already handles this)"
  fi
  if "$bin" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --dump-dom https://example.com 2>/dev/null | grep -qi "example"; then
    ok "chromium headless smoke test (--dump-dom example.com)"
  else
    if "$bin" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --dump-dom https://example.com 2>&1 | grep -qi "example"; then
      ok "chromium headless smoke test (with stderr noise filtered)"
    else
      fail "chromium binary runs but cannot render pages"
      echo "  hint: snap chromium needs a running snapd; try: sudo snap run chromium --headless --no-sandbox --dump-dom https://example.com | head -5"
      return 1
    fi
  fi
  if [ ! -x ./tools ]; then warn "tools binary missing — cannot live-test screenshot"; return 1; fi
  shot=$(./tools '{"name":"web_screenshot","args":{"url":"https://example.com"}}' 2>&1 | grep -v "cannot change mount namespace\|update.go" || true)
  echo "  $shot" | head -3
  if echo "$shot" | grep -q "^SCREENSHOT:"; then
    SHOT_PATH=$(echo "$shot" | sed -n 's/^SCREENSHOT: \([^ ]*\).*/\1/p')
    if [ -n "${SHOT_PATH:-}" ] && [ -s "$SHOT_PATH" ]; then
      ok "live screenshot OK ($SHOT_PATH, $(wc -c <"$SHOT_PATH" | tr -d ' ') bytes)"
      return 0
    else fail "screenshot reported OK but file missing ($SHOT_PATH)"; return 1; fi
  else fail "live screenshot failed — see output above"; return 1; fi
}
if [ -z "$CHROME_BIN" ]; then
  warn "chromium not found in PATH"
  if try_install_chromium; then CHROME_BIN="$(find_chrome || true)"; fi
fi
if [ -n "$CHROME_BIN" ]; then
  echo "  found: $CHROME_BIN"
  if verify_chromium "$CHROME_BIN"; then CHROMIUM_OK=1; fi
else
  warn "no chromium — web_screenshot unavailable (bot falls back to web_check + web_fetch)"
fi
[ -e /dev/shm ] || warn "/dev/shm missing — headless chrome may be slow (tool passes --disable-dev-shm-usage)"
echo
echo "=== 4/7 optional helpers ==="
need_cmd pdftotext && { pdftotext -v >/dev/null 2>&1 && ok "pdftotext runnable (PDF reading)" || warn "pdftotext present but not runnable"; } \
  || warn "pdftotext missing — scanned PDFs unreadable (sudo apt install -y poppler-utils)"
need_cmd curl && { curl --version >/dev/null 2>&1 && ok "curl runnable ($(curl --version 2>/dev/null | head -1))" || warn "curl present but not runnable"; } \
  || warn "curl missing"
need_cmd python3 && { python3 --version >/dev/null 2>&1 && ok "python3 runnable ($(python3 --version 2>&1))" || warn "python3 present but not runnable"; } \
  || warn "python3 missing"
need_cmd file && ok "file runnable" || warn "file(1) missing — used only for snap-wrapper detection"
echo
echo "=== 5/7 config (Normal:$([ "$ADV" = "y" ] && echo "no — Advanced" || echo "yes")) ==="
if [ ! -f config.json ]; then
  if [ "$CHECK_ONLY" = "1" ]; then fail "config.json missing (check-only: not creating)"; else
    if [ -f example.config.json ]; then warn "config.json missing — creating from example.config.json"; cp example.config.json config.json
    else fail "config.json AND example.config.json both missing"; fi
  fi
fi
if [ -f config.json ]; then
  if ! node -e "JSON.parse(require('fs').readFileSync('config.json','utf8'))" 2>/dev/null; then
    fail "config.json is not valid JSON — fix it before continuing"
  else
    C_TOKEN="$(json_get telegramToken)"; C_OWNER="$(json_get ownerUserId)"
    C_BASE="$(json_get baseURL)"; C_KEY="$(json_get apiKey)"
    C_MODEL="$(json_get model)"; [ -z "$C_MODEL" ] && C_MODEL="jmbot/mimo-v2.6-flash"
    C_DBG="$(json_get debugLog)"; C_TEMP="$(json_get temperature)"; [ -z "$C_TEMP" ] && C_TEMP="0.7"
    C_MAXT="$(json_get maxTokens)"; [ -z "$C_MAXT" ] && C_MAXT="2048"
    C_SYS="$(json_get systemPrompt)"; C_ALLOW="$(json_get allowedUserIds)"
    C_TOUT="$(json_get apiTimeoutSec)"; [ -z "$C_TOUT" ] && C_TOUT="120"
    C_IDLE="$(json_get apiIdleSec)"; [ -z "$C_IDLE" ] && C_IDLE="45"
    C_HIST="$(json_get maxHistory)"; [ -z "$C_HIST" ] && C_HIST="30"
    C_KEEP="$(json_get memory.recentKeep)"; [ -z "$C_KEEP" ] && C_KEEP="12"
    C_ROUNDS="$(json_get maxToolRounds)"
    C_WORKDIR="$(json_get shell.workDir)"; C_SHTOUT="$(json_get shell.defaultTimeoutSec)"
    C_GCMDS="$(json_get group.commands)"; C_GPFX="$(json_get group.prefixes)"
    C_API0U="$(node -e 'let c={};try{c=require("./config.json")}catch{};process.stdout.write(String(c.apis?.[0]?.baseURL||""))' 2>/dev/null)"
    C_API0K="$(node -e 'let c={};try{c=require("./config.json")}catch{};process.stdout.write(String(c.apis?.[0]?.apiKey||""))' 2>/dev/null)"
    [ -z "$C_BASE" ] && C_BASE="$C_API0U"
    [ -z "$C_KEY" ] && C_KEY="$C_API0K"
    if [ "$CHECK_ONLY" = "0" ]; then
      echo "  Answer prompts — Enter keeps the current value shown in [brackets]."
      if [ -n "$C_TOKEN" ] && [[ "$C_TOKEN" != PASTE* ]]; then
        info "telegramToken: $(mask "$C_TOKEN")"
        ask_secret "Telegram bot token from @BotFather (Enter=keep)" "$C_TOKEN" N_TOKEN
      else
        ask_secret "Telegram bot token from @BotFather" "" N_TOKEN
      fi
      if [ -n "$C_OWNER" ] && [ "$C_OWNER" != "123456789" ]; then
        ask "Owner Telegram user ID (ask the bot /id)" "$C_OWNER" N_OWNER
      else
        ask "Owner Telegram user ID (ask the bot /id)" "" N_OWNER
      fi
      ask "API baseURL (OpenAI-compatible, e.g. https://api.openai.com/v1)" "$C_BASE" N_BASE
      if [ -n "$C_KEY" ] && [[ "$C_KEY" != sk-YOUR* ]]; then
        info "apiKey: $(mask "$C_KEY")"
        ask_secret "API key (Enter=keep)" "$C_KEY" N_KEY
      else
        ask_secret "API key" "" N_KEY
      fi
      ask "Chat model" "$C_MODEL" N_MODEL
      DBG_DEF="N"; [[ "$C_DBG" == "true" ]] && DBG_DEF="y"
      ask_yn "Enable debug log?" "$DBG_DEF" N_DBG
      N_TEMP="$C_TEMP"; N_MAXT="$C_MAXT"; N_SYS="$C_SYS"; N_ALLOW="$C_ALLOW"
      N_TOUT="$C_TOUT"; N_IDLE="$C_IDLE"; N_HIST="$C_HIST"; N_KEEP="$C_KEEP"
      N_ROUNDS="$C_ROUNDS"; N_WORKDIR="$C_WORKDIR"; N_SHTOUT="$C_SHTOUT"
      N_GCMDS="$C_GCMDS"; N_GPFX="$C_GPFX"
      if is_yn_yes "$ADV"; then
        echo "  -- advanced --"
        ask "Sampling temperature (0.0-2.0)" "$C_TEMP" N_TEMP
        ask "Max completion tokens" "$C_MAXT" N_MAXT
        ask "System prompt (extra persona, empty=keep/default)" "$C_SYS" N_SYS
        ask "Extra allowed user IDs (comma-separated, empty=none)" "$C_ALLOW" N_ALLOW
        ask "API timeout seconds" "$C_TOUT" N_TOUT
        ask "API idle-stream seconds" "$C_IDLE" N_IDLE
        ask "Max chat history turns" "$C_HIST" N_HIST
        ask "Memory recent-keep turns" "$C_KEEP" N_KEEP
        ask "Max tool rounds (empty=unlimited)" "$C_ROUNDS" N_ROUNDS
        ask "Shell workDir" "${C_WORKDIR:-/}" N_WORKDIR
        ask "Shell default timeout seconds" "${C_SHTOUT:-30}" N_SHTOUT
        ask "Group commands (comma-separated)" "${C_GCMDS:-talk,t}" N_GCMDS
        ask "Group prefixes (comma-separated, e.g. =,~,|)" "${C_GPFX:-=,~,|}" N_GPFX
      fi
      N_TOKEN="${N_TOKEN:-}"; N_OWNER="${N_OWNER:-}"; N_BASE="${N_BASE:-}"; N_KEY="${N_KEY:-}"; N_MODEL="${N_MODEL:-$C_MODEL}"
      PATCH_JSON="$(N_TOKEN="$N_TOKEN" N_OWNER="$N_OWNER" N_BASE="$N_BASE" N_KEY="$N_KEY" N_MODEL="$N_MODEL" \
        N_DBG="$N_DBG" N_TEMP="$N_TEMP" N_MAXT="$N_MAXT" N_SYS="$N_SYS" N_ALLOW="$N_ALLOW" \
        N_TOUT="$N_TOUT" N_IDLE="$N_IDLE" N_HIST="$N_HIST" N_KEEP="$N_KEEP" N_ROUNDS="$N_ROUNDS" \
        N_WORKDIR="$N_WORKDIR" N_SHTOUT="$N_SHTOUT" N_GCMDS="$N_GCMDS" N_GPFX="$N_GPFX" ADV="$ADV" \
        node -e '
        const e=n=>process.env[n]??"";
        const num=(s,d)=>{ s=String(s).trim(); if(!s) return d; const n=Number(s); return Number.isFinite(n)?n:d; };
        const csv=s=>String(s).split(",").map(x=>x.trim()).filter(Boolean);
        const p={};
        if(e("N_TOKEN")) p.telegramToken=e("N_TOKEN").trim();
        if(e("N_OWNER")) { const n=Number(String(e("N_OWNER")).trim()); if(Number.isFinite(n)&&n>0) p.ownerUserId=n; }
        if(e("N_BASE")) p.baseURL=e("N_BASE").trim().replace(/\/$/,"");
        if(e("N_KEY")) p.apiKey=e("N_KEY").trim();
        if(e("N_MODEL")) p.model=e("N_MODEL").trim();
        p.debugLog=(e("N_DBG")==="y");
        // keep apis[] in sync with baseURL/apiKey (what the bot actually dials)
        const base=p.baseURL||(()=>{try{return require("./config.json").baseURL}catch{return""}})();
        const key=p.apiKey||(()=>{try{return require("./config.json").apiKey}catch{return""}})();
        if(base&&key){ let c={}; try{c=require("./config.json")}catch{}; const pool=Array.isArray(c.apis)?c.apis:[];
          if(!pool.length) p.apis=[{baseURL:base,apiKey:key}]; }
        if(e("ADV")==="y"){
          p.temperature=num(e("N_TEMP"),0.7); p.maxTokens=Math.trunc(num(e("N_MAXT"),2048));
          if(e("N_SYS")) p.systemPrompt=e("N_SYS");
          const allow=csv(e("N_ALLOW")).map(Number).filter(n=>Number.isFinite(n)&&n>0);
          p.allowedUserIds=allow;
          p.apiTimeoutSec=Math.trunc(num(e("N_TOUT"),120)); p.apiIdleSec=Math.trunc(num(e("N_IDLE"),45));
          p.maxHistory=Math.trunc(num(e("N_HIST"),30));
          p.memory={...(()=>{try{return require("./config.json").memory||{}}catch{return{}}})(), recentKeep:Math.trunc(num(e("N_KEEP"),12))};
          if(String(e("N_ROUNDS")).trim()) p.maxToolRounds=Math.trunc(num(e("N_ROUNDS"),8));
          const sh=(()=>{try{return require("./config.json").shell||{}}catch{return{}}})();
          p.shell={...sh};
          if(e("N_WORKDIR")) p.shell.workDir=e("N_WORKDIR").trim();
          if(e("N_SHTOUT")) p.shell.defaultTimeoutSec=Math.trunc(num(e("N_SHTOUT"),30));
          if(!p.shell.maxOutputChars) p.shell.maxOutputChars=8000;
          if(!p.shell.blockedPatterns) p.shell.blockedPatterns=["rm -rf /","mkfs",":(){:|:&};:"];
          const gc=csv(e("N_GCMDS")); if(gc.length) p.group={...(()=>{try{return require("./config.json").group||{}}catch{return{}}})(), commands:gc};
          const gp=csv(e("N_GPFX")); if(gp.length) p.group={...(p.group||(()=>{try{return require("./config.json").group||{}}catch{return{}}})()), prefixes:gp};
        }
        process.stdout.write(JSON.stringify(p));
      ')"
      json_merge "$PATCH_JSON"
      ok "config.json updated (missing keys filled, answers saved)"
    fi
    if node -e "
      const c=require('./config.json');
      let bad=0;
      const need=(cond,msg)=>{ if(!cond){console.error('  ❌ config.json: '+msg); bad=1;} };
      need(c.telegramToken && !String(c.telegramToken).includes('PASTE'), 'set telegramToken (from @BotFather)');
      if(!c.ownerUserId) console.error('  ⚠️ ownerUserId missing — bot ignores everyone until set');
      need((Array.isArray(c.apis)&&c.apis.length)||(c.baseURL&&c.apiKey), 'set baseURL + apiKey (or apis[0])');
      if(c.telegramToken && !/^\d+:[\w-]{20,}$/.test(String(c.telegramToken))) console.error('  ⚠️ telegramToken has an unusual shape — double-check it');
      process.exit(bad);
    "; then
      MODEL_SHOW="$(json_get model)"; [ -z "$MODEL_SHOW" ] && MODEL_SHOW="default"
      NAPIS="$(node -e 'let c={};try{c=require("./config.json")}catch{};const n=Array.isArray(c.apis)?c.apis.length:((c.apiKey)?1:0);process.stdout.write(String(n))')"
      DBG_SHOW="$(json_get debugLog)"; [ -z "$DBG_SHOW" ] && DBG_SHOW="false"
      ok "config OK | model=$MODEL_SHOW | apis=$NAPIS | debugLog=$DBG_SHOW"
    else
      FAIL=$((FAIL+1))
    fi
  fi
fi
echo
echo "=== 6/7 sanity (everything runnable?) ==="
if node --check bot.js 2>/dev/null; then ok "bot.js syntax OK (node --check)"; else fail "bot.js syntax error"; fi
[ -f SKILLS.md ] && ok "SKILLS.md present" || warn "SKILLS.md missing"
[ -x ./tools ] && ok "tools binary executable" || fail "tools binary not executable"
for f in memory.json models_cache.json; do
  if [ -f "$f" ]; then node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" 2>/dev/null && ok "$f present + valid JSON" || warn "$f exists but is not valid JSON (bot will overwrite)"
  else
    if [ "$CHECK_ONLY" = "1" ]; then warn "$f missing (would be created on first run)"
    else echo '{}' > "$f" 2>/dev/null && ok "$f created (was missing)" || warn "cannot create $f"; fi
  fi
done
[ "$CHROMIUM_OK" = "1" ] && ok "chromium fully working (binary + headless + live screenshot)" \
  || warn "chromium not fully working — web_screenshot disabled, text fallback active"
if [ -f config.json ] && need_cmd curl; then
  TOK="$(json_get telegramToken)"
  if [[ "$TOK" == PASTE* ]] || [ -z "$TOK" ]; then warn "telegramToken unset — skipping Telegram getMe check"
  elif [[ "$TOK" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
    if curl -sS -m 10 "https://api.telegram.org/bot${TOK}/getMe" 2>/dev/null | grep -q '"ok":true'; then
      ok "Telegram token live (getMe ok)"
    else warn "Telegram getMe failed — token may be wrong or network is offline"; fi
  else warn "telegramToken shape looks wrong — skipping live getMe check"; fi
fi
if [ -f config.json ] && need_cmd curl; then
  APIU="$(node -e 'let c={};try{c=require("./config.json")}catch{};const a=Array.isArray(c.apis)&&c.apis[0];process.stdout.write(String(a?.baseURL||c.baseURL||""))' 2>/dev/null)"
  APIK="$(node -e 'let c={};try{c=require("./config.json")}catch{};const a=Array.isArray(c.apis)&&c.apis[0];process.stdout.write(String(a?.apiKey||c.apiKey||""))' 2>/dev/null)"
  if [ -n "$APIU" ] && [ -n "$APIK" ] && [[ "$APIK" != sk-YOUR* ]]; then
    if curl -sS -m 15 -H "Authorization: Bearer $APIK" "${APIU%/}/models" 2>/dev/null | grep -qi "data\|object\|model"; then
      ok "API endpoint reachable (${APIU%/}/models)"
    else warn "API endpoint not reachable now (${APIU}) — bot will retry/failover at runtime"; fi
  else warn "API baseURL/key unset — skipping live API check"; fi
fi
echo
echo "RESULT: ✅ $PASS passed · ⚠️ $WARN warnings · ❌ $FAIL failures"
if [ "$FAIL" -gt 0 ]; then echo "Fix the ❌ lines above, then re-run: bash setup.sh"; exit 1; fi
if [ "$CHECK_ONLY" = "1" ]; then echo "✅ check-only done — everything verifiable is runnable."; else echo "✅ setup done — run: npm start"; fi
