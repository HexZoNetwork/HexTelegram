

set -euo pipefail
cd "$(dirname "$0")"

echo "=== 1/5 Node deps ==="
if ! command -v node >/dev/null; then echo "ERROR: node not found — install Node 18+ first"; exit 1; fi
if ! command -v npm >/dev/null; then echo "ERROR: npm not found"; exit 1; fi
npm install

echo "=== 2/5 Go toolchain + tool runner ==="
if ! command -v go >/dev/null; then echo "ERROR: go not found — install Go 1.21+ first"; exit 1; fi
go mod download 2>/dev/null || true
go build -o tools ./tools-go
chmod +x tools
./tools '{"name":"sysinfo","args":{}}' | head -c 300; echo

echo "=== 3/5 chromium (for web_screenshot) ==="
if command -v chromium >/dev/null || command -v chromium-browser >/dev/null || command -v google-chrome >/dev/null; then
  echo "chromium OK: $(command -v chromium || command -v chromium-browser || command -v google-chrome)"
else
  echo "chromium not found — trying apt install (needs sudo)…"
  if command -v apt-get >/dev/null; then
    sudo apt-get update && sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser || echo "WARN: chromium install failed — screenshots will fall back to text"
  else
    echo "WARN: no apt-get — install chromium manually for web_screenshot"
  fi
fi

echo "=== 4/5 config check ==="
node -e "const c=require('./config.json'); if(!c.telegramToken||String(c.telegramToken).includes('PASTE')){console.error('config.json: set telegramToken');process.exit(1)} if(!c.ownerUserId){console.error('WARN: ownerUserId missing — bot ignores everyone until set')} console.log('config OK | model='+(c.model||'default'));"

echo "=== 5/5 sanity ==="
node --check bot.js && echo "bot.js syntax OK"
test -f SKILLS.md && echo "SKILLS.md OK" || echo "WARN: SKILLS.md missing"

echo
echo "✅ setup done — run: npm start"
