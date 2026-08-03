import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(ROOT, "dist");
const PORT = Number(process.env.PORT || 4173);
const MAX_BODY_BYTES = 64 * 1024;
const clients = new Set();
const transmissionStats = {
  messagesReceived: 0,
  lastReceivedAt: null,
  lastDisplay: null,
  lastFocusState: null,
  lastDuration: null,
  lastHadText: false,
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function normalizeDisplay(value) {
  if (typeof value === "number" && Number.isInteger(value)) return String(value).padStart(3, "0");
  if (typeof value === "string") return value.trim().padStart(3, "0");
  return "";
}

function validateDisplayUpdate(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "请求体必须是 JSON 对象";
  const display = normalizeDisplay(payload.display);
  if (!display) return "缺少 display 字段";
  if (!["000", "001", "002", "003"].includes(display)) return "display 目前仅支持 000、001、002 或 003";
  if (payload.text !== undefined && typeof payload.text !== "string") return "text 必须是字符串";
  if (payload.focus_state !== undefined && typeof payload.focus_state !== "string") return "focus_state 必须是字符串";
  if (payload.duration !== undefined && (!Number.isFinite(payload.duration) || payload.duration < 0)) {
    return "duration 必须是大于或等于 0 的数字";
  }
  return "";
}

function broadcastDisplayUpdate(payload) {
  const eventPayload = {
    ...payload,
    display: normalizeDisplay(payload.display),
    received_at: new Date().toISOString(),
  };
  const message = `event: display\ndata: ${JSON.stringify(eventPayload)}\n\n`;
  for (const response of clients) response.write(message);
  return eventPayload;
}

function recordDisplayUpdate(eventPayload) {
  transmissionStats.messagesReceived += 1;
  transmissionStats.lastReceivedAt = eventPayload.received_at;
  transmissionStats.lastDisplay = eventPayload.display;
  transmissionStats.lastFocusState = eventPayload.focus_state ?? null;
  transmissionStats.lastDuration = eventPayload.duration ?? null;
  transmissionStats.lastHadText = typeof eventPayload.text === "string" && eventPayload.text.length > 0;

  console.log(
    `[display] #${transmissionStats.messagesReceived} ` +
      `code=${eventPayload.display} ` +
      `focus_state=${eventPayload.focus_state ?? "-"} ` +
      `duration=${eventPayload.duration ?? "-"} ` +
      `clients=${clients.size}`,
  );
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        rejectBody(new Error("请求体过大"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(body || "{}"));
      } catch {
        rejectBody(new Error("请求体不是合法 JSON"));
      }
    });
    request.on("error", rejectBody);
  });
}

function serveStatic(requestPath, response) {
  if (!existsSync(DIST)) {
    sendJson(response, 503, { status: "error", message: "请先执行 npm run build" });
    return;
  }

  const requested = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(DIST, safePath);
  if (!filePath.startsWith(DIST) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST, "index.html");
  }

  response.writeHead(200, {
    "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
    "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/display/events") {
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    });
    response.write(`event: connected\ndata: {"status":"ok"}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/display") {
    try {
      const payload = await readJsonBody(request);
      const validationError = validateDisplayUpdate(payload);
      if (validationError) {
        sendJson(response, 400, { status: "error", message: "更新界面失败" });
        return;
      }
      const eventPayload = broadcastDisplayUpdate(payload);
      recordDisplayUpdate(eventPayload);
      sendJson(response, 200, { status: "ok" });
    } catch (error) {
      sendJson(response, 400, { status: "error", message: "更新界面失败" });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      status: "ok",
      display_clients: clients.size,
      messages_received: transmissionStats.messagesReceived,
      last_received_at: transmissionStats.lastReceivedAt,
      last_display: transmissionStats.lastDisplay,
      last_focus_state: transmissionStats.lastFocusState,
      last_duration: transmissionStats.lastDuration,
      last_had_text: transmissionStats.lastHadText,
    });
    return;
  }

  if (request.method === "GET") {
    serveStatic(url.pathname, response);
    return;
  }

  sendJson(response, 404, { status: "error", message: "接口不存在" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`iFocus demo: http://localhost:${PORT}`);
  console.log(`Display API: POST http://localhost:${PORT}/api/display`);
});
