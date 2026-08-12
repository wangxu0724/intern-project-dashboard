import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const appId = process.env.FEISHU_APP_ID || "";
const appSecret = process.env.FEISHU_APP_SECRET || "";
const sessions = new Map();
const oauthStates = new Map();
const sessionTtl = 7 * 24 * 60 * 60 * 1000;
const stateTtl = 10 * 60 * 1000;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(302, { location, "cache-control": "no-store" });
  response.end();
}

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  const item = cookies.find((cookie) => cookie.trim().startsWith(`${name}=`));
  return item ? decodeURIComponent(item.trim().slice(name.length + 1)) : "";
}

function setSessionCookie(response, sessionId) {
  response.setHeader("set-cookie", `feishu_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtl / 1000)}`);
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) reject(new Error("请求内容过大"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("请求格式无效")); }
    });
    request.on("error", reject);
  });
}

function redirectUri(request) {
  if (process.env.FEISHU_REDIRECT_URI) return process.env.FEISHU_REDIRECT_URI;
  const host = request.headers.host || "localhost";
  const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
  return `${protocol}://${host}/auth/feishu/callback`;
}

function safeReturnTo(value) {
  try {
    const target = new URL(value || "/");
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

function parseFeishuLink(value) {
  let target;
  try { target = new URL(value); } catch { throw new Error("请输入有效的飞书表格链接"); }
  const host = target.hostname.toLowerCase();
  if (target.protocol !== "https:" || !(host === "feishu.cn" || host.endsWith(".feishu.cn") || host === "larksuite.com" || host.endsWith(".larksuite.com"))) {
    throw new Error("仅支持 feishu.cn 或 larksuite.com 链接");
  }
  const match = target.pathname.match(/\/(?:sheets|spreadsheets)\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("链接中没有识别到飞书表格 token");
  return { token: match[1], sheetId: target.searchParams.get("sheet") || "" };
}

function currentSession(request) {
  const id = cookieValue(request, "feishu_session");
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  return session;
}

async function feishuRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code) throw new Error(payload.msg || `飞书接口请求失败（${response.status}）`);
  return payload.data || payload;
}

async function appAccessToken() {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code) throw new Error(payload.msg || "飞书应用授权配置无效");
  return payload.app_access_token;
}

async function exchangeCode(code) {
  const appToken = await appAccessToken();
  return feishuRequest("https://open.feishu.cn/open-apis/authen/v1/access_token", appToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
}

async function listSheets(session, sourceUrl) {
  const { token, sheetId } = parseFeishuLink(sourceUrl);
  const data = await feishuRequest(`https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`, session.accessToken);
  const sheets = (data.sheets || []).map((sheet) => ({
    sheetId: sheet.sheet_id,
    title: sheet.title || sheet.sheet_id,
    index: sheet.index,
  }));
  return { token, sheetId, sheets };
}

async function previewSheet(session, sourceUrl, sheetId, full = false) {
  const { token } = parseFeishuLink(sourceUrl);
  const sheets = await listSheets(session, sourceUrl);
  const selected = sheets.sheets.find((sheet) => sheet.sheetId === sheetId) || sheets.sheets[0];
  if (!selected) throw new Error("没有找到可读取的 Sheet");
  const range = `${selected.sheetId}!A1:Z${full ? 10000 : 200}`;
  const data = await feishuRequest(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(range)}?valueRenderOption=ToString`, session.accessToken);
  return { sheetId: selected.sheetId, title: selected.title, matrix: data.valueRange?.values || data.values || [] };
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const relativePath = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  const filePath = path.resolve(rootDir, relativePath);
  if (!filePath.startsWith(rootDir + path.sep)) return sendJson(response, 403, { error: "禁止访问" });
  try {
    const content = await readFile(filePath);
    response.writeHead(200, { "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-cache" });
    response.end(content);
  } catch { sendJson(response, 404, { error: "页面不存在" }); }
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && requestUrl.pathname === "/api/health") return sendJson(response, 200, { ok: true, oauthConfigured: Boolean(appId && appSecret) });
    if (request.method === "GET" && requestUrl.pathname === "/api/feishu/status") {
      const session = currentSession(request);
      return sendJson(response, 200, { connected: Boolean(session), configured: Boolean(appId && appSecret), name: session?.name || "" });
    }
    if (request.method === "GET" && requestUrl.pathname === "/auth/feishu") {
      if (!appId || !appSecret) return sendJson(response, 503, { error: "服务端尚未配置飞书应用授权" });
      const state = crypto.randomBytes(18).toString("hex");
      oauthStates.set(state, { returnTo: safeReturnTo(requestUrl.searchParams.get("return_to")), expiresAt: Date.now() + stateTtl });
      const params = new URLSearchParams({ app_id: appId, redirect_uri: redirectUri(request), response_type: "code", state });
      return redirect(response, `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${params}`);
    }
    if (request.method === "GET" && requestUrl.pathname === "/auth/feishu/callback") {
      const state = oauthStates.get(requestUrl.searchParams.get("state"));
      oauthStates.delete(requestUrl.searchParams.get("state"));
      if (!state || state.expiresAt < Date.now()) return sendJson(response, 400, { error: "授权已过期，请重新授权" });
      if (requestUrl.searchParams.get("error")) return redirect(response, `${state.returnTo}?feishu_auth=failed`);
      const token = await exchangeCode(requestUrl.searchParams.get("code"));
      const sessionId = crypto.randomBytes(24).toString("hex");
      sessions.set(sessionId, { accessToken: token.access_token, name: token.name || "", expiresAt: Date.now() + Math.min(sessionTtl, (token.expires_in || 7200) * 1000) });
      setSessionCookie(response, sessionId);
      return redirect(response, state.returnTo);
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/feishu/sheets") {
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "请先授权飞书" });
      return sendJson(response, 200, await listSheets(session, requestUrl.searchParams.get("url") || ""));
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/feishu/preview") {
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "请先授权飞书" });
      return sendJson(response, 200, await previewSheet(session, requestUrl.searchParams.get("url") || "", requestUrl.searchParams.get("sheet_id") || "", requestUrl.searchParams.get("full") === "1"));
    }
    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "请求方式不支持" });
    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 400, { error: error instanceof Error ? error.message : "请求处理失败" });
  }
});

setInterval(() => {
  for (const [key, value] of sessions) if (value.expiresAt < Date.now()) sessions.delete(key);
  for (const [key, value] of oauthStates) if (value.expiresAt < Date.now()) oauthStates.delete(key);
}, 60_000).unref();

server.listen(port, "0.0.0.0", () => console.log(`Intern dashboard running at http://localhost:${port}`));
