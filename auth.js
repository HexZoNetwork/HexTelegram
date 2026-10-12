/**
 * HexTelegram Auth - OAuth provider framework (Antigravity full clone + ChatGPT starter)
 * Non-commercial (HXZ License). See LICENCE.
 *
 * Providers:
 *  - apikey      : legacy config.apis pool (OpenAI-compatible baseURL + key)
 *  - antigravity : Google OAuth PKCE -> Antigravity Unified Gateway (Gemini-style)
 *                  Full port of opencode-antigravity-auth flow for Telegram bot context.
 *  - chatgpt     : Generic OAuth PKCE starter (experimental). Stores OAuth access/
 *                  refresh tokens and injects them as Bearer against a standard
 *                  OpenAI-compatible /chat/completions endpoint (your proxy or API).
 *
 * Telegram-friendly manual flow (no public callback server needed):
 *  1. /login antigravity  -> bot DMs an authorize URL + instructions
 *  2. User opens URL, logs in with Google, Google redirects to
 *     http://localhost:51121/oauth-callback?code=...&state=...
 *     (page will fail to load on their device - that's expected)
 *  3. User copies FULL redirect URL (or just `code`) and pastes back:
 *     /login callback <full_url>   OR   /login code <code>
 *  4. Bot exchanges code -> refresh|projectId, stores in auth.json
 *
 * auth.json shape:
 * {
 *   "activeProvider": "apikey|antigravity|chatgpt",
 *   "activeIndex": { "antigravity": 0, "chatgpt": 0 },
 *   "pending": {
 *     "antigravity": { "verifier": "...", "projectId": "", "state": "...", "createdAt": 123 },
 *     "chatgpt": { ... }
 *   },
 *   "accounts": {
 *     "antigravity": [ { "email": "...", "refresh": "rt|proj", "projectId": "...",
 *                        "access": "...", "expires": 123 } ],
 *     "chatgpt": [ { "email": "", "refresh": "...", "access": "...", "expires": 123 } ]
 *   }
 * }
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AUTH_PATH = path.join(__dirname, "auth.json");

const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const ANTIGRAVITY_CLIENT_SECRET = "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";
const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";

const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_PROD,
];
const ANTIGRAVITY_LOAD_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
];
const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";
const ANTIGRAVITY_VERSION = "1.18.3";

function antigravityHeaders() {
  const platform = process.platform === "win32" ? "WINDOWS" : "MACOS";
  return {
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${ANTIGRAVITY_VERSION} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${platform}","pluginType":"GEMINI"}`,
  };
}
const GEMINI_CLI_UA = "google-api-nodejs-client/9.15.1";

const CHATGPT_DEFAULTS = {
  clientId: "pdlLIX2Y72MIl2rhLhTE456m9bXHTq9h",
  authUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:51122/oauth-callback",
  scopes: ["openid", "profile", "email", "offline_access"],
  baseURL: "https://api.openai.com/v1",
};

function blankAuth() {
  return {
    activeProvider: "apikey",
    activeIndex: { antigravity: 0, chatgpt: 0 },
    pending: {},
    accounts: { antigravity: [], chatgpt: [] },
  };
}
function loadAuth() {
  try {
    const raw = fs.readFileSync(AUTH_PATH, "utf8");
    const a = JSON.parse(raw);
    if (!a || typeof a !== "object") return blankAuth();
    if (!a.accounts) a.accounts = { antigravity: [], chatgpt: [] };
    if (!Array.isArray(a.accounts.antigravity)) a.accounts.antigravity = [];
    if (!Array.isArray(a.accounts.chatgpt)) a.accounts.chatgpt = [];
    if (!a.activeIndex) a.activeIndex = { antigravity: 0, chatgpt: 0 };
    if (!a.pending) a.pending = {};
    if (!a.activeProvider) a.activeProvider = "apikey";
    return a;
  } catch {
    return blankAuth();
  }
}
function saveAuth(a) {
  try {
    fs.writeFileSync(AUTH_PATH, JSON.stringify(a, null, 2) + "\n");
    return true;
  } catch (e) {
    console.error("saveAuth failed:", e.message);
    return false;
  }
}
function getActiveProvider(config) {
  const p = (config && config.auth && config.auth.provider) || loadAuthCached().activeProvider || "apikey";
  if (["apikey", "antigravity", "chatgpt"].includes(p)) return p;
  return "apikey";
}
let _authCache = null;
function loadAuthCached() {
  if (!_authCache) _authCache = loadAuth();
  return _authCache;
}
function reloadAuthCache() {
  _authCache = loadAuth();
  return _authCache;
}
function persistAuth() {
  if (_authCache) saveAuth(_authCache);
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
function encodeState(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}
function decodeState(state) {
  const normalized = String(state || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  if (!parsed || typeof parsed.verifier !== "string") throw new Error("Missing PKCE verifier in state");
  return { verifier: parsed.verifier, projectId: typeof parsed.projectId === "string" ? parsed.projectId : "" };
}

async function authorizeAntigravity(projectId = "") {
  const { verifier, challenge } = generatePKCE();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", encodeState({ verifier, projectId: projectId || "" }));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return { url: url.toString(), verifier, projectId: projectId || "", state: encodeState({ verifier, projectId: projectId || "" }) };
}

async function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(options || {}), signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchProjectID(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": GEMINI_CLI_UA,
    "Client-Metadata": antigravityHeaders()["Client-Metadata"],
  };
  const endpoints = [...new Set([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS])];
  for (const base of endpoints) {
    try {
      const res = await fetchWithTimeout(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: process.platform === "win32" ? "WINDOWS" : "MACOS", pluginType: "GEMINI" } }),
      }, 10000);
      if (!res.ok) continue;
      const data = await res.json().catch(() => ({}));
      if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) return data.cloudaicompanionProject;
      if (data.cloudaicompanionProject && typeof data.cloudaicompanionProject.id === "string" && data.cloudaicompanionProject.id) return data.cloudaicompanionProject.id;
    } catch {}
  }
  return "";
}

function calcExpiry(startMs, expiresIn) {
  const s = typeof expiresIn === "number" ? expiresIn : 3600;
  if (!Number.isFinite(s) || s <= 0) return startMs;
  return startMs + s * 1000;
}

async function exchangeAntigravity(code, stateOrVerifier, projectIdHint = "") {
  let verifier = "";
  let projectId = projectIdHint || "";
  const s = String(stateOrVerifier || "");
  if (s.includes("." ) || s.length > 60) {
    try {
      const d = decodeState(s);
      verifier = d.verifier;
      projectId = d.projectId || projectId;
    } catch {
      verifier = s;
    }
  } else {
    verifier = s;
  }
  if (!verifier) throw new Error("Missing PKCE verifier - run /login antigravity again first");
  const start = Date.now();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "Accept": "*/*", "User-Agent": GEMINI_CLI_UA },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code: String(code || "").trim(),
      grant_type: "authorization_code",
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Token exchange failed HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const tok = await res.json().catch(() => ({}));
  if (!tok.refresh_token) throw new Error("Missing refresh_token - did you use 'prompt=consent'? Try login again");
  let email = "";
  try {
    const u = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": GEMINI_CLI_UA },
    });
    if (u.ok) {
      const j = await u.json().catch(() => ({}));
      email = j.email || "";
    }
  } catch {}
  if (!projectId) {
    try { projectId = await fetchProjectID(tok.access_token); } catch {}
  }
  const storedRefresh = `${tok.refresh_token}|${projectId || ""}`;
  return {
    email,
    refresh: storedRefresh,
    refreshToken: tok.refresh_token,
    projectId: projectId || "",
    access: tok.access_token,
    expires: calcExpiry(start, tok.expires_in),
  };
}

