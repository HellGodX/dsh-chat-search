/**
 * dsh-chat-search — 把 DSH 的会话记录做成能搜的。
 *
 * 数据就在 C:\Users\Administrator\.dsh\sessions\<workspace>\<session>\session.v4.jsonl.zstd，
 * 一行一个事件，user/message 和 assistant/message 里取 text 块。
 * 解压走 node 自带的 zlib.zstdDecompressSync，不引依赖。
 *
 * 两种跑法：
 *   1) 当 DSH 插件：apply(ctx) 里注册 /api/chatsearch 和 /chat-search
 *   2) 单独跑：node lib/index.js --standalone   （默认 http://127.0.0.1:50780/）
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const name = "dsh-chat-search";
export const inject = ["webServer"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESS_ROOT = process.env.DSH_SESSIONS_DIR || "C:\\Users\\Administrator\\.dsh\\sessions";
const INDEX_FILE = path.join(SESS_ROOT, ".chat-search-index.json");

const cache = new Map(); // file -> { mtimeMs, size, docs }

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walk(p, out);
    } else if (e.name === "session.v4.jsonl.zstd") {
      out.push(p);
    }
  }
  return out;
}

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// DSH 的会话文件是「一帧一段」边聊边追加的，zstdDecompressSync 只认第一帧，
// 所以按帧边界切开、一帧一帧解，拼回来。帧头魔数 28 B5 2F FD。
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function decompressFrames(buf) {
  const magics = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) magics.push(i);
  }
  if (!magics.length) return "";
  const parts = [];
  let start = 0;
  for (let k = 1; k < magics.length; k++) {
    const end = magics[k];
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
      start = end;
    } catch {
      // 压缩数据里撞上魔数会切歪；这一刀跳过，接着下一刀
    }
  }
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(start)));
  } catch {}
  return Buffer.concat(parts).toString("utf8");
}

function parseFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.docs;

  let text = "";
  try {
    text = decompressFrames(fs.readFileSync(file));
  } catch {
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, docs: [] });
    return [];
  }

  const docs = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const d = ev.data || {};
    const t = ev.time || d.time || null;
    if (ev.type === "user/message") {
      const body = textOf(d.content);
      if (body) docs.push({ role: "user", t, text: body });
    } else if (ev.type === "assistant/message") {
      const msg = d.message || {};
      const body = textOf(msg.content);
      if (body) docs.push({ role: "assistant", t, text: body });
    }
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, docs });
  return docs;
}

function sessionMeta(file) {
  // ...\sessions\<workspace>\<session-id>\session.v4.jsonl.zstd
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf("sessions");
  const workspace = i >= 0 && parts[i + 1] ? parts[i + 1] : "";
  const sid = i >= 0 && parts[i + 2] ? parts[i + 2] : path.basename(path.dirname(file));
  return { workspace, sid };
}

function loadAll() {
  const files = walk(SESS_ROOT);
  const out = [];
  for (const f of files) {
    const docs = parseFile(f);
    if (!docs.length) continue;
    const meta = sessionMeta(f);
    out.push({ file: f, ...meta, docs });
  }
  out.sort((a, b) => {
    const ta = a.docs[a.docs.length - 1]?.t || "";
    const tb = b.docs[b.docs.length - 1]?.t || "";
    return String(tb).localeCompare(String(ta));
  });
  return out;
}

function snippet(text, idx, len) {
  const half = Math.max(40, Math.floor(len / 2));
  const from = Math.max(0, idx - half);
  const to = Math.min(text.length, idx + len + half);
  return (from > 0 ? "…" : "") + text.slice(from, to).replace(/\s+/g, " ") + (to < text.length ? "…" : "");
}

function search(q, limit = 60) {
  const needle = String(q || "").trim();
  if (!needle) return { ok: true, query: "", total: 0, hits: [] };
  const terms = needle.toLowerCase().split(/\s+/).filter(Boolean);
  const sessions = loadAll();
  const hits = [];
  for (const s of sessions) {
    for (let i = 0; i < s.docs.length; i++) {
      const doc = s.docs[i];
      const low = doc.text.toLowerCase();
      if (!terms.every((t) => low.includes(t))) continue;
      const at = low.indexOf(terms[0]);
      hits.push({
        sid: s.sid,
        workspace: s.workspace,
        file: s.file,
        index: i,
        role: doc.role,
        time: doc.t,
        snippet: snippet(doc.text, at, terms[0].length),
      });
    }
  }
  hits.sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));
  const trimmed = hits.slice(0, limit);
  // 顺带给每条前后各两条，前端点开就能看上下文
  const byFile = new Map(sessions.map((s) => [s.file, s.docs]));
  for (const h of trimmed) {
    const docs = byFile.get(h.file) || [];
    h.context = [];
    for (let k = Math.max(0, h.index - 2); k <= Math.min(docs.length - 1, h.index + 2); k++) {
      h.context.push({ role: docs[k].role, time: docs[k].t, text: docs[k].text });
    }
    delete h.file;
  }
  return { ok: true, query: needle, total: hits.length, hits: trimmed, sessions: sessions.length };
}

function stats() {
  const sessions = loadAll();
  const msgs = sessions.reduce((n, s) => n + s.docs.length, 0);
  let bytes = 0;
  return { sessions: sessions.length, messages: msgs, bytes, root: SESS_ROOT };
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function html(res) {
  let page = "";
  try {
    page = fs.readFileSync(path.join(HERE, "web", "index.html"), "utf8");
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    return res.end("页面文件读不到：" + e.message);
  }
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(page);
}

const ASSET_DIR = path.join(HERE, "web", "assets");
const ASSET_TYPES = { ".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif", ".webp": "image/webp" };

function asset(pathname, res) {
  const name = path.basename(pathname);
  const file = path.join(ASSET_DIR, name);
  if (!file.startsWith(ASSET_DIR) || !fs.existsSync(file)) {
    res.statusCode = 404;
    return res.end("not found");
  }
  res.statusCode = 200;
  res.setHeader("content-type", ASSET_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("cache-control", "public, max-age=3600");
  res.end(fs.readFileSync(file));
}

function route(url, res, req) {
  const u = new URL(url, "http://127.0.0.1");
  if (u.pathname.startsWith("/chat-search/assets/")) return asset(u.pathname, res);
  if (u.pathname === "/api/chatsearch") {
    const q = u.searchParams.get("q") || "";
    try {
      return json(res, 200, search(q, Number(u.searchParams.get("limit") || 60)));
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  if (u.pathname === "/api/chatsearch/stats") return json(res, 200, { ok: true, ...stats() });
  if (u.pathname === "/chat-search" || u.pathname === "/" ) return html(res);
  json(res, 404, { ok: false, error: "not found" });
}

// ---- DSH 插件入口 ----
export function apply(ctx) {
  const register = () => {
    ctx.webServer.register({
      kind: "exact",
      path: "/api/chatsearch",
      handler: async (req, res) => route(req.url || "", res, req),
    });
    ctx.webServer.register({
      kind: "exact",
      path: "/api/chatsearch/stats",
      handler: async (req, res) => route(req.url || "", res, req),
    });
    ctx.webServer.register({
      kind: "exact",
      path: "/chat-search",
      handler: async (req, res) => route(req.url || "", res, req),
    });
    for (const name of ["dsniang1.png", "dsniang02.png"]) {
      ctx.webServer.register({
        kind: "exact",
        path: "/chat-search/assets/" + name,
        handler: async (req, res) => asset(req.url || "", res),
      });
    }
  };
  if (typeof ctx.effect === "function") ctx.effect(register, "dsh-chat-search: routes");
  else register();
}

// ---- 单独跑 ----
const standalone = process.argv.includes("--standalone") || process.argv[1] === fileURLToPath(import.meta.url);
if (standalone) {
  const port = Number(process.env.CHAT_SEARCH_PORT || 50780);
  // 先把索引走一遍，省得第一次查询等半天
  setTimeout(() => {
    try {
      const t0 = Date.now();
      const st = stats();
      console.log(`[chat-search] 预热完成：${st.sessions} 个会话 / ${st.messages} 条消息，${Date.now() - t0}ms`);
    } catch (e) {
      console.log("[chat-search] 预热失败：" + e.message);
    }
  }, 200);
  http
    .createServer((req, res) => route(req.url || "/", res, req))
    .listen(port, "127.0.0.1", () => {
      console.log(`[chat-search] http://127.0.0.1:${port}/  数据目录：${SESS_ROOT}`);
    });
}
