import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(ROOT, "dist");
const PORT = Number(process.env.PORT || 4173);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 4174);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_VIDEO_FRAME_BYTES = Number(process.env.VIDEO_MAX_FRAME_BYTES || 2 * 1024 * 1024);
const HTTPS_CERT_FILE = resolve(ROOT, process.env.HTTPS_CERT_FILE || "certs/ifocus.pem");
const HTTPS_KEY_FILE = resolve(ROOT, process.env.HTTPS_KEY_FILE || "certs/ifocus-key.pem");
const HTTPS_PFX_FILE = resolve(ROOT, process.env.HTTPS_PFX_FILE || "certs/ifocus.pfx");
const HTTPS_PFX_PASSPHRASE_FILE = resolve(
  ROOT,
  process.env.HTTPS_PFX_PASSPHRASE_FILE || "certs/ifocus-pfx-passphrase.txt",
);
const FOCUS_BACKEND_URL = process.env.FOCUS_BACKEND_URL || "http://192.168.253.241:5001";
const ACTION_BACKEND_URL = process.env.ACTION_BACKEND_URL || "http://192.168.254.140:8000";
const HTTPS_ENABLED = process.argv.includes("--https") || process.env.HTTPS_ENABLED === "1";
const VIDEO_FEED_ENABLED = process.argv.includes("--video") || process.env.VIDEO_FEED_ENABLED === "1";
const MJPEG_BOUNDARY = "boundary";
const clients = new Set();
const videoClients = new Set();
const focusCommandPaths = new Set([
  "/api/set_focus",
  "/api/stop_temporary_focus",
  "/api/continue_focus",
]);
let latestVideoFrame = null;
const transmissionStats = {
  messagesReceived: 0,
  lastReceivedAt: null,
  lastDisplay: null,
  lastFocusState: null,
  lastDuration: null,
  lastHadText: false,
};
const videoStats = {
  framesReceived: 0,
  lastFrameAt: null,
  lastFrameBytes: 0,
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
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
  if (!["000", "001", "002", "003", "111"].includes(display)) {
    return "display 目前仅支持 000、001、002、003 或 111";
  }
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

function readBinaryBody(request, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > maxBytes) {
      request.resume();
      rejectBody(new Error("请求体过大"));
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        request.resume();
        rejectBody(new Error("请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) resolveBody(Buffer.concat(chunks, totalBytes));
    });
    request.on("error", (error) => {
      if (!settled) rejectBody(error);
    });
  });
}

function isJpeg(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9
  );
}

function writeMjpegFrame(response, frame) {
  response.write(
    `--${MJPEG_BOUNDARY}\r\n` +
      "Content-Type: image/jpeg\r\n" +
      `Content-Length: ${frame.length}\r\n\r\n`,
  );
  response.write(frame);
  response.write("\r\n");
}

async function proxyFocusCommand(request, response, pathname) {
  try {
    const body = await readBinaryBody(request, MAX_BODY_BYTES);
    const upstream = await fetch(new URL(pathname, FOCUS_BACKEND_URL), {
      body,
      headers: {
        "Content-Type": String(request.headers["content-type"] || "application/json"),
      },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Length": responseBody.length,
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    });
    response.end(responseBody);
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "PC 端任务接口响应超时"
      : "无法连接 PC 端任务接口";
    sendJson(response, 502, { status: "error", message });
  }
}

function broadcastVideoFrame(frame) {
  for (const response of videoClients) {
    try {
      writeMjpegFrame(response, frame);
    } catch {
      videoClients.delete(response);
      response.destroy();
    }
  }
}

function loadHttpsOptions() {
  if (existsSync(HTTPS_PFX_FILE) && existsSync(HTTPS_PFX_PASSPHRASE_FILE)) {
    return {
      passphrase: readFileSync(HTTPS_PFX_PASSPHRASE_FILE, "utf8").trim(),
      pfx: readFileSync(HTTPS_PFX_FILE),
    };
  }
  if (existsSync(HTTPS_CERT_FILE) && existsSync(HTTPS_KEY_FILE)) {
    return {
      cert: readFileSync(HTTPS_CERT_FILE),
      key: readFileSync(HTTPS_KEY_FILE),
    };
  }
  return null;
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
    "Permissions-Policy": "camera=(self), microphone=(), screen-wake-lock=(self)",
  });
  createReadStream(filePath).pipe(response);
}