function parseRefreshParts(refresh) {
  const [rt = "", pid = "", managed = ""] = String(refresh || "").split("|");
  return { refreshToken: rt, projectId: pid || undefined, managedProjectId: managed || undefined };
}

async function refreshAntigravityAccount(acc) {
  const { refreshToken } = parseRefreshParts(acc.refresh || acc.refreshToken || "");
  if (!refreshToken) throw new Error("Account has no refresh_token - re-login");
  const start = Date.now();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": GEMINI_CLI_UA },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Refresh failed HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const tok = await res.json().catch(() => ({}));
  acc.access = tok.access_token || acc.access;
  acc.expires = calcExpiry(start, tok.expires_in);
  if (tok.refresh_token) {
    const parts = parseRefreshParts(acc.refresh);
    acc.refresh = `${tok.refresh_token}|${parts.projectId || acc.projectId || ""}`;
  }
  return acc;
}

function tokenExpired(acc, skewMs = 60000) {
  if (!acc || !acc.access || typeof acc.expires !== "number") return true;
  return acc.expires <= Date.now() + skewMs;
}

async function getValidAntigravityToken(idx = 0) {
  const a = loadAuthCached();
  const list = a.accounts.antigravity || [];
  if (!list.length) throw new Error("No Antigravity accounts - run /login antigravity first");
  const i = Math.min(Math.max(0, idx || 0), list.length - 1);
  const acc = list[i];
  if (!tokenExpired(acc)) return { token: acc.access, account: acc, index: i };
  await refreshAntigravityAccount(acc);
  persistAuth();
  return { token: acc.access, account: acc, index: i };
}

