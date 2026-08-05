import http from "node:http";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const maxBodyBytes = 1_000_000;
const dataDir = path.join(rootDir, "data");
const recordsFile = path.join(dataDir, "records.json");
const recordsTempFile = path.join(dataDir, "records.json.tmp");
const feishuCache = new Map();
const feishuCacheTtl = 5 * 60 * 1000;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      throw new Error("请求内容过大");
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readSharedRecords() {
  try {
    const records = JSON.parse(await readFile(recordsFile, "utf8"));
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

async function writeSharedRecords(records) {
  if (!Array.isArray(records) || records.length > 10_000) {
    throw new Error("看板数据格式无效或条数过多");
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(recordsTempFile, JSON.stringify(records, null, 2), "utf8");
  await rename(recordsTempFile, recordsFile);
}

function isAllowedFeishuUrl(value) {
  try {
    const target = new URL(value);
    const host = target.hostname.toLowerCase();
    return (
      target.protocol === "https:" &&
      (host === "feishu.cn" ||
        host.endsWith(".feishu.cn") ||
        host === "larksuite.com" ||
        host.endsWith(".larksuite.com"))
    );
  } catch {
    return false;
  }
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser location.
    }
  }

  return undefined;
}

async function importFeishuDocument(sourceUrl) {
  if (!isAllowedFeishuUrl(sourceUrl)) {
    throw new Error("请输入有效的飞书表格或文档链接");
  }

  const { chromium } = await import("playwright");
  const executablePath = await findBrowserExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    const target = new URL(sourceUrl);
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: target.origin,
    });

    const page = await context.newPage();
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(8_000);

    if (page.url().includes("/accounts/page/login")) {
      throw new Error("该飞书链接仍需要登录，请开启互联网链接查看权限");
    }

    if (/\/sheets\//.test(page.url())) {
      const canvas = page.locator("canvas.faster-single-canvas").first();
      await canvas.waitFor({ state: "visible", timeout: 25_000 });
      const box = await canvas.boundingBox();
      if (!box) throw new Error("未找到飞书表格数据区域");

      await page.mouse.click(box.x + 80, box.y + 38);
      await page.keyboard.press("Control+A");
      await page.waitForTimeout(500);
      await page.evaluate(() => navigator.clipboard.writeText("__FEISHU_EMPTY__"));
      await page.keyboard.press("Control+C");
      await page.waitForTimeout(1_500);
      let clipboard = await page.evaluate(() => navigator.clipboard.readText());

      if (!clipboard || clipboard === "__FEISHU_EMPTY__") {
        await page.keyboard.press("Control+C");
        await page.waitForTimeout(1_500);
        clipboard = await page.evaluate(() => navigator.clipboard.readText());
      }

      if (!clipboard || clipboard === "__FEISHU_EMPTY__") {
        throw new Error("表格没有可复制的数据，请确认链接允许复制");
      }

      return {
        kind: "sheet",
        title: await page.title(),
        matrix: clipboard
          .trim()
          .split(/\r?\n/)
          .map((line) => line.split("\t")),
      };
    }

    const tables = await page.locator("table").evaluateAll((elements) =>
      elements.map((table) =>
        [...table.rows].map((row) =>
          [...row.cells].map((cell) => cell.innerText.trim()),
        ),
      ),
    );
    const usableTable = tables.find((table) => table.length > 1);
    if (usableTable) {
      return { kind: "doc-table", title: await page.title(), matrix: usableTable };
    }

    const text = (await page.locator("body").innerText()).trim();
    const tabularLines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (tabularLines.length < 2) {
      throw new Error("文档中未识别到可导入的表格");
    }

    return {
      kind: "doc-text",
      title: await page.title(),
      text,
    };
  } finally {
    await browser.close();
  }
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const relativePath = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  const filePath = path.resolve(rootDir, relativePath);

  if (!filePath.startsWith(rootDir + path.sep)) {
    sendJson(response, 403, { error: "禁止访问" });
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "页面不存在" });
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && request.url === "/api/records") {
      sendJson(response, 200, { records: await readSharedRecords() });
      return;
    }

    if (request.method === "PUT" && request.url === "/api/records") {
      const body = await readJsonBody(request);
      await writeSharedRecords(body.records);
      sendJson(response, 200, { ok: true, count: body.records.length });
      return;
    }

    if (request.method === "POST" && request.url === "/api/feishu-import") {
      const body = await readJsonBody(request);
      const sourceUrl = String(body.url || "");
      const cached = feishuCache.get(sourceUrl);
      const result = cached && Date.now() - cached.createdAt < feishuCacheTtl
        ? cached.result
        : await importFeishuDocument(sourceUrl);
      if (!cached || result !== cached.result) {
        feishuCache.set(sourceUrl, { createdAt: Date.now(), result });
      }
      sendJson(response, 200, result);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "请求方式不支持" });
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "请求处理失败",
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Intern dashboard running at http://localhost:${port}`);
});
