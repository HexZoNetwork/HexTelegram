
set -euo pipefail
cd "$(dirname "$0")"

PASS=0; FAIL=0; WARN=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
warn() { WARN=$((WARN+1)); echo "  ⚠️ $1"; }

echo "=== 1/6 Node.js ==="
if ! command -v node >/dev/null; then echo "ERROR: node not found — install Node 18+ first"; exit 1; fi
NODE_V=$(node -p "process.versions.node" 2>/dev/null || echo "?")
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
echo "  node v$NODE_V"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then fail "node $NODE_V < 18 — upgrade required"; else ok "node >= 18"; fi
if ! command -v npm >/dev/null; then echo "ERROR: npm not found"; exit 1; fi
if [ -f package-lock.json ]; then npm ci 2>&1 | tail -2 || npm install 2>&1 | tail -2; else npm install 2>&1 | tail -2; fi
node -e "require('telegraf')" 2>/dev/null && ok "telegraf module loads" || { fail "telegraf module missing"; }

echo "=== 2/6 Go toolchain + tool runner ==="
if ! command -v go >/dev/null; then echo "ERROR: go not found — install Go 1.21+ first"; exit 1; fi
echo "  $(go version)"
go mod download 2>/dev/null || true
go vet ./tools-go 2>&1 | head -5 || true
go build -o tools ./tools-go && ok "go build tools" || { fail "go build failed"; exit 1; }
chmod +x tools
./tools '{"name":"sysinfo","args":{}}' | head -c 300; echo
./tools '{"name":"calc","args":{"expression":"(2+3)*4"}}' | head -c 120; echo
./tools '{"name":"get_time","args":{"timezone":"UTC"}}' | head -c 120; echo
ok "Go tools smoke test (sysinfo/calc/get_time)"

echo "=== 3/6 chromium (for web_screenshot) ==="
CHROME_BIN=""
for c in chromium chromium-browser google-chrome google-chrome-stable google-chrome-stable_current; do
  if command -v "$c" >/dev/null 2>&1; then CHROME_BIN="$(command -v "$c")"; break; fi
done
[ -z "$CHROME_BIN" ] && [ -x /snap/bin/chromium ] && CHROME_BIN="/snap/bin/chromium"
[ -z "$CHROME_BIN" ] && [ -x /usr/bin/chromium-browser ] && CHROME_BIN="/usr/bin/chromium-browser"

if [ -n "$CHROME_BIN" ]; then
  echo "  found: $CHROME_BIN"
  "$CHROME_BIN" --version 2>/dev/null | grep -iv "cannot change mount\|update.go" | head -1 || true
  if file "$CHROME_BIN" 2>/dev/null | grep -q "shell script"; then
    warn "snap wrapper detected — screenshots must write under ~/snap/chromium (tool already handles this)"
  fi
  SHOT_OUT=$(./tools '{"name":"web_screenshot","args":{"url":"https://example.com"}}' 2>&1 | grep -v "cannot change mount namespace\|update.go" | head -3 || true)
  echo "  $SHOT_OUT" | head -3
  if echo "$SHOT_OUT" | grep -q "^SCREENSHOT:"; then
    SHOT_PATH=$(echo "$SHOT_OUT" | sed -n 's/^SCREENSHOT: \([^ ]*\).*/\1/p')
    if [ -n "$SHOT_PATH" ] && [ -s "$SHOT_PATH" ]; then ok "live screenshot OK ($SHOT_PATH)"; else fail "screenshot reported OK but file missing"; fi
  else
    fail "live screenshot failed — see output above"
    echo "  hint: snap chromium needs a running snapd; try: sudo snap run chromium --headless --no-sandbox --dump-dom https://example.com | head -5"
  fi
else
  echo "  chromium not found — attempting install…"
  if command -v apt-get >/dev/null; then
    sudo apt-get update && (sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser) \
      && ok "chromium installed via apt" \
      || { warn "apt install failed — screenshots will fall back to text"; }
    for c in chromium chromium-browser google-chrome; do
      if command -v "$c" >/dev/null 2>&1; then CHROME_BIN="$(command -v "$c")"; break; fi
    done
    [ -z "$CHROME_BIN" ] && [ -x /snap/bin/chromium ] && CHROME_BIN="/snap/bin/chromium"
    [ -n "$CHROME_BIN" ] && echo "  now: $CHROME_BIN ($("$CHROME_BIN" --version 2>&1 | head -1))" || true
  elif command -v snap >/dev/null; then
    sudo snap install chromium && ok "chromium installed via snap" || warn "snap install failed"
  else
    warn "no apt-get/snap — install chromium manually for web_screenshot"
  fi
fi

[ -e /dev/shm ] || warn "/dev/shm missing — headless chrome may be slow (tool passes --disable-dev-shm-usage)"

echo "=== 4/6 optional helpers ==="
command -v pdftotext >/dev/null && ok "pdftotext (PDF reading)" || warn "pdftotext missing — scanned PDFs unreadable (sudo apt install -y poppler-utils)"
command -v curl >/dev/null && ok "curl" || warn "curl missing"
command -v python3 >/dev/null && ok "python3" || warn "python3 missing"

echo "=== 5/6 config check ==="
if [ ! -f config.json ]; then
  if [ -f example.config.json ]; then warn "config.json missing — copying from example.config.json (EDIT IT next)"; cp example.config.json config.json;
  else fail "config.json AND example.config.json both missing"; fi
fi
if [ -f config.json ]; then
node -e "
const c=require('./config.json');
if(!c.telegramToken||String(c.telegramToken).includes('PASTE')){console.error('  ❌ config.json: set telegramToken');process.exit(1)}
if(!c.ownerUserId){console.error('  ⚠️ ownerUserId missing — bot ignores everyone until set')}
console.log('  ✅ config OK | model='+(c.model||'default')+' | apis='+((c.apis||[]).length|| (c.apiKey?1:0)));
" || FAIL=$((FAIL+1))
fi

echo "=== 6/6 sanity ==="
node --check bot.js && ok "bot.js syntax OK" || fail "bot.js syntax error"
test -f SKILLS.md && ok "SKILLS.md present" || warn "SKILLS.md missing"
test -x ./tools && ok "tools binary executable" || fail "tools binary not executable"

echo
echo "RESULT: ✅ $PASS passed · ⚠️ $WARN warnings · ❌ $FAIL failures"
if [ "$FAIL" -gt 0 ]; then echo "Fix the ❌ lines above, then re-run: bash setup.sh"; exit 1; fi
echo "✅ setup done — run: npm start"