function chatgptCfg(config) {
  return Object.assign({}, CHATGPT_DEFAULTS, (config && config.auth && config.auth.chatgpt) || {});
}
async function authorizeChatGPT(config, extra = {}) {
  const c = chatgptCfg(config);
  const { verifier, challenge } = generatePKCE();
  const state = encodeState({ verifier, projectId: "" });
  const url = new URL(c.authUrl);
  url.searchParams.set("client_id", c.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", c.redirectUri);
  url.searchParams.set("scope", (Array.isArray(c.scopes) ? c.scopes : [c.scopes]).join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (extra.prompt) url.searchParams.set("prompt", extra.prompt);
  return { url: url.toString(), verifier, state };
}
async function exchangeChatGPT(config, code, verifier) {
  const c = chatgptCfg(config);
  if (!verifier) throw new Error("Missing verifier - run /login chatgpt first");
  const start = Date.now();
  const res = await fetch(c.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      grant_type: "authorization_code",
      code: String(code || "").trim(),
      redirect_uri: c.redirectUri,
      code_verifier: String(verifier || "").trim(),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ChatGPT exchange failed HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const tok = await res.json().catch(() => ({}));
  if (!tok.access_token && !tok.accessToken) throw new Error("No access_token in response");
  return {
    email: tok.email || "",
    refresh: tok.refresh_token || tok.refreshToken || "",
    access: tok.access_token || tok.accessToken,
    expires: calcExpiry(start, tok.expires_in || tok.expiresIn),
  };
}
async function refreshChatGPTAccount(config, acc) {
  const c = chatgptCfg(config);
  if (!acc.refresh) throw new Error("ChatGPT account has no refresh_token - re-login");
  const start = Date.now();
  const res = await fetch(c.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, grant_type: "refresh_token", refresh_token: acc.refresh }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ChatGPT refresh failed HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const tok = await res.json().catch(() => ({}));
  acc.access = tok.access_token || tok.accessToken || acc.access;
  acc.expires = calcExpiry(start, tok.expires_in || tok.expiresIn);
  if (tok.refresh_token || tok.refreshToken) acc.refresh = tok.refresh_token || tok.refreshToken;
  return acc;
}
async function getValidChatGPTToken(config, idx = 0) {
  const a = loadAuthCached();
  const list = a.accounts.chatgpt || [];
  if (!list.length) throw new Error("No ChatGPT accounts - run /login chatgpt first");
  const i = Math.min(Math.max(0, idx || 0), list.length - 1);
  const acc = list[i];
  if (!tokenExpired(acc)) return { token: acc.access, account: acc, index: i };
  await refreshChatGPTAccount(config, acc);
  persistAuth();
  return { token: acc.access, account: acc, index: i };
}

function cleanSchemaForAntigravity(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 8) return schema;
  if (Array.isArray(schema)) return schema.map((x) => cleanSchemaForAntigravity(x, depth + 1));
  const out = {};
  const KEEP = new Set(["type", "properties", "required", "description", "enum", "items", "anyOf", "allOf", "oneOf", "additionalProperties"]);
  for (const [k, v] of Object.entries(schema)) {
    if (k === "const") {
      if (schema.type === "object") continue;
      out.enum = [v];
      continue;
    }
    if (k === "$ref" || k === "$defs" || k === "definitions" || k === "$schema" || k === "$id" || k === "default" || k === "examples" || k === "title" && depth > 0) continue;
    if (!KEEP.has(k)) {
      continue;
    }
    if (k === "properties" && v && typeof v === "object") {
      const p = {};
      for (const [pk, pv] of Object.entries(v)) p[pk] = cleanSchemaForAntigravity(pv, depth + 1);
      out[k] = p;
      continue;
    }
    if ((k === "anyOf" || k === "allOf" || k === "oneOf") && Array.isArray(v)) {
      out[k] = v.map((x) => cleanSchemaForAntigravity(x, depth + 1));
      continue;
    }
    if ((k === "items" || k === "additionalProperties") && typeof v === "object") {
      out[k] = cleanSchemaForAntigravity(v, depth + 1);
      continue;
    }
    out[k] = v;
  }
  if (out.type === "object" && (!out.properties || !Object.keys(out.properties).length)) {
    out.properties = { _placeholder: { type: "string", description: "Placeholder. Always pass true." } };
  }
  return out;
}
function sanitizeFnName(name) {
  let n = String(name || "tool").slice(0, 64);
  n = n.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  if (!/^[a-zA-Z_]/.test(n)) n = "_" + n.slice(0, 63);
  return n || "_tool";
}
function openAIToolsToAntigravity(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const decls = [];
  for (const t of tools) {
    const fn = t && t.function ? t.function : t;
    if (!fn || !fn.name) continue;
    let params = fn.parameters;
    if (typeof params === "string") {
      try { params = JSON.parse(params); } catch { params = { type: "object", properties: {} }; }
    }
    if (!params || typeof params !== "object") params = { type: "object", properties: {} };
    decls.push({
      name: sanitizeFnName(fn.name),
      description: String(fn.description || "").slice(0, 2000),
      parameters: cleanSchemaForAntigravity(params),
    });
  }
  if (!decls.length) return undefined;
  return [{ functionDeclarations: decls }];
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
  }
  return "";
}
function imagePartsOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (p && p.type === "image_url") {
      const u = p.image_url && p.image_url.url ? String(p.image_url.url) : "";
      if (u.startsWith("data:")) {
        const m = u.match(/^data:([^;]+);base64,(.*)$/s);
        if (m) out.push({ inlineData: { mimeType: m[1], data: m[2].slice(0, 4000000) } });
      } else if (u.startsWith("http")) {
        out.push({ text: `[image: ${u.slice(0, 500)}]` });
      }
    }
  }
  return out;
}
function openAIMessagesToAntigravity(messages) {
  const contents = [];
  const sysParts = [];
  for (const m of messages || []) {
    const role = m.role;
    if (role === "system") {
      const t = textOf(m.content);
      if (t.trim()) sysParts.push({ text: t.slice(0, 8000) });
      continue;
    }
    if (role === "user") {
      const parts = [];
      const t = textOf(m.content);
      if (t) parts.push({ text: t.slice(0, 12000) });
      for (const ip of imagePartsOf(m.content)) parts.push(ip);
      if (!parts.length) parts.push({ text: "(empty)" });
      contents.push({ role: "user", parts });
      continue;
    }
    if (role === "assistant") {
      const parts = [];
      const t = textOf(m.content);
      if (t && t.trim()) parts.push({ text: t.slice(0, 12000) });
      for (const tc of m.tool_calls || []) {
        const fname = sanitizeFnName(tc.function && tc.function.name);
        let args = {};
        try { args = JSON.parse(tc.function && tc.function.arguments || "{}"); } catch { args = {}; }
        parts.push({ functionCall: { name: fname, args, id: tc.id || `call_${parts.length}` } });
      }
      if (!parts.length) continue;
      contents.push({ role: "model", parts });
      continue;
    }
    if (role === "tool") {
      const name = sanitizeFnName(m.name || "tool");
      const id = m.tool_call_id || `call_x`;
      const resp = String(m.content || "").slice(0, 8000);
      contents.push({ role: "user", parts: [{ functionResponse: { name, id, response: { result: resp } } }] });
      continue;
    }
  }
  const merged = [];
  for (const c of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role && last.role === "user") {
      last.parts.push(...c.parts);
    } else merged.push(c);
  }
  return {
    contents: merged.length ? merged : [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction: sysParts.length ? { parts: sysParts } : undefined,
  };
}

