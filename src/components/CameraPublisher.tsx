import { useCallback, useEffect, useRef, useState } from "react";
import { IFOCUS_CAMERA_START_EVENT } from "../camera-events";

type CameraMode = "checking" | "disabled" | "idle" | "starting" | "streaming" | "error";

interface VideoStatus {
  enabled: boolean;
  https_enabled: boolean;
  https_port: number;
}

const FRAME_INTERVAL_MS = 200;
const MAX_CAPTURE_WIDTH = 640;
const LANDSCAPE_ASPECT_RATIO = 16 / 9;
const JPEG_QUALITY = 0.6;

function cameraRequested() {
  const setting = new URLSearchParams(window.location.search).get("camera");
  try {
    if (setting === "1") window.localStorage.setItem("ifocus-camera", "1");
    if (setting === "0") window.localStorage.removeItem("ifocus-camera");
    return setting !== "0" && window.localStorage.getItem("ifocus-camera") === "1";
  } catch {
    return setting === "1";
  }
}

function waitForMetadata(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise<void>((resolve) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("JPEG 编码失败"))),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

function drawLandscapeFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const sourceAspectRatio = sourceWidth / sourceHeight;
  let sourceX = 0;
  let sourceY = 0;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;

  if (sourceAspectRatio > LANDSCAPE_ASPECT_RATIO) {
    cropWidth = sourceHeight * LANDSCAPE_ASPECT_RATIO;
    sourceX = (sourceWidth - cropWidth) / 2;
  } else {
    cropHeight = sourceWidth / LANDSCAPE_ASPECT_RATIO;
    sourceY = (sourceHeight - cropHeight) / 2;
  }

  context.drawImage(
    video,
    sourceX,
    sourceY,
    cropWidth,
    cropHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

export default function CameraPublisher() {
  const requested = cameraRequested();
  const [activated, setActivated] = useState(requested);
  const [mode, setMode] = useState<CameraMode>("checking");
  const [message, setMessage] = useState("正在检查视频服务…");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const publishingRef = useRef(false);

  const releaseCamera = useCallback(() => {
    publishingRef.current = false;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("./api/video/status", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取视频服务配置");
        return (await response.json()) as VideoStatus;
      })
      .then((status) => {
        if (!status.enabled) {
          setMode("disabled");
          setMessage("视频流未启用，请使用 npm run demo:video 启动");
          return;
        }
        if (!window.isSecureContext || window.location.protocol !== "https:") {
          const host = window.location.hostname || "电脑IP";
          const port = status.https_port;
          setMode("idle");
          setMessage(`摄像头需要 HTTPS，请访问 https://${host}:${port}/?camera=1`);
          return;
        }
        setMode("idle");
        setMessage("摄像头默认关闭");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMode("error");
        setMessage(error instanceof Error ? error.message : "视频服务不可用");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => () => releaseCamera(), [releaseCamera]);

  const stopCamera = useCallback(() => {
    releaseCamera();
    setMode("idle");
    setMessage("摄像头已停止");
  }, [releaseCamera]);

  const startCamera = useCallback(async () => {
    if (publishingRef.current) return;
    setActivated(true);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMode("error");
      setMessage("当前浏览器或 HTTPS 证书不允许访问摄像头");
      return;
    }

    setMode("starting");
    setMessage("等待摄像头授权…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          aspectRatio: { ideal: LANDSCAPE_ASPECT_RATIO },
          facingMode: { ideal: "user" },
          height: { ideal: 720 },
          width: { ideal: 1280 },
        },
      });
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) throw new Error("摄像头采集器尚未就绪");

      streamRef.current = stream;
      video.srcObject = stream;
      await waitForMetadata(video);
      await video.play();

      const captureWidth = Math.min(MAX_CAPTURE_WIDTH, Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(captureWidth));
      canvas.height = Math.max(1, Math.round(captureWidth / LANDSCAPE_ASPECT_RATIO));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("无法创建视频编码画布");

      publishingRef.current = true;
      setMode("streaming");
      setMessage("摄像头画面正在通过 HTTPS 推送");

      const publishFrame = async () => {
        if (!publishingRef.current) return;
        try {
          drawLandscapeFrame(context, video, canvas);
          const jpeg = await canvasToJpeg(canvas);
          const response = await fetch("./api/video/frame", {
            body: jpeg,
            cache: "no-store",
            headers: { "Content-Type": "image/jpeg" },
            method: "POST",
          });
          if (!response.ok) throw new Error(`视频帧上传失败（HTTP ${response.status}）`);
          if (publishingRef.current) timerRef.current = window.setTimeout(publishFrame, FRAME_INTERVAL_MS);
        } catch (error) {
          releaseCamera();
          setMode("error");
          setMessage(error instanceof Error ? error.message : "视频帧上传失败");
        }
      };
      await publishFrame();
    } catch (error) {
      releaseCamera();
      setMode("error");
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setMessage("摄像头权限被拒绝，请在浏览器设置中允许后重试");
      } else {
        setMessage(error instanceof Error ? error.message : "摄像头启动失败");
      }
    }
  }, [releaseCamera]);

  useEffect(() => {
    const handleFocusStart = () => {
      void startCamera();
    };
    window.addEventListener(IFOCUS_CAMERA_START_EVENT, handleFocusStart);
    return () => window.removeEventListener(IFOCUS_CAMERA_START_EVENT, handleFocusStart);
  }, [startCamera]);

  const streaming = mode === "streaming";
  const canStart = mode === "idle" || mode === "error";
  return (
    <aside
      className="camera-publisher camera-publisher-hidden"
      aria-label="摄像头视频流控制"
      hidden
    >
      <span aria-hidden="true" />
      <p>{message}</p>
      {streaming ? (
        <button type="button" onClick={stopCamera}>停止</button>
      ) : (
        <button type="button" onClick={startCamera} disabled={!canStart}>启用摄像头</button>
      )}
      <video ref={videoRef} className="camera-publisher-media" muted playsInline />
      <canvas ref={canvasRef} className="camera-publisher-media" />
    </aside>
  );
}
