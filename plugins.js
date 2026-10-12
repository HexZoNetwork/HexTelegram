/**
 * HexTelegram Plugins - dynamic command plugins (CommonJS .js + .zip bundles + URL install)
 * Non-commercial (HXZ License).
 *
 * Layout:
 *   plugins/               <- installed plugins (gitignored except .gitkeep/example)
 *     hello.js             <- single-file plugin (module.exports = {...})
 *     mybundle/            <- folder plugin from .zip (index.js | main.js | plugin.js)
 *   plugins.json           <- registry { <id>: { id, file, name, version, desc,
 *                            enabled, commands: [], addedAt, source } }
 *
 * Plugin module shape (both styles):
 *   module.exports = {
 *     name: "hello",
 *     version: "1.0.0",
 *     description: "Says hello",
 *     commands: {
 *       "hello": async (ctx, args, api) => { await ctx.reply("hi"); },
 *     },
 *     onLoad(api) {}, onUnload(api) {}
 *   }
 *
 * Dispatcher: a single Telegraf middleware (installPluginMiddleware) runs after
 * auth, before built-ins. If text matches /<cmd> of an ENABLED plugin, it runs
 * and stops propagation. This allows load/unload without Telegraf unregister.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PLUGINS_DIR = path.join(__dirname, "plugins");
const REGISTRY_PATH = path.join(__dirname, "plugins.json");
const MAX_PLUGIN_BYTES = 500 * 1024;
const MAX_ZIP_BYTES = 5 * 1024 * 1024;

function ensureDirs() {
  try { fs.mkdirSync(PLUGINS_DIR, { recursive: true }); } catch {}
  if (!fs.existsSync(REGISTRY_PATH)) {
    try { fs.writeFileSync(REGISTRY_PATH, JSON.stringify({}, null, 2) + "\n"); } catch {}
  }
}
function loadRegistry() {
  ensureDirs();
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    return r && typeof r === "object" ? r : {};
  } catch {
    return {};
  }
}
function saveRegistry(reg) {
  try {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
    return true;
  } catch (e) {
    console.error("saveRegistry failed:", e.message);
    return false;
  }
}
function validId(id) {
  return /^[A-Za-z0-9_-]{1,48}$/.test(String(id || ""));
}
function validCmd(name) {
  return /^[A-Za-z0-9_]{1,32}$/.test(String(name || ""));
}

const loaded = new Map();

function clearRequireCache(file) {
  try {
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    const dir = path.dirname(resolved);
    for (const k of Object.keys(require.cache)) {
      if (k === resolved || k.startsWith(dir + path.sep)) delete require.cache[k];
    }
  } catch {}
}

function resolveFolderEntry(dir) {
  for (const f of ["index.js", "main.js", "plugin.js"]) {
    const p = path.join(dir, f);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function normalizePlugin(mod, id) {
  if (typeof mod === "function" && !mod.commands) {
    return { factory: mod, id };
  }
  return mod;
}

function extractCommands(mod) {
  const out = new Map();
  const cmds = (mod && mod.commands) || {};
  for (const [raw, val] of Object.entries(cmds)) {
    const name = String(raw || "").replace(/^\//, "").toLowerCase();
    if (!validCmd(name)) continue;
    if (typeof val === "function") {
      out.set(name, { handler: val, description: "", usage: `/${name}` });
    } else if (val && typeof val.handler === "function") {
      out.set(name, { handler: val.handler, description: String(val.description || ""), usage: String(val.usage || `/${name}`) });
    }
  }
  return out;
}

function validTool(name) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(String(name || ""));
}
function toolFullName(id, tool) {
  return `${id}__${tool}`;
}
function extractTools(norm, id) {
  const out = new Map();
  const tools = (norm && norm.tools) || {};
  for (const [raw, val] of Object.entries(tools)) {
    const short = String(raw || "").trim();
    if (!validTool(short)) continue;
    const full = toolFullName(id, short);
    if (full.length > 64) { console.warn(`[plugins] ${id}: tool '${short}' skipped (full name '${full}' over 64 chars - shorten id or tool)`); continue; }
    let def = null;
    if (typeof val === "function") {
      def = { handler: val, description: "", parameters: { type: "object", properties: {} } };
    } else if (val && typeof val.handler === "function") {
      let params = val.parameters;
      if (typeof params === "string") { try { params = JSON.parse(params); } catch { params = null; } }
      if (!params || typeof params !== "object") params = { type: "object", properties: {} };
      def = { handler: val.handler, description: String(val.description || "").slice(0, 500), parameters: params };
    }
    if (def) out.set(full, def);
  }
  return out;
}
function summarizeMod(mod, id) {
  let m = mod;
  if (m && m.__esModule && m.default) m = m.default;
  if (typeof m === "function" && !m.commands) { try { m = m({}) || {}; } catch {} }
  const handlers = extractCommands(m);
  const tools = extractTools(m, id);
  const hooks = extractHooks(m);
  return {
    commands: [...handlers.keys()],
    tools: [...tools.entries()].map(([full, def]) => ({ name: full, description: def.description || "" })),
    hooks: Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length])),
    name: (m && m.name) ? String(m.name).slice(0, 64) : "",
    description: (m && m.description) ? String(m.description).slice(0, 200) : "",
    version: (m && m.version) ? String(m.version).slice(0, 32) : "",
  };
}
function findTool(fullName) {
  const name = String(fullName || "");
  for (const [id, rec] of loaded.entries()) {
    if (rec.meta && rec.meta.enabled === false) continue;
    const def = rec.tools && rec.tools.get(name);
    if (def) return { id, rec, def };
  }
  return null;
}
function getToolDefs() {
  const defs = [];
  for (const rec of loaded.values()) {
    if (rec.meta && rec.meta.enabled === false) continue;
    if (!rec.tools) continue;
    for (const [full, def] of rec.tools.entries()) {
      defs.push({ type: "function", function: { name: full, description: def.description || `Plugin tool ${full}`, parameters: def.parameters } });
    }
  }
  return defs;
}
async function callTool(fullName, args, ctx, api) {
  const found = findTool(fullName);
  if (!found) throw new Error(`unknown plugin tool '${fullName}'`);
  const useApi = api || _api;
  const res = await found.def.handler(args || {}, ctx, useApi);
  if (res === undefined || res === null) return "(plugin tool returned nothing)";
  return typeof res === "string" ? res : JSON.stringify(res);
}
const HOOK_KINDS = ["input", "output", "beforeTool", "afterTool"];
function extractHooks(norm) {
  const out = { input: [], output: [], beforeTool: [], afterTool: [] };
  const hooks = (norm && norm.hooks) || {};
  for (const kind of HOOK_KINDS) {
    const v = hooks[kind];
    const list = Array.isArray(v) ? v : (typeof v === "function" ? [v] : []);
    for (const fn of list) {
      if (typeof fn === "function") out[kind].push(fn);
    }
  }
  return out;
}
function hookOwners(kind) {
  const owners = [];
  for (const [id, rec] of loaded.entries()) {
    if (rec.meta && rec.meta.enabled === false) continue;
    const fns = rec.hooks && rec.hooks[kind];
    if (fns && fns.length) owners.push({ id, rec, fns });
  }
  return owners;
}
async function transformText(kind, text, ctx, api, strict) {
  let cur = String(text ?? "");
  for (const { id, fns } of hookOwners(kind)) {
    for (const fn of fns) {
      try {
        const r = await fn(cur, ctx, api || _api);
        if (typeof r === "string") cur = r;
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 300);
        if (strict) throw new Error(`hook '${kind}' from '${id}' blocked: ${msg}`);
        console.warn(`[plugins] hook '${kind}' from '${id}' failed (kept previous): ${msg}`);
      }
    }
  }
  return cur;
}
async function transformInput(content, ctx, api) {
  if (typeof content === "string") return transformText("input", content, ctx, api, true);
  if (Array.isArray(content)) {
    const out = [];
    for (const p of content) {
      if (p && p.type === "text" && typeof p.text === "string") {
        out.push({ ...p, text: await transformText("input", p.text, ctx, api, true) });
      } else out.push(p);
    }
    return out;
  }
  return content;
}
async function transformOutput(text, ctx, api) {
  return transformText("output", text, ctx, api, false);
}
async function runBeforeTool(name, args, ctx, api) {
  let cur = args || {};
  for (const { id, fns } of hookOwners("beforeTool")) {
    for (const fn of fns) {
      let r;
      try { r = await fn(name, cur, ctx, api || _api); }
      catch (e) { return { blocked: String((e && e.message) || e).slice(0, 300) }; }
      if (r === undefined || r === null) continue;
      if (typeof r === "string") return { blocked: r.slice(0, 300) };
      if (typeof r === "object") {
        if (typeof r.block === "string" && r.block) return { blocked: r.block.slice(0, 300) };
        if (r.block === true) return { blocked: `blocked by '${id}'` };
        if (r.args && typeof r.args === "object") cur = r.args;
      }
    }
  }
  return { args: cur };
}
async function runAfterTool(name, args, result, ctx, api) {
  let cur = String(result ?? "");
  for (const { id, fns } of hookOwners("afterTool")) {
    for (const fn of fns) {
      try {
        const r = await fn(name, args, cur, ctx, api || _api);
        if (typeof r === "string") cur = r;
      } catch (e) {
        console.warn(`[plugins] afterTool from '${id}' failed (kept previous): ${String((e && e.message) || e).slice(0, 200)}`);
      }
    }
  }
  return cur;
}

function buildApi(bot, config, extras = {}) {
  return Object.assign({
    bot,
    config,
    pluginsDir: PLUGINS_DIR,
    log: (...a) => console.log("[plugin]", ...a),
    runTool: null,
    storage: null,
    chat: null,
  }, extras);
}

let _api = null;

function loadOne(id, reg, api) {
  const meta = reg[id];
  if (!meta || meta.enabled === false) return null;
  const file = meta.file && path.join(PLUGINS_DIR, meta.file);
  if (!file) return null;
  let entry = file;
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) {
      entry = resolveFolderEntry(file);
      if (!entry) { console.warn(`[plugins] ${id}: folder has no index.js/main.js/plugin.js`); return null; }
    } else if (!st.isFile()) return null;
  } catch (e) {
    console.warn(`[plugins] ${id}: missing file ${meta.file}: ${e.message}`);
    return null;
  }
  try {
    clearRequireCache(entry);
    let mod = require(entry);
    if (mod && mod.__esModule && mod.default) mod = mod.default;
    let norm = normalizePlugin(mod, id);
    if (norm && norm.factory) {
      try { norm = norm.factory(api) || {}; } catch (e) {
        console.warn(`[plugins] ${id} factory failed: ${e.message}`);
        return null;
      }
    }
    const handlers = extractCommands(norm);
    const tools = extractTools(norm, id);
    const hooks = extractHooks(norm);
    const rec = { mod: norm, meta, handlers, tools, hooks, entry };
    if (norm && typeof norm.onLoad === "function") {
      try { norm.onLoad(api); } catch (e) { console.warn(`[plugins] ${id} onLoad: ${e.message}`); }
    }
    meta.commands = [...handlers.keys()];
    meta.tools = [...tools.entries()].map(([full, def]) => ({ name: full, description: def.description || "" }));
    meta.hooks = Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length]));
    if (!meta.name && norm && norm.name) meta.name = String(norm.name).slice(0, 64);
    if (!meta.description && norm && norm.description) meta.description = String(norm.description).slice(0, 200);
    if (!meta.version && norm && norm.version) meta.version = String(norm.version).slice(0, 32);
    loaded.set(id, rec);
    return rec;
  } catch (e) {
    console.warn(`[plugins] ${id} load failed: ${e.message}`);
    return null;
  }
}

function unloadOne(id) {
  const rec = loaded.get(id);
  if (!rec) return;
  try {
    if (rec.mod && typeof rec.mod.onUnload === "function") {
      try { rec.mod.onUnload(_api); } catch {}
    }
  } catch {}
  try { clearRequireCache(rec.entry); } catch {}
  loaded.delete(id);
}

function loadAll(bot, config, extras = {}) {
  ensureDirs();
  const reg = loadRegistry();
  _api = buildApi(bot, config, extras);
  for (const id of [...loaded.keys()]) {
    if (!reg[id] || reg[id].enabled === false) unloadOne(id);
  }
  let ok = 0, fail = 0;
  for (const id of Object.keys(reg)) {
    if (reg[id].enabled === false) continue;
    if (loaded.has(id)) continue;
    const r = loadOne(id, reg, _api);
    if (r) ok++; else fail++;
  }
  saveRegistry(reg);
  return { ok, fail, total: Object.keys(reg).length };
}

function reloadAll(bot, config, extras = {}) {
  ensureDirs();
  const reg = loadRegistry();
  if (bot && config) _api = buildApi(bot, config, extras);
  else if (extras && Object.keys(extras).length && _api) Object.assign(_api, extras);
  for (const id of [...loaded.keys()]) unloadOne(id);
  let ok = 0, fail = 0;
  for (const id of Object.keys(reg)) {
    if (reg[id].enabled === false) continue;
    const r = loadOne(id, reg, _api || buildApi(bot, config, extras));
    if (r) ok++; else fail++;
  }
  saveRegistry(reg);
  return { ok, fail, total: Object.keys(reg).length };
}

function setEnabled(id, on) {
  const reg = loadRegistry();
  if (!reg[id]) return { error: `No plugin \`${id}\`` };
  reg[id].enabled = on !== false;
  saveRegistry(reg);
  if (on === false) unloadOne(id);
  else if (_api) loadOne(id, reg, _api);
  return { ok: true, enabled: reg[id].enabled };
}

function removePlugin(id) {
  const reg = loadRegistry();
  const meta = reg[id];
  if (!meta) return { error: `No plugin \`${id}\`` };
  unloadOne(id);
  try {
    const target = path.join(PLUGINS_DIR, meta.file);
    const st = fs.statSync(target);
    if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);
  } catch {}
  delete reg[id];
  saveRegistry(reg);
  return { ok: true };
}

function listPlugins() {
  const reg = loadRegistry();
  return Object.entries(reg).map(([id, m]) => ({
    id,
    name: m.name || id,
    version: m.version || "",
    description: m.description || "",
    enabled: m.enabled !== false,
    commands: m.commands || [],
    tools: m.tools || [],
    hooks: m.hooks || {},
    file: m.file || "",
    addedAt: m.addedAt || 0,
    source: m.source || "",
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function findCommand(cmd) {
  const name = String(cmd || "").replace(/^\//, "").toLowerCase();
  for (const [id, rec] of loaded.entries()) {
    if (rec.meta && rec.meta.enabled === false) continue;
    const h = rec.handlers.get(name);
    if (h) return { id, rec, handler: h.handler, info: h };
  }
  return null;
}

function safetyScan(code) {
  const flags = [];
  if (/\bprocess\.env\b/.test(code)) flags.push("reads process.env");
  if (/telegramToken|apiKey|config\.json/.test(code)) flags.push("touches secrets");
  if (/\bexec\s*\(|\bspawn\s*\(|child_process/.test(code)) flags.push("spawns processes");
  if (/fetch\s*\(|https?\.request|axios/.test(code)) flags.push("network access");
  if (/rm\s+-rf|mkfs|:\(\)\{/.test(code)) flags.push("dangerous shell pattern");
  return flags;
}

async function installFromBuffer({ id, buf, filename, source }) {
  ensureDirs();
  if (!validId(id)) return { error: "Bad plugin id (use [A-Za-z0-9_-], max 48)" };
  const reg = loadRegistry();
  const name = String(filename || "plugin.js");
  const isZip = /\.zip$/i.test(name) || (buf[0] === 0x50 && buf[1] === 0x4b);
  if (isZip) {
    if (buf.length > MAX_ZIP_BYTES) return { error: `Zip too big (${buf.length}B > 5MB)` };
    const destDir = path.join(PLUGINS_DIR, id);
    const tmp = path.join(PLUGINS_DIR, `.tmp-${id}-${Date.now()}.zip`);
    try { fs.writeFileSync(tmp, buf); } catch (e) { return { error: `Write failed: ${e.message}` }; }
    const res = await new Promise((resolve) => {
      execFile("unzip", ["-o", "-q", tmp, "-d", destDir], { timeout: 20000 }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });
    try { fs.unlinkSync(tmp); } catch {}
    if (res.err) return { error: `unzip failed: ${res.err.message} ${res.stderr.slice(0, 200)}` };
    const entry = resolveFolderEntry(destDir);
    if (!entry) {
      try {
        const subs = fs.readdirSync(destDir).map((x) => path.join(destDir, x)).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
        for (const s of subs) {
          const e2 = resolveFolderEntry(s);
          if (e2) {
            for (const f of fs.readdirSync(s)) {
              try { fs.renameSync(path.join(s, f), path.join(destDir, f)); } catch {}
            }
            try { fs.rmdirSync(s); } catch {}
            break;
          }
        }
      } catch {}
      const entry2 = resolveFolderEntry(destDir);
      if (!entry2) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
        return { error: "Zip has no index.js / main.js / plugin.js at root" };
      }
    }
    const code = (() => { try { return fs.readFileSync(resolveFolderEntry(destDir), "utf8"); } catch { return ""; } })();
    if (code.length > 2000000) { try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {} return { error: "Plugin too large" }; }
    const flags = safetyScan(code);
    reg[id] = { id, file: id, name: id, version: "", description: "", enabled: true, commands: [], tools: [], addedAt: Date.now(), source: source || "zip" };
    if (_api) loadOne(id, reg, _api);
    else {
      try {
        const entry = resolveFolderEntry(destDir);
        if (entry) {
          clearRequireCache(entry);
          const s = summarizeMod(require(entry), id);
          reg[id].commands = s.commands;
          reg[id].tools = s.tools;
          if (s.name) reg[id].name = s.name;
          if (s.description) reg[id].description = s.description;
          if (s.version) reg[id].version = s.version;
          try { clearRequireCache(entry); } catch {}
        }
      } catch {}
    }
    saveRegistry(reg);
    const rec = loaded.get(id);
    if (rec && rec.meta) { reg[id] = rec.meta; saveRegistry(reg); }
    return { ok: true, id, commands: (reg[id] && reg[id].commands) || [], tools: (reg[id] && reg[id].tools) || [], flags };
  } else {
    if (buf.length > MAX_PLUGIN_BYTES) return { error: `File too big (${buf.length}B > 500KB)` };
    if (!/\.js$/i.test(name) && !/\.cjs$/i.test(name)) return { error: "Only .js plugins supported (or .zip bundle)" };
    const code = buf.toString("utf8");
    if (!code.trim()) return { error: "Empty file" };
    try { new (require("vm").Script)(code, { filename: `${id}.js` }); } catch (e) {
      return { error: `Syntax error: ${String(e.message).slice(0, 300)}` };
    }
    const flags = safetyScan(code);
    const dest = path.join(PLUGINS_DIR, `${id}.js`);
    try { fs.writeFileSync(dest, code); } catch (e) { return { error: `Write failed: ${e.message}` }; }
    reg[id] = { id, file: `${id}.js`, name: id, version: "", description: "", enabled: true, commands: [], tools: [], addedAt: Date.now(), source: source || "file" };
    if (_api) loadOne(id, reg, _api);
    else {
      try {
        clearRequireCache(dest);
        const s = summarizeMod(require(dest), id);
        reg[id].commands = s.commands;
        reg[id].tools = s.tools;
        if (s.name) reg[id].name = s.name;
        if (s.description) reg[id].description = s.description;
        if (s.version) reg[id].version = s.version;
        try { clearRequireCache(dest); } catch {}
      } catch {}
    }
    saveRegistry(reg);
    const rec = loaded.get(id);
    if (rec && rec.meta) { reg[id] = rec.meta; saveRegistry(reg); }
    return { ok: true, id, commands: (reg[id] && reg[id].commands) || [], tools: (reg[id] && reg[id].tools) || [], flags };
  }
}

async function installFromUrl(url, idHint, source) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return { error: "URL must start with http:// or https://" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(u, { signal: ctl.signal });
    if (!res.ok) return { error: `Download failed HTTP ${res.status}` };
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    const pathname = (() => { try { return new URL(u).pathname; } catch { return "plugin.js"; } })();
    const filename = path.basename(pathname) || "plugin.js";
    let id = String(idHint || "").trim() || filename.replace(/\.(js|cjs|zip)$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 48) || `plugin-${Date.now() % 10000}`;
    if (!validId(id)) id = `plugin-${Date.now() % 10000}`;
    return await installFromBuffer({ id, buf, filename, source: source || `url:${u.slice(0, 120)}` });
  } catch (e) {
    return { error: `Download failed: ${String(e.message || e).slice(0, 200)}` };
  } finally {
    clearTimeout(t);
  }
}

function pluginListText() {
  const all = listPlugins();
  if (!all.length) return "🔌 Plugins: (none)\nInstall: reply to a .js/.zip file with /plugin";
  const lines = [`🔌 Plugins (${all.length}):`];
  for (const p of all) {
    const cmds = (p.commands || []).map((c) => `/${c}`).join(" ") || "(no commands)";
    const tools = (p.tools || []).map((t) => t.name || t).join(" ");
    const hookCount = Object.values(p.hooks || {}).reduce((s, n) => s + (Number(n) || 0), 0);
    lines.push(`${p.enabled ? "✅" : "⏸"} \`${p.id}\`${p.version ? ` v${p.version}` : ""} - ${cmds}${tools ? ` (+${(p.tools || []).length} tools: ${tools})` : ""}${hookCount ? ` (+${hookCount} hooks)` : ""}${p.description ? `\n    ${p.description.slice(0, 120)}` : ""}`);
  }
  return lines.join("\n");
}

function middleware() {
  return async (ctx, next) => {
    try {
      const text = ctx.message && ctx.message.text ? String(ctx.message.text) : "";
      const m = text.match(/^\/([A-Za-z0-9_]{1,32})(@[\w_]+)?(\s+([\s\S]*))?$/);
      if (!m) return next();
      const cmd = m[1].toLowerCase();
      const found = findCommand(cmd);
      if (!found) return next();
      const arg = (m[4] || "").trim();
      try {
        await found.handler(ctx, arg, _api);
      } catch (e) {
        try { await ctx.reply(`⚠️ Plugin \`${found.id}\` /${cmd} failed: ${String(e.message || e).slice(0, 300)}`, { parse_mode: "Markdown" }); } catch {}
      }
      return;
    } catch {
      return next();
    }
  };
}

module.exports = {
  PLUGINS_DIR,
  REGISTRY_PATH,
  ensureDirs,
  loadRegistry,
  saveRegistry,
  loadAll,
  reloadAll,
  setEnabled,
  removePlugin,
  listPlugins,
  pluginListText,
  findCommand,
  findTool,
  getToolDefs,
  callTool,
  HOOK_KINDS,
  transformInput,
  transformOutput,
  runBeforeTool,
  runAfterTool,
  summarizeMod,
  installFromBuffer,
  installFromUrl,
  middleware,
  validId,
  safetyScan,
  _loaded: loaded,
};