const handleRequest = async (request, response) => {
  const protocol = request.socket.encrypted ? "https" : "http";
  const url = new URL(request.url || "/", `${protocol}://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    });
    response.end();
    return;
  }

  if (request.method === "POST" && focusCommandPaths.has(url.pathname)) {
    await proxyFocusCommand(request, response, url.pathname);
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

  // 代理 action 执行接口，避免 CORS 问题
  if (request.method === "POST" && url.pathname === "/api/action/execute") {
    try {
      const body = await readJsonBody(request);
      const actionUrl = new URL("/api/action/execute", ACTION_BACKEND_URL);
      const upstream = await fetch(actionUrl.toString(), {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
      const responseBody = await upstream.text();
      response.writeHead(upstream.status, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      });
      response.end(responseBody);
    } catch (error) {
      sendJson(response, 502, {
        status: "error",
        message: error instanceof Error && error.name === "TimeoutError"
          ? "action 接口响应超时"
          : "无法连接 action 接口",
      });
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

  if (request.method === "GET" && url.pathname === "/api/video/status") {
    sendJson(response, 200, {
      status: "ok",
      enabled: VIDEO_FEED_ENABLED,
      https_enabled: HTTPS_ENABLED,
      https_port: HTTPS_PORT,
      publisher_active:
        videoStats.lastFrameAt !== null && Date.now() - Date.parse(videoStats.lastFrameAt) < 5_000,
      viewers: videoClients.size,
      frames_received: videoStats.framesReceived,
      last_frame_at: videoStats.lastFrameAt,
      last_frame_bytes: videoStats.lastFrameBytes,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/video/frame") {
    if (!VIDEO_FEED_ENABLED) {
      sendJson(response, 404, { status: "error", message: "视频流功能未启用" });
      return;
    }
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("image/jpeg")) {
      sendJson(response, 415, { status: "error", message: "视频帧必须是 image/jpeg" });
      return;
    }

    try {
      const frame = await readBinaryBody(request, MAX_VIDEO_FRAME_BYTES);
      if (!isJpeg(frame)) {
        sendJson(response, 400, { status: "error", message: "请求体不是合法 JPEG 图片" });
        return;
      }
      latestVideoFrame = frame;
      videoStats.framesReceived += 1;
      videoStats.lastFrameAt = new Date().toISOString();
      videoStats.lastFrameBytes = frame.length;
      broadcastVideoFrame(frame);
      sendJson(response, 202, { status: "ok" });
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "请求体过大";
      sendJson(response, tooLarge ? 413 : 400, {
        status: "error",
        message: tooLarge ? "JPEG 图片帧过大" : "视频帧上传失败",
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/video_feed") {
    if (!VIDEO_FEED_ENABLED) {
      sendJson(response, 404, { status: "error", message: "视频流功能未启用" });
      return;
    }

    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Connection: "keep-alive",
      "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      Expires: "0",
      Pragma: "no-cache",
      "X-Accel-Buffering": "no",
    });
    videoClients.add(response);
    if (latestVideoFrame) writeMjpegFrame(response, latestVideoFrame);
    request.on("close", () => videoClients.delete(response));
    response.on("error", () => videoClients.delete(response));
    return;
  }

  if (request.method === "GET") {
    serveStatic(url.pathname, response);
    return;
  }

  sendJson(response, 404, { status: "error", message: "接口不存在" });
};

const httpServer = createHttpServer(handleRequest);
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`iFocus demo: http://localhost:${PORT}`);
  console.log(`Display API: POST http://localhost:${PORT}/api/display`);
});

if (HTTPS_ENABLED) {
  const httpsOptions = loadHttpsOptions();
  if (!httpsOptions) {
    console.error("HTTPS 证书不存在，请先执行 npm run https:setup");
    process.exitCode = 1;
    httpServer.close();
  } else {
    const httpsServer = createHttpsServer(httpsOptions, handleRequest);
    httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
      console.log(`iFocus HTTPS: https://localhost:${HTTPS_PORT}`);
      if (VIDEO_FEED_ENABLED) {
        console.log(`Camera page: https://<电脑IP>:${HTTPS_PORT}/?camera=1`);
        console.log(`MJPEG feed: https://<电脑IP>:${HTTPS_PORT}/video_feed`);
      }
    });
  }
} else if (VIDEO_FEED_ENABLED) {
  console.warn("视频功能已启用，但未启用 HTTPS；手机摄像头无法启动。请使用 npm run demo:video");
}