function isThinkingModel(model) {
  return /thinking|opus|pro-high|pro-low|flash/i.test(String(model || ""));
}

async function antigravityChat({ model, messages, tools, temperature, maxTokens, signal, onContent, accountIndex }) {
  const a = loadAuthCached();
  const list = a.accounts.antigravity || [];
  if (!list.length) throw new Error("No Antigravity accounts - /login antigravity first");
  const order = list.map((_, i) => (((accountIndex ?? a.activeIndex.antigravity ?? 0) + i) % list.length));
  const { contents, systemInstruction } = openAIMessagesToAntigravity(messages);
  const maxOut = Math.max(Number(maxTokens) || 2048, 2048);
  const thinkingBudget = 8000;
  const generationConfig = {
    maxOutputTokens: isThinkingModel(model) ? Math.max(maxOut, thinkingBudget + 1000) : maxOut,
    temperature: typeof temperature === "number" ? temperature : 0.7,
  };
  if (isThinkingModel(model)) generationConfig.thinkingConfig = { thinkingBudget, includeThoughts: true };

  const toolsPayload = openAIToolsToAntigravity(tools);
  const modelMap = {
    "antigravity-gemini-3-pro": "gemini-3-pro-high",
    "antigravity-gemini-3.1-pro": "gemini-3-pro-high",
    "antigravity-gemini-3-flash": "gemini-3-flash",
    "antigravity-claude-sonnet-4-6": "claude-sonnet-4-6",
    "antigravity-claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
    "gemini-3-pro-high": "gemini-3-pro-high",
    "gemini-3-pro-low": "gemini-3-pro-low",
  };
  const agModel = modelMap[String(model)] || String(model || "gemini-3-pro-high").replace(/^antigravity-/, "");

  let lastErr = null;
  for (const idx of order) {
    const acc = list[idx];
    try {
      if (tokenExpired(acc)) await refreshAntigravityAccount(acc);
      const project = acc.projectId || parseRefreshParts(acc.refresh).projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;
      const body = {
        project,
        model: agModel,
        request: {
          contents,
          ...(systemInstruction ? { systemInstruction } : {}),
          generationConfig,
          ...(toolsPayload ? { tools: toolsPayload } : {}),
        },
        userAgent: "antigravity",
        requestId: `htg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      };
      const useStream = !signal || true;
      const headers = { ...antigravityHeaders(), "Content-Type": "application/json", Authorization: `Bearer ${acc.access}` };
      let res = null;
      let endpointErr = null;
      for (const base of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
          const r = await fetch(`${base}/v1internal:streamGenerateContent?alt=sse`, {
            method: "POST", headers: { ...headers, Accept: "text/event-stream" },
            body: JSON.stringify(body), signal,
          });
          if (r.status === 401) {
            await refreshAntigravityAccount(acc);
            headers.Authorization = `Bearer ${acc.access}`;
            const r2 = await fetch(`${base}/v1internal:streamGenerateContent?alt=sse`, {
              method: "POST", headers: { ...headers, Accept: "text/event-stream" },
              body: JSON.stringify(body), signal,
            });
            if (r2.ok || r2.status < 500) { res = r2; break; }
            endpointErr = new Error(`API ${r2.status}`);
            continue;
          }
          if (r.status === 429) { endpointErr = new Error("429 rate-limited"); break; }
          if (r.status >= 500) { endpointErr = new Error(`API ${r.status}`); continue; }
          res = r;
          break;
        } catch (e) {
          endpointErr = e;
          continue;
        }
      }
      if (!res) {
        lastErr = endpointErr || new Error("All Antigravity endpoints unreachable");
        if (/429/.test(String(lastErr && lastErr.message))) continue;
        continue;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        if (res.status === 429) { lastErr = new Error(`429: ${t.slice(0, 200)}`); continue; }
        throw new Error(`Antigravity ${res.status}: ${t.slice(0, 300)}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let content = "";
      const toolMap = new Map();
      let finishReason = null;
      const feedLine = (line) => {
        line = line.trim();
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let ev;
        try { ev = JSON.parse(data); } catch { return; }
        const inner = ev.response || ev;
        const cand = inner.candidates && inner.candidates[0];
        if (!cand) return;
        if (cand.finishReason) finishReason = cand.finishReason;
        const parts = (cand.content && cand.content.parts) || [];
        for (const p of parts) {
          if (typeof p.text === "string" && p.text && !p.thought) {
            content += p.text;
            if (onContent) { try { onContent(content); } catch {} }
          }
          if (p.functionCall) {
            const fc = p.functionCall;
            const id = fc.id || `call_${toolMap.size}`;
            if (!toolMap.has(id)) toolMap.set(id, { id, type: "function", function: { name: fc.name || "", arguments: "" } });
            const cur = toolMap.get(id);
            if (fc.name && !cur.function.name) cur.function.name = fc.name;
            try { cur.function.arguments = JSON.stringify(fc.args || {}); } catch {}
          }
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (value) {
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const ln of lines) feedLine(ln);
          }
          if (done) break;
        }
        if (buf.trim()) feedLine(buf);
      } catch (e) {
        if (signal && signal.aborted) return { content, toolCalls: [...toolMap.values()], finishReason, aborted: true };
        throw e;
      }
      a.activeIndex.antigravity = idx;
      persistAuth();
      return { content, toolCalls: [...toolMap.values()], finishReason, aborted: false };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  persistAuth();
  throw new Error(`All ${list.length} Antigravity accounts failed. Last: ${(lastErr && lastErr.message) || "unknown"}`);
}

async function checkAntigravityQuota(idx = 0) {
  const { token, account } = await getValidAntigravityToken(idx);
  const project = account.projectId || parseRefreshParts(account.refresh).projectId || "";
  return { ok: true, email: account.email || "?", project: project || "(default)", expires: account.expires };
}

function parseCallbackUrl(fullUrl) {
  const u = new URL(String(fullUrl || "").trim());
  return { code: u.searchParams.get("code") || "", state: u.searchParams.get("state") || "" };
}

function authStatusText(config) {
  const a = loadAuthCached();
  const prov = (config && config.auth && config.auth.provider) || a.activeProvider || "apikey";
  const ag = a.accounts.antigravity || [];
  const cg = a.accounts.chatgpt || [];
  const lines = [`🔐 Auth provider: \`${prov}\``];
  lines.push(`• Antigravity accounts: ${ag.length}` + (ag.length ? ` (active #${(a.activeIndex.antigravity || 0) + 1})` : ""));
  ag.forEach((x, i) => {
    const exp = x.expires ? new Date(x.expires).toISOString().slice(11, 16) : "?";
    lines.push(`   #${i + 1} ${x.email || "?"} proj=${(x.projectId || parseRefreshParts(x.refresh).projectId || "?").slice(0, 24)} exp=${exp}`);
  });
  lines.push(`• ChatGPT accounts: ${cg.length}` + (cg.length ? ` (active #${(a.activeIndex.chatgpt || 0) + 1})` : ""));
  cg.forEach((x, i) => lines.push(`   #${i + 1} ${x.email || "?"} exp=${x.expires ? new Date(x.expires).toISOString().slice(0, 10) : "?"}`));
  const apis = (config && Array.isArray(config.apis) && config.apis.length) || 0;
  lines.push(`• API-key pool: ${apis} endpoint(s)`);
  lines.push(`Switch: /login apikey|antigravity|chatgpt`);
  return lines.join("\n");
}

module.exports = {
  AUTH_PATH,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  CHATGPT_DEFAULTS,
  loadAuth,
  saveAuth,
  loadAuthCached,
  reloadAuthCache,
  persistAuth,
  getActiveProvider,
  generatePKCE,
  encodeState,
  decodeState,
  authorizeAntigravity,
  exchangeAntigravity,
  refreshAntigravityAccount,
  getValidAntigravityToken,
  authorizeChatGPT,
  exchangeChatGPT,
  refreshChatGPTAccount,
  getValidChatGPTToken,
  antigravityChat,
  checkAntigravityQuota,
  parseCallbackUrl,
  parseRefreshParts,
  authStatusText,
  chatgptCfg,
  cleanSchemaForAntigravity,
  openAIToolsToAntigravity,
  openAIMessagesToAntigravity,
};
