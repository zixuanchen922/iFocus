import { useCallback, useEffect, useRef, useState } from "react";
import { requestCameraStart } from "./camera-events";
import FocusSetupScreen from "./components/FocusSetupScreen";
import type { FocusSessionDraft } from "./components/FocusSetupScreen";
import ProfileScreen from "./components/ProfileScreen";
import type { FocusHistoryItem } from "./components/ProfileScreen";
import type { FocusState } from "./types";
import { useScreenWakeLock } from "./use-screen-wake-lock";

interface DisplayUpdate {
  text?: string;
  display: string | number;
  focus_state?: string;
  duration?: number;
}

interface FocusCommandResponse {
  status?: string;
  message?: string;
}

async function postFocusCommand(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as FocusCommandResponse;
  if (!response.ok || payload.status !== "ok") {
    throw new Error(payload.message || `PC 端请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

function notifyFocusBackend(path: string, body: Record<string, unknown> = {}) {
  void postFocusCommand(path, body).catch((error) => {
    console.warn(`[focus-api] ${path} 后台同步失败`, error);
  });
}

async function triggerAction004() {
  try {
    const response = await fetch("./api/action/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_id: "004", loop_count: 1 }),
    });
    const result = await response.text();
    if (!response.ok) console.warn(`[action-004] HTTP ${response.status}: ${result}`);
    else console.log("[action-004] 已触发", result);
  } catch (error) {
    console.warn("[action-004] 请求失败", error);
  }
}

interface StateConfig {
  label: string;
  color: string;
  tone: number[];
}

type DisplayLogKind = "connection" | "message" | "error";

interface DisplayLogEntry {
  id: number;
  time: string;
  kind: DisplayLogKind;
  source: string;
  summary: string;
  details?: string;
}

const START_TRANSITION_MS = 1_250;
const RECOVERY_TRANSITION_MS = 1_800;
const ORB_BASE_DIAMETER = 120;
const FOCUS_HISTORY_KEY = "ifocus.completed-sessions.v1";

function loadFocusHistory(): FocusHistoryItem[] {
  try {
    const stored = window.localStorage.getItem(FOCUS_HISTORY_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as FocusHistoryItem[];
    return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
  } catch {
    return [];
  }
}

interface OrbLayoutPose {
  center: { x: number; y: number };
  scale: number;
}

const PAGE_ORB_POSES = {
  setupPortrait: { center: { x: 230, y: 235 }, scale: 1 },
  focusedLandscape: { center: { x: 180, y: 260 }, scale: 1.2 },
} as const satisfies Record<string, OrbLayoutPose>;

type LockableScreenOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape" | "portrait") => Promise<void>;
};

async function requestLandscapeMode() {
  if (!window.matchMedia("(orientation: landscape)").matches) {
    try {
      const orientation = screen.orientation as LockableScreenOrientation;
      await orientation.lock?.call(orientation, "landscape");
    } catch {
      // iOS and embedded browsers may require the user to rotate the device manually.
    }
  }
}

async function requestPortraitMode() {
  if (!window.matchMedia("(orientation: portrait)").matches) {
    try {
      const orientation = screen.orientation as LockableScreenOrientation;
      await orientation.lock?.call(orientation, "portrait");
    } catch {
      // Some embedded browsers ignore orientation locks; installed PWAs can apply it directly.
    }
  }
}

const STATE_CONFIG: Record<FocusState, StateConfig> = {
  idle: { label: "待机", color: "#ffffff", tone: [] },
  starting: { label: "开始动画", color: "#ffffff", tone: [520, 660] },
  focused: { label: "正常专注", color: "#42d987", tone: [660] },
  suspected: { label: "疑似分心", color: "#f4c95d", tone: [520, 460] },
  distracted: { label: "分心提醒", color: "#ffd82f", tone: [320, 260] },
  intervening: { label: "Agent 提醒", color: "#8b7cf6", tone: [440, 520, 620] },
  recovered: { label: "恢复专注", color: "#55d6be", tone: [520, 660, 780] },
  ending: { label: "正在结束", color: "#67a8ff", tone: [520, 420] },
  finished: { label: "专注完成", color: "#d9f7e7", tone: [620, 780] },
  offline: { label: "设备离线", color: "#aeb7c2", tone: [260] },
  error: { label: "系统异常", color: "#9f4050", tone: [220, 180] },
};

function normalizeDisplayCode(display: string | number) {
  return String(display).trim().padStart(3, "0");
}

function resolveDisplayState(update: DisplayUpdate): FocusState {
  const display = normalizeDisplayCode(update.display);
  if (display === "000") return "focused";
  if (["001", "002", "003"].includes(display)) return "distracted";
  if (display === "111") return "recovered";
  return "error";
}

function emitTone(context: AudioContext, state: FocusState) {
  const frequencies = STATE_CONFIG[state].tone;
  const noteLength = state === "distracted" || state === "error" ? 0.16 : 0.12;

  frequencies.forEach((frequency, index) => {
    const startsAt = context.currentTime + 0.02 + index * (noteLength + 0.035);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = state === "distracted" || state === "error" ? "square" : "sine";
    oscillator.frequency.setValueAtTime(frequency, startsAt);
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.09, startsAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + noteLength);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + noteLength + 0.02);
  });
}

type GazeDirection = "left" | "center" | "right";

const HOP_HEIGHTS = [72, 88, 80, 92, 76];
const HOP_TILTS = [-2.5, 2, -1.5, 2.5, -2];
const HOP_DISTANCE_RATIO = 0.108;
const CLOCK_OCCUPIED_X_RANGE = { min: 350, max: 710 } as const;

const randomRestDuration = () => Math.round((1000 + Math.random() * 2000) * 1.3);

function Mascot({
  state,
  motionKey,
  landscapePose,
  portraitPose,
  paused = false,
  lookingDown = false,
  onActivate,
}: {
  state: FocusState;
  motionKey: number;
  landscapePose: OrbLayoutPose;
  portraitPose: OrbLayoutPose;
  paused?: boolean;
  lookingDown?: boolean;
  onActivate?: () => void;
}) {
  const mascotRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const reflectionRef = useRef<HTMLDivElement>(null);
  const [gaze, setGaze] = useState<GazeDirection>("center");

  useEffect(() => {
    const mascot = mascotRef.current;
    const body = bodyRef.current;
    const shadow = shadowRef.current;
    const reflection = reflectionRef.current;

    if (state !== "focused" || paused || !mascot || !body || !shadow || !reflection) {
      if (paused && mascot) {
        mascot.style.opacity = "1";
        mascot.style.transform = "translate3d(0, 0, 0) scale(1)";
      }
      setGaze("center");
      return;
    }

    let cancelled = false;
    const pendingWaits = new Map<number, () => void>();
    const activeAnimations = new Set<Animation>();

    const wait = (milliseconds: number) => new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        pendingWaits.delete(timer);
        resolve();
      }, milliseconds);
      pendingWaits.set(timer, resolve);
    });

    const playHop = async (fromX: number, toX: number, height: number, tilt: number) => {
      const animations = [
        mascot.animate(
          [
            { transform: `translate3d(${fromX}px, 0, 0) scale(1)` },
            { transform: `translate3d(${toX}px, 0, 0) scale(1)` },
          ],
          { duration: 560, easing: "linear", fill: "both" },
        ),
        body.animate(
          [
            { offset: 0, transform: "translateY(0) rotate(0deg) scale(1)" },
            { offset: 0.1, transform: "translateY(3px) rotate(0deg) scale(1.045, .955)", easing: "cubic-bezier(.18, .72, .28, 1)" },
            { offset: 0.2, transform: "translateY(-6px) rotate(0deg) scale(.97, 1.03)", easing: "cubic-bezier(.16, .68, .32, 1)" },
            { offset: 0.52, transform: `translateY(-${height}px) rotate(${tilt}deg) scale(.99, 1.01)`, easing: "cubic-bezier(.58, 0, .88, .42)" },
            { offset: 0.84, transform: "translateY(-12px) rotate(0deg) scale(.975, 1.025)", easing: "cubic-bezier(.15, .72, .28, 1)" },
            { offset: 0.94, transform: "translateY(2px) rotate(0deg) scale(1.065, .935)", easing: "cubic-bezier(.2, .8, .3, 1)" },
            { offset: 0.98, transform: "translateY(-2px) rotate(0deg) scale(.995, 1.005)" },
            { offset: 1, transform: "translateY(0) rotate(0deg) scale(1)" },
          ],
          { duration: 560, fill: "both" },
        ),
        shadow.animate(
          [
            { offset: 0, opacity: 0.86, scale: "1 .36", filter: "blur(5px)" },
            { offset: 0.52, opacity: 0.32, scale: ".62 .24", filter: "blur(10px)" },
            { offset: 0.84, opacity: 0.58, scale: ".78 .29", filter: "blur(7px)" },
            { offset: 0.94, opacity: 0.94, scale: "1.07 .39", filter: "blur(4px)" },
            { offset: 1, opacity: 0.86, scale: "1 .36", filter: "blur(5px)" },
          ],
          { duration: 560, easing: "linear", fill: "both" },
        ),
        reflection.animate(
          [
            { offset: 0, opacity: 0.26 },
            { offset: 0.52, opacity: 0.06 },
            { offset: 0.94, opacity: 0.32 },
            { offset: 1, opacity: 0.26 },
          ],
          { duration: 560, easing: "linear", fill: "both" },
        ),
      ];

      animations.forEach((animation) => activeAnimations.add(animation));
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));

      if (!cancelled) mascot.style.transform = `translate3d(${toX}px, 0, 0) scale(1)`;
      animations.forEach((animation) => {
        activeAnimations.delete(animation);
        animation.cancel();
      });
    };

    const runIdleMotion = async () => {
      const coordinateSpace = mascot.parentElement;
      if (!coordinateSpace) return;

      const coordinateWidth = coordinateSpace.clientWidth;
      const baseCenterX = coordinateWidth * landscapePose.center.x / 1000;
      const baseHopDistance = coordinateWidth * HOP_DISTANCE_RATIO;
      let currentX = 0;
      let hopIndex = 0;
      mascot.style.opacity = "1";
      mascot.style.transform = "translate3d(0, 0, 0) scale(1)";

      while (!cancelled) {
        await wait(randomRestDuration());
        if (cancelled) return;

        const currentCenterX = baseCenterX + currentX;
        const currentCenterModelX = currentCenterX / coordinateWidth * 1000;
        const insideClockRange = currentCenterModelX >= CLOCK_OCCUPIED_X_RANGE.min
          && currentCenterModelX <= CLOCK_OCCUPIED_X_RANGE.max;
        const minimumHopDistance = baseHopDistance * (insideClockRange ? 3.5 : 1.5);
        const onLeftHalf = currentCenterX < coordinateWidth / 2;
        let moveRight = onLeftHalf ? Math.random() < 0.75 : Math.random() >= 0.75;
        let availableDistance = moveRight
          ? coordinateWidth - currentCenterX
          : currentCenterX;

        if (availableDistance < minimumHopDistance) {
          moveRight = !moveRight;
          availableDistance = moveRight
            ? coordinateWidth - currentCenterX
            : currentCenterX;
        }

        const maximumHopDistance = Math.min(
          baseHopDistance * (insideClockRange ? 3.5 : 2.5),
          availableDistance,
        );
        const hopDistance = minimumHopDistance
          + Math.random() * Math.max(0, maximumHopDistance - minimumHopDistance);
        const nextCenterX = Math.min(
          coordinateWidth,
          Math.max(0, currentCenterX + (moveRight ? hopDistance : -hopDistance)),
        );
        const nextX = nextCenterX - baseCenterX;

        setGaze(moveRight ? "right" : "left");
        await wait(240);
        if (cancelled) return;
        await playHop(
          currentX,
          nextX,
          HOP_HEIGHTS[hopIndex % HOP_HEIGHTS.length],
          HOP_TILTS[hopIndex % HOP_TILTS.length] * (moveRight ? 1 : -1),
        );
        currentX = nextX;
        hopIndex += 1;
        if (cancelled) return;
        setGaze("center");
      }
    };

    void runIdleMotion();

    return () => {
      cancelled = true;
      pendingWaits.forEach((resolve, timer) => {
        window.clearTimeout(timer);
        resolve();
      });
      pendingWaits.clear();
      activeAnimations.forEach((animation) => animation.cancel());
      activeAnimations.clear();
    };
  }, [motionKey, paused, state]);

  return (
    <div
      ref={mascotRef}
      className={`mascot mascot-${state} mascot-gaze-${gaze} ${paused ? "mascot-paused" : ""} ${lookingDown ? "mascot-looking-down" : ""}`}
      key={motionKey}
      data-testid="mascot"
      role={onActivate ? "button" : "img"}
      tabIndex={onActivate ? 0 : undefined}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (!onActivate || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onActivate();
      }}
      aria-label={onActivate ? "打开专注任务操作" : "iFocus 形象"}
      style={{
        "--orb-landscape-left": `${landscapePose.center.x / 10}%`,
        "--orb-landscape-top": `${landscapePose.center.y / 4.6}%`,
        "--orb-landscape-width": `${landscapePose.scale * ORB_BASE_DIAMETER / 10}%`,
        "--orb-portrait-left": `${portraitPose.center.x / 4.6}%`,
        "--orb-portrait-top": `${portraitPose.center.y / 10}%`,
        "--orb-portrait-width": `${portraitPose.scale * ORB_BASE_DIAMETER / 4.6}%`,
        left: "var(--orb-layout-left, var(--orb-landscape-left))",
        top: "var(--orb-layout-top, var(--orb-landscape-top))",
        width: "var(--orb-layout-width, var(--orb-landscape-width))",
      } as React.CSSProperties}
    >
      <div className="orb-grounding" aria-hidden="true">
        <div ref={shadowRef} className="orb-shadow" />
        <div ref={reflectionRef} className="orb-reflection" />
      </div>
      <div ref={bodyRef} className="orb-body" aria-hidden="true">
        <div className="orb-inner-light" />
        <div className="orb-eyes">
          <svg className="orb-eye orb-eye-left" viewBox="0 0 100 100" preserveAspectRatio="none">
            <path className="orb-eye-normal" d="M50 2 C78 2 92 22 92 50 C92 78 78 98 50 98 C30 98 17 88 11 70 C7 58 7 42 11 30 C17 12 30 2 50 2 Z" />
            <path className="orb-eye-alert-glow" d="M10 7 C24 2 39 7 54 17 C70 27 85 36 96 40 C98 47 98 53 97 60 C96 72 93 82 88 90 C70 99 39 99 18 88 C9 65 5 23 10 7 Z" />
            <path className="orb-eye-alert-core" d="M10 7 C24 2 39 7 54 17 C70 27 85 36 96 40 C98 47 98 53 97 60 C96 72 93 82 88 90 C70 99 39 99 18 88 C9 65 5 23 10 7 Z" />
            <path className="orb-eye-danger-glow" d="M3 19 C3 9 7 4 15 4 C19 4 24 5 29 7 C52 14 78 29 97 47 C77 57 48 59 24 52 C11 46 4 34 3 19 Z" />
            <path className="orb-eye-danger-core" d="M3 19 C3 9 7 4 15 4 C19 4 24 5 29 7 C52 14 78 29 97 47 C77 57 48 59 24 52 C11 46 4 34 3 19 Z" />
          </svg>
          <svg className="orb-eye orb-eye-right" viewBox="0 0 100 100" preserveAspectRatio="none">
            <path className="orb-eye-normal" d="M50 2 C78 2 92 22 92 50 C92 78 78 98 50 98 C30 98 17 88 11 70 C7 58 7 42 11 30 C17 12 30 2 50 2 Z" />
            <path className="orb-eye-alert-glow" d="M90 7 C76 2 61 7 46 17 C30 27 15 36 4 40 C2 47 2 53 3 60 C4 72 7 82 12 90 C30 99 61 99 82 88 C91 65 95 23 90 7 Z" />
            <path className="orb-eye-alert-core" d="M90 7 C76 2 61 7 46 17 C30 27 15 36 4 40 C2 47 2 53 3 60 C4 72 7 82 12 90 C30 99 61 99 82 88 C91 65 95 23 90 7 Z" />
            <path className="orb-eye-danger-glow" d="M97 19 C97 9 93 4 85 4 C81 4 76 5 71 7 C48 14 22 29 3 47 C23 57 52 59 76 52 C89 46 96 34 97 19 Z" />
            <path className="orb-eye-danger-core" d="M97 19 C97 9 93 4 85 4 C81 4 76 5 71 7 C48 14 22 29 3 47 C23 57 52 59 76 52 C89 46 96 34 97 19 Z" />
          </svg>
        </div>
      </div>
      <div className="mascot-halo" aria-hidden="true" />
    </div>
  );
}

const REMINDER_CLOSEUP_POSE = {
  center: { x: 500, y: 284 },
  scale: 11.3,
} as const;

const PRIMARY_ORB_MODEL = {
  startCenter: PAGE_ORB_POSES.focusedLandscape.center,
  endCenter: REMINDER_CLOSEUP_POSE.center,
  startScale: PAGE_ORB_POSES.focusedLandscape.scale,
  endScale: REMINDER_CLOSEUP_POSE.scale,
} as const;

const SECONDARY_ORB_MODEL = {
  startCenter: PAGE_ORB_POSES.focusedLandscape.center,
  endCenter: REMINDER_CLOSEUP_POSE.center,
  startScale: PAGE_ORB_POSES.focusedLandscape.scale,
  endScale: 11,
  endEyeHalfSpacing: 21.5,
} as const;

const TERTIARY_ORB_MODEL = {
  startCenter: PAGE_ORB_POSES.focusedLandscape.center,
  endCenter: REMINDER_CLOSEUP_POSE.center,
  startScale: PAGE_ORB_POSES.focusedLandscape.scale,
  endScale: 11,
  endEyeHalfSpacing: 20.5,
} as const;

interface OrbPose {
  center: { x: number; y: number };
  scale: number;
  eyeHalfSpacing: number;
}

const readCurrentOrbPose = (): OrbPose => {
  const stage = document.querySelector<HTMLElement>(".visual-stage");
  const mascot = document.querySelector<HTMLElement>('[data-testid="mascot"]');
  if (!stage || !mascot) {
    return { center: PRIMARY_ORB_MODEL.startCenter, scale: PRIMARY_ORB_MODEL.startScale, eyeHalfSpacing: 21 };
  }

  const stageRect = stage.getBoundingClientRect();
  const mascotRect = mascot.getBoundingClientRect();
  const eyes = mascot.querySelectorAll<HTMLElement>(".orb-eye");
  const canvasScale = Math.min(stageRect.width / 1000, stageRect.height / 460);
  const offsetX = (stageRect.width - 1000 * canvasScale) / 2;
  const offsetY = (stageRect.height - 460 * canvasScale) / 2;

  const scale = mascotRect.width / canvasScale / 120;
  const eyeHalfSpacing = eyes.length === 2
    ? ((eyes[1].getBoundingClientRect().left + eyes[1].getBoundingClientRect().width / 2)
      - (eyes[0].getBoundingClientRect().left + eyes[0].getBoundingClientRect().width / 2))
      / 2 / canvasScale / scale
    : 21;

  return {
    center: {
      x: (mascotRect.left + mascotRect.width / 2 - stageRect.left - offsetX) / canvasScale,
      y: (mascotRect.top + mascotRect.height / 2 - stageRect.top - offsetY) / canvasScale,
    },
    scale,
    eyeHalfSpacing,
  };
};

const interpolateKeyframes = (progress: number, keyframes: Array<[number, number]>) => {
  for (let index = 1; index < keyframes.length; index += 1) {
    const [endAt, endValue] = keyframes[index];
    if (progress <= endAt) {
      const [startAt, startValue] = keyframes[index - 1];
      const segmentProgress = (progress - startAt) / Math.max(.0001, endAt - startAt);
      return startValue + (endValue - startValue) * segmentProgress;
    }
  }
  return keyframes[keyframes.length - 1][1];
};

const primaryBlinkScale = (elapsed: number) => {
  const blinkDuration = 140;
  const blinkStarts = [0, 190, 730, 1570, 1760];
  const activeBlink = blinkStarts.find((start) => elapsed >= start && elapsed <= start + blinkDuration);
  if (activeBlink === undefined) return 1;
  const blinkProgress = (elapsed - activeBlink) / blinkDuration;
  return 1 - Math.sin(blinkProgress * Math.PI) * .92;
};

function PrimaryReminderModel({ durationSeconds, startPose }: { durationSeconds: number; startPose: OrbPose }) {
  const orbRef = useRef<SVGGElement>(null);
  const leftEyeRef = useRef<SVGGElement>(null);
  const rightEyeRef = useRef<SVGGElement>(null);

  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();
    const animationDuration = Math.max(1, durationSeconds * 1000 / 1.2);
    const totalDuration = Math.max(1, durationSeconds * 1000);
    const blinkStartedAt = animationDuration * .64;

    const renderFrame = (now: number) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / animationDuration);
      const xProgress = interpolateKeyframes(progress, [[0, 0], [.1, .40625], [.25, 1], [1, 1]]);
      const yProgress = interpolateKeyframes(progress, [[0, 0], [.1, .25], [.25, .625], [.48, .875], [.64, 1], [1, 1]]);
      const scaleProgress = interpolateKeyframes(progress, [[0, 0], [.1, .049], [.25, .437], [.48, .832]]);
      const x = startPose.center.x
        + (PRIMARY_ORB_MODEL.endCenter.x - startPose.center.x) * xProgress;
      const y = startPose.center.y
        + (PRIMARY_ORB_MODEL.endCenter.y - startPose.center.y) * yProgress;
      const scale = progress < .48
        ? startPose.scale + (PRIMARY_ORB_MODEL.endScale - startPose.scale) * scaleProgress
        : interpolateKeyframes(progress, [
          [.48, startPose.scale + (PRIMARY_ORB_MODEL.endScale - startPose.scale) * .832],
          [.64, PRIMARY_ORB_MODEL.endScale * .9943],
          [.76, PRIMARY_ORB_MODEL.endScale * 1.0092],
          [.88, PRIMARY_ORB_MODEL.endScale * .9908],
          [1, PRIMARY_ORB_MODEL.endScale],
        ]);
      const eyeHalfSpacing = startPose.eyeHalfSpacing + (10.25 - startPose.eyeHalfSpacing) * xProgress;
      const blinkScale = primaryBlinkScale(elapsed - blinkStartedAt);

      orbRef.current?.setAttribute("transform", `translate(${x} ${y}) scale(${scale})`);
      leftEyeRef.current?.setAttribute("transform", `translate(${-eyeHalfSpacing} -4.8) scale(1 ${blinkScale})`);
      rightEyeRef.current?.setAttribute("transform", `translate(${eyeHalfSpacing} -4.8) scale(1 ${blinkScale})`);
      if (elapsed < totalDuration) frame = window.requestAnimationFrame(renderFrame);
    };

    frame = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [durationSeconds, startPose]);

  return (
    <svg
      className="primary-reminder-model"
      viewBox="0 0 1000 460"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="primary-orb-fill" cx="35%" cy="25%" r="80%">
          <stop offset="0" stopColor="#17201e" />
          <stop offset=".5" stopColor="#060908" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <filter id="primary-eye-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation=".42" />
        </filter>
        <path
          id="primary-eye-shape"
          d="M0 -10.56 C3.36 -10.56 5.04 -6.16 5.04 0 C5.04 6.16 3.36 10.56 0 10.56 C-2.4 10.56 -3.96 8.36 -4.68 4.4 C-5.16 1.76 -5.16 -1.76 -4.68 -4.4 C-3.96 -8.36 -2.4 -10.56 0 -10.56 Z"
        />
      </defs>
      <g ref={orbRef} transform={`translate(${startPose.center.x} ${startPose.center.y}) scale(${startPose.scale})`}>
        <circle cx="0" cy="0" r="60" fill="url(#primary-orb-fill)" stroke="#f8fffd" strokeWidth="7" />
        <g ref={leftEyeRef} transform={`translate(${-startPose.eyeHalfSpacing} -4.8)`}>
          <use href="#primary-eye-shape" fill="#dffdf6" opacity=".46" filter="url(#primary-eye-glow)" transform="scale(1.06)" />
          <use href="#primary-eye-shape" fill="#f8fffd" />
        </g>
        <g ref={rightEyeRef} transform={`translate(${startPose.eyeHalfSpacing} -4.8)`}>
          <use href="#primary-eye-shape" fill="#dffdf6" opacity=".46" filter="url(#primary-eye-glow)" transform="scale(1.06)" />
          <use href="#primary-eye-shape" fill="#f8fffd" />
        </g>
      </g>
    </svg>
  );
}

function SecondaryReminderModel({ durationSeconds, startPose }: { durationSeconds: number; startPose: OrbPose }) {
  const orbRef = useRef<SVGGElement>(null);
  const normalEyesRef = useRef<SVGGElement>(null);
  const alertEyesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();
    const animationDuration = Math.max(1, durationSeconds * 1000 / 1.2);

    const renderFrame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / animationDuration);
      const xProgress = interpolateKeyframes(progress, [[0, 0], [.1, .40625], [.25, 1], [1, 1]]);
      const yProgress = interpolateKeyframes(progress, [[0, 0], [.1, .25], [.25, .625], [.48, .875], [.64, 1], [1, 1]]);
      const scaleProgress = interpolateKeyframes(progress, [[0, 0], [.1, .049], [.25, .437], [.48, .832]]);
      const x = startPose.center.x
        + (SECONDARY_ORB_MODEL.endCenter.x - startPose.center.x) * xProgress;
      const y = startPose.center.y
        + (SECONDARY_ORB_MODEL.endCenter.y - startPose.center.y) * yProgress;
      const scale = progress < .48
        ? startPose.scale + (SECONDARY_ORB_MODEL.endScale - startPose.scale) * scaleProgress
        : interpolateKeyframes(progress, [
          [.48, startPose.scale + (SECONDARY_ORB_MODEL.endScale - startPose.scale) * .832],
          [.64, SECONDARY_ORB_MODEL.endScale * .9943],
          [.76, SECONDARY_ORB_MODEL.endScale * 1.0092],
          [.88, SECONDARY_ORB_MODEL.endScale * .9908],
          [1, SECONDARY_ORB_MODEL.endScale],
        ]);
      const normalEyeSpacing = startPose.eyeHalfSpacing
        + (SECONDARY_ORB_MODEL.endEyeHalfSpacing - startPose.eyeHalfSpacing) * xProgress;
      const alertProgress = interpolateKeyframes(progress, [[0, 0], [.12, 0], [.27, 1], [1, 1]]);

      orbRef.current?.setAttribute("transform", `translate(${x} ${y}) scale(${scale})`);
      normalEyesRef.current?.setAttribute("opacity", `${1 - alertProgress}`);
      normalEyesRef.current?.querySelector<SVGGElement>(".secondary-normal-eye-left")
        ?.setAttribute("transform", `translate(${-normalEyeSpacing} -4.8)`);
      normalEyesRef.current?.querySelector<SVGGElement>(".secondary-normal-eye-right")
        ?.setAttribute("transform", `translate(${normalEyeSpacing} -4.8)`);
      alertEyesRef.current?.setAttribute("opacity", `${alertProgress}`);
      alertEyesRef.current?.setAttribute("transform", `scale(${.72 + alertProgress * .28} ${1.08 - alertProgress * .08})`);

      if (progress < 1) frame = window.requestAnimationFrame(renderFrame);
    };

    frame = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [durationSeconds, startPose]);

  return (
    <svg
      className="secondary-reminder-model"
      viewBox="0 0 1000 460"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="secondary-orb-fill" cx="35%" cy="25%" r="80%">
          <stop offset="0" stopColor="#17201e" />
          <stop offset=".5" stopColor="#060908" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <filter id="secondary-eye-glow" x="-80%" y="-100%" width="260%" height="300%">
          <feGaussianBlur stdDeviation=".7" />
        </filter>
        <path
          id="secondary-normal-eye-shape"
          d="M0 -10.56 C3.36 -10.56 5.04 -6.16 5.04 0 C5.04 6.16 3.36 10.56 0 10.56 C-2.4 10.56 -3.96 8.36 -4.68 4.4 C-5.16 1.76 -5.16 -1.76 -4.68 -4.4 C-3.96 -8.36 -2.4 -10.56 0 -10.56 Z"
        />
        <path
          id="secondary-alert-eye-left"
          d="M-13.5 -8.5 C-8.5 -10.5 6 -2 11.5 1.5 C14 3.5 14 10.5 11.5 12.5 C5 15 -7.5 13 -13.5 9.5 C-15 5 -15 -5 -13.5 -8.5 Z"
        />
        <path
          id="secondary-alert-eye-right"
          d="M13.5 -8.5 C8.5 -10.5 -6 -2 -11.5 1.5 C-14 3.5 -14 10.5 -11.5 12.5 C-5 15 7.5 13 13.5 9.5 C15 5 15 -5 13.5 -8.5 Z"
        />
      </defs>
      <g ref={orbRef} transform={`translate(${startPose.center.x} ${startPose.center.y}) scale(${startPose.scale})`}>
        <circle cx="0" cy="0" r="60" fill="url(#secondary-orb-fill)" stroke="#f8fffd" strokeWidth="7" />
        <g ref={normalEyesRef}>
          <g className="secondary-normal-eye-left" transform={`translate(${-startPose.eyeHalfSpacing} -4.8)`}>
            <use href="#secondary-normal-eye-shape" fill="#f8fffd" />
          </g>
          <g className="secondary-normal-eye-right" transform={`translate(${startPose.eyeHalfSpacing} -4.8)`}>
            <use href="#secondary-normal-eye-shape" fill="#f8fffd" />
          </g>
        </g>
        <g ref={alertEyesRef} opacity="0">
          <use href="#secondary-alert-eye-left" transform={`translate(${-SECONDARY_ORB_MODEL.endEyeHalfSpacing} -4.8) scale(1.08)`} fill="#ffbd18" opacity=".58" filter="url(#secondary-eye-glow)" />
          <use href="#secondary-alert-eye-right" transform={`translate(${SECONDARY_ORB_MODEL.endEyeHalfSpacing} -4.8) scale(1.08)`} fill="#ffbd18" opacity=".58" filter="url(#secondary-eye-glow)" />
          <use href="#secondary-alert-eye-left" transform={`translate(${-SECONDARY_ORB_MODEL.endEyeHalfSpacing} -4.8)`} fill="#ffda22" />
          <use href="#secondary-alert-eye-right" transform={`translate(${SECONDARY_ORB_MODEL.endEyeHalfSpacing} -4.8)`} fill="#ffda22" />
        </g>
      </g>
    </svg>
  );
}

function TertiaryReminderModel({ durationSeconds, startPose }: { durationSeconds: number; startPose: OrbPose }) {
  const orbRef = useRef<SVGGElement>(null);
  const normalEyesRef = useRef<SVGGElement>(null);
  const dangerEyesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();
    const animationDuration = Math.max(1, durationSeconds * 1000 / 1.2);

    const renderFrame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / animationDuration);
      const xProgress = interpolateKeyframes(progress, [[0, 0], [.1, .40625], [.25, 1], [1, 1]]);
      const yProgress = interpolateKeyframes(progress, [[0, 0], [.1, .25], [.25, .625], [.48, .875], [.64, 1], [1, 1]]);
      const scaleProgress = interpolateKeyframes(progress, [[0, 0], [.1, .049], [.25, .437], [.48, .832]]);
      const x = startPose.center.x
        + (TERTIARY_ORB_MODEL.endCenter.x - startPose.center.x) * xProgress;
      const y = startPose.center.y
        + (TERTIARY_ORB_MODEL.endCenter.y - startPose.center.y) * yProgress;
      const scale = progress < .48
        ? startPose.scale + (TERTIARY_ORB_MODEL.endScale - startPose.scale) * scaleProgress
        : interpolateKeyframes(progress, [
          [.48, startPose.scale + (TERTIARY_ORB_MODEL.endScale - startPose.scale) * .832],
          [.64, TERTIARY_ORB_MODEL.endScale * .9943],
          [.76, TERTIARY_ORB_MODEL.endScale * 1.0092],
          [.88, TERTIARY_ORB_MODEL.endScale * .9908],
          [1, TERTIARY_ORB_MODEL.endScale],
        ]);
      const normalEyeSpacing = startPose.eyeHalfSpacing
        + (TERTIARY_ORB_MODEL.endEyeHalfSpacing - startPose.eyeHalfSpacing) * xProgress;
      const dangerProgress = interpolateKeyframes(progress, [[0, 0], [.12, 0], [.3, 1], [1, 1]]);

      orbRef.current?.setAttribute("transform", `translate(${x} ${y}) scale(${scale})`);
      normalEyesRef.current?.setAttribute("opacity", `${1 - dangerProgress}`);
      normalEyesRef.current?.querySelector<SVGGElement>(".tertiary-normal-eye-left")
        ?.setAttribute("transform", `translate(${-normalEyeSpacing} -4.8)`);
      normalEyesRef.current?.querySelector<SVGGElement>(".tertiary-normal-eye-right")
        ?.setAttribute("transform", `translate(${normalEyeSpacing} -4.8)`);
      dangerEyesRef.current?.setAttribute("opacity", `${dangerProgress}`);
      dangerEyesRef.current?.setAttribute("transform", `scale(${.72 + dangerProgress * .28} ${1.12 - dangerProgress * .12})`);

      if (progress < 1) frame = window.requestAnimationFrame(renderFrame);
    };

    frame = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [durationSeconds, startPose]);

  return (
    <svg
      className="tertiary-reminder-model"
      viewBox="0 0 1000 460"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="tertiary-orb-fill" cx="35%" cy="25%" r="80%">
          <stop offset="0" stopColor="#17201e" />
          <stop offset=".5" stopColor="#060908" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <filter id="tertiary-eye-glow" x="-90%" y="-120%" width="280%" height="340%">
          <feGaussianBlur stdDeviation=".72" />
        </filter>
        <path
          id="tertiary-normal-eye-shape"
          d="M0 -10.56 C3.36 -10.56 5.04 -6.16 5.04 0 C5.04 6.16 3.36 10.56 0 10.56 C-2.4 10.56 -3.96 8.36 -4.68 4.4 C-5.16 1.76 -5.16 -1.76 -4.68 -4.4 C-3.96 -8.36 -2.4 -10.56 0 -10.56 Z"
        />
        <path
          id="tertiary-danger-eye-left"
          d="M-19.4 -9.8 L15 4 L-8.5 4 C-14.3 4 -20 -2.5 -20 -8.3 Q-20 -9.6 -19.4 -9.8 Z"
        />
        <path
          id="tertiary-danger-eye-right"
          d="M19.4 -9.8 L-15 4 L8.5 4 C14.3 4 20 -2.5 20 -8.3 Q20 -9.6 19.4 -9.8 Z"
        />
      </defs>
      <g ref={orbRef} transform={`translate(${startPose.center.x} ${startPose.center.y}) scale(${startPose.scale})`}>
        <circle cx="0" cy="0" r="60" fill="url(#tertiary-orb-fill)" stroke="#f8fffd" strokeWidth="7" />
        <g ref={normalEyesRef}>
          <g className="tertiary-normal-eye-left" transform={`translate(${-startPose.eyeHalfSpacing} -4.8)`}>
            <use href="#tertiary-normal-eye-shape" fill="#f8fffd" />
          </g>
          <g className="tertiary-normal-eye-right" transform={`translate(${startPose.eyeHalfSpacing} -4.8)`}>
            <use href="#tertiary-normal-eye-shape" fill="#f8fffd" />
          </g>
        </g>
        <g ref={dangerEyesRef} opacity="0">
          <use href="#tertiary-danger-eye-left" transform={`translate(${-TERTIARY_ORB_MODEL.endEyeHalfSpacing} -4.8) scale(1.1)`} fill="#ff180d" opacity=".66" filter="url(#tertiary-eye-glow)" />
          <use href="#tertiary-danger-eye-right" transform={`translate(${TERTIARY_ORB_MODEL.endEyeHalfSpacing} -4.8) scale(1.1)`} fill="#ff180d" opacity=".66" filter="url(#tertiary-eye-glow)" />
          <use href="#tertiary-danger-eye-left" transform={`translate(${-TERTIARY_ORB_MODEL.endEyeHalfSpacing} -4.8)`} fill="#ff341f" />
          <use href="#tertiary-danger-eye-right" transform={`translate(${TERTIARY_ORB_MODEL.endEyeHalfSpacing} -4.8)`} fill="#ff341f" />
        </g>
      </g>
    </svg>
  );
}

const ABANDON_ORB_MODEL = {
  startCenter: PAGE_ORB_POSES.focusedLandscape.center,
  endCenter: REMINDER_CLOSEUP_POSE.center,
  startScale: PAGE_ORB_POSES.focusedLandscape.scale,
  endScale: REMINDER_CLOSEUP_POSE.scale,
  endEyeHalfSpacing: 18.5,
} as const;

function AbandonReminderModel({
  durationSeconds,
  startPose,
  onComplete,
}: {
  durationSeconds: number;
  startPose: OrbPose;
  onComplete: () => void;
}) {
  const orbRef = useRef<SVGGElement>(null);
  const normalEyesRef = useRef<SVGGElement>(null);
  const sadEyesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();
    const totalDuration = Math.max(1, durationSeconds * 1000);
    const animationDuration = totalDuration / 1.2;

    const renderFrame = (now: number) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / animationDuration);
      const xProgress = interpolateKeyframes(progress, [[0, 0], [.1, .40625], [.25, 1], [1, 1]]);
      const yProgress = interpolateKeyframes(progress, [[0, 0], [.1, .25], [.25, .625], [.48, .875], [.64, 1], [1, 1]]);
      const scaleProgress = interpolateKeyframes(progress, [[0, 0], [.1, .049], [.25, .437], [.48, .832]]);
      const x = startPose.center.x
        + (ABANDON_ORB_MODEL.endCenter.x - startPose.center.x) * xProgress;
      const y = startPose.center.y
        + (ABANDON_ORB_MODEL.endCenter.y - startPose.center.y) * yProgress;
      const scale = progress < .48
        ? startPose.scale + (ABANDON_ORB_MODEL.endScale - startPose.scale) * scaleProgress
        : interpolateKeyframes(progress, [
          [.48, startPose.scale + (ABANDON_ORB_MODEL.endScale - startPose.scale) * .832],
          [.64, ABANDON_ORB_MODEL.endScale * .9943],
          [.76, ABANDON_ORB_MODEL.endScale * 1.0092],
          [.88, ABANDON_ORB_MODEL.endScale * .9908],
          [1, ABANDON_ORB_MODEL.endScale],
        ]);
      const normalEyeSpacing = startPose.eyeHalfSpacing
        + (ABANDON_ORB_MODEL.endEyeHalfSpacing - startPose.eyeHalfSpacing) * xProgress;
      const sadProgress = interpolateKeyframes(progress, [[0, 0], [.12, 0], [.32, 1], [1, 1]]);

      orbRef.current?.setAttribute("transform", `translate(${x} ${y}) scale(${scale})`);
      normalEyesRef.current?.setAttribute("opacity", `${1 - sadProgress}`);
      normalEyesRef.current?.querySelector<SVGGElement>(".abandon-normal-eye-left")
        ?.setAttribute("transform", `translate(${-normalEyeSpacing} -4.8)`);
      normalEyesRef.current?.querySelector<SVGGElement>(".abandon-normal-eye-right")
        ?.setAttribute("transform", `translate(${normalEyeSpacing} -4.8)`);
      sadEyesRef.current?.setAttribute("opacity", `${sadProgress}`);
      sadEyesRef.current?.setAttribute("transform", `scale(${.76 + sadProgress * .24})`);

      if (elapsed < totalDuration) {
        frame = window.requestAnimationFrame(renderFrame);
      } else {
        onComplete();
      }
    };

    frame = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [durationSeconds, onComplete, startPose]);

  return (
    <svg
      className="abandon-reminder-model"
      viewBox="0 0 1000 460"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="abandon-orb-fill" cx="35%" cy="25%" r="80%">
          <stop offset="0" stopColor="#17201e" />
          <stop offset=".5" stopColor="#060908" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <filter id="abandon-eye-glow" x="-100%" y="-120%" width="300%" height="340%">
          <feGaussianBlur stdDeviation=".62" />
        </filter>
        <path
          id="abandon-normal-eye-shape"
          d="M0 -10.56 C3.36 -10.56 5.04 -6.16 5.04 0 C5.04 6.16 3.36 10.56 0 10.56 C-2.4 10.56 -3.96 8.36 -4.68 4.4 C-5.16 1.76 -5.16 -1.76 -4.68 -4.4 C-3.96 -8.36 -2.4 -10.56 0 -10.56 Z"
        />
        <path
          id="abandon-sad-eye-left"
          d="M-9.8 -.5 C-7 -2 4.5 -7 7.2 -7.5 C9 -7.8 10 -6.2 9.3 -4.5 C8 1.5 3 5.5 -3 6 C-8 6.4 -11.8 4.2 -12.3 1.5 C-12.6 .3 -11.2 -.5 -9.8 -.5 Z"
        />
        <path
          id="abandon-sad-eye-right"
          d="M9.8 -.5 C7 -2 -4.5 -7 -7.2 -7.5 C-9 -7.8 -10 -6.2 -9.3 -4.5 C-8 1.5 -3 5.5 3 6 C8 6.4 11.8 4.2 12.3 1.5 C12.6 .3 11.2 -.5 9.8 -.5 Z"
        />
        <path
          id="abandon-tear-shape"
          d="M17 7 C16.2 8.7 15.5 10.2 15.5 12 C15.5 14 16.2 15 17.2 15 C18.3 15 19 14 19 12 C19 10.2 18 8.6 17 7 Z"
        />
      </defs>
      <g ref={orbRef} transform={`translate(${startPose.center.x} ${startPose.center.y}) scale(${startPose.scale})`}>
        <circle cx="0" cy="0" r="60" fill="url(#abandon-orb-fill)" stroke="#f8fffd" strokeWidth="7" />
        <g ref={normalEyesRef}>
          <g className="abandon-normal-eye-left" transform={`translate(${-startPose.eyeHalfSpacing} -4.8)`}>
            <use href="#abandon-normal-eye-shape" fill="#f8fffd" />
          </g>
          <g className="abandon-normal-eye-right" transform={`translate(${startPose.eyeHalfSpacing} -4.8)`}>
            <use href="#abandon-normal-eye-shape" fill="#f8fffd" />
          </g>
        </g>
        <g ref={sadEyesRef} opacity="0">
          <use href="#abandon-sad-eye-left" transform={`translate(${-ABANDON_ORB_MODEL.endEyeHalfSpacing} -4.8) scale(1.08)`} fill="#55d9ff" opacity=".62" filter="url(#abandon-eye-glow)" />
          <use href="#abandon-sad-eye-right" transform={`translate(${ABANDON_ORB_MODEL.endEyeHalfSpacing} -4.8) scale(1.08)`} fill="#55d9ff" opacity=".62" filter="url(#abandon-eye-glow)" />
          <use href="#abandon-sad-eye-left" transform={`translate(${-ABANDON_ORB_MODEL.endEyeHalfSpacing} -4.8)`} fill="#e4faff" />
          <use href="#abandon-sad-eye-right" transform={`translate(${ABANDON_ORB_MODEL.endEyeHalfSpacing} -4.8)`} fill="#e4faff" />
          <use href="#abandon-tear-shape" fill="#4ce4ff" opacity=".72" filter="url(#abandon-eye-glow)" transform="scale(1.08)" />
          <use href="#abandon-tear-shape" fill="#72ecff" />
        </g>
      </g>
    </svg>
  );
}

const COMPLETION_ORB_MODEL = {
  startCenter: PAGE_ORB_POSES.focusedLandscape.center,
  endCenter: REMINDER_CLOSEUP_POSE.center,
  startScale: PAGE_ORB_POSES.focusedLandscape.scale,
  endScale: REMINDER_CLOSEUP_POSE.scale,
  endEyeHalfSpacing: 18.5,
} as const;

const COMPLETION_FIREWORK_PARTICLES = [
  { x: 0, y: -34 },
  { x: 21, y: -27 },
  { x: 34, y: -8 },
  { x: 30, y: 17 },
  { x: 13, y: 33 },
  { x: -13, y: 33 },
  { x: -30, y: 17 },
  { x: -34, y: -8 },
  { x: -21, y: -27 },
] as const;

function CompletionFirework({ x, y }: { x: number; y: number }) {
  return (
    <g className="completion-firework" transform={`translate(${x} ${y})`}>
      <circle className="completion-firework-ring" cx="0" cy="0" r="3" />
      {COMPLETION_FIREWORK_PARTICLES.map((particle, index) => (
        <circle
          key={`${particle.x}-${particle.y}`}
          className="completion-firework-particle"
          cx="0"
          cy="0"
          r={index % 3 === 0 ? 2.2 : 1.6}
          style={{
            "--particle-x": `${particle.x}px`,
            "--particle-y": `${particle.y}px`,
            "--particle-delay": `${index * 16}ms`,
          } as React.CSSProperties}
        />
      ))}
    </g>
  );
}

function CompletionReminderModel({
  animate,
  durationSeconds,
  startPose,
  onComplete,
}: {
  animate: boolean;
  durationSeconds: number;
  startPose: OrbPose;
  onComplete: () => void;
}) {
  const orbRef = useRef<SVGGElement>(null);
  const normalEyesRef = useRef<SVGGElement>(null);
  const happyEyesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    if (!animate) {
      orbRef.current?.setAttribute(
        "transform",
        `translate(${COMPLETION_ORB_MODEL.endCenter.x} ${COMPLETION_ORB_MODEL.endCenter.y}) scale(${COMPLETION_ORB_MODEL.endScale})`,
      );
      normalEyesRef.current?.setAttribute("opacity", "0");
      happyEyesRef.current?.setAttribute("opacity", "1");
      happyEyesRef.current?.setAttribute("transform", "scale(1)");
      return undefined;
    }

    let frame = 0;
    const startedAt = performance.now();
    const totalDuration = Math.max(1, durationSeconds * 1000);
    const animationDuration = totalDuration / 1.2;

    const renderFrame = (now: number) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / animationDuration);
      const xProgress = interpolateKeyframes(progress, [[0, 0], [.1, .40625], [.25, 1], [1, 1]]);
      const yProgress = interpolateKeyframes(progress, [[0, 0], [.1, .25], [.25, .625], [.48, .875], [.64, 1], [1, 1]]);
      const scaleProgress = interpolateKeyframes(progress, [[0, 0], [.1, .049], [.25, .437], [.48, .832]]);
      const x = startPose.center.x
        + (COMPLETION_ORB_MODEL.endCenter.x - startPose.center.x) * xProgress;
      const y = startPose.center.y
        + (COMPLETION_ORB_MODEL.endCenter.y - startPose.center.y) * yProgress;
      const scale = progress < .48
        ? startPose.scale + (COMPLETION_ORB_MODEL.endScale - startPose.scale) * scaleProgress
        : interpolateKeyframes(progress, [
          [.48, startPose.scale + (COMPLETION_ORB_MODEL.endScale - startPose.scale) * .832],
          [.64, COMPLETION_ORB_MODEL.endScale * .9943],
          [.76, COMPLETION_ORB_MODEL.endScale * 1.0092],
          [.88, COMPLETION_ORB_MODEL.endScale * .9908],
          [1, COMPLETION_ORB_MODEL.endScale],
        ]);
      const normalEyeSpacing = startPose.eyeHalfSpacing
        + (COMPLETION_ORB_MODEL.endEyeHalfSpacing - startPose.eyeHalfSpacing) * xProgress;
      const happyProgress = interpolateKeyframes(progress, [[0, 0], [.12, 0], [.3, 1], [1, 1]]);

      orbRef.current?.setAttribute("transform", `translate(${x} ${y}) scale(${scale})`);
      normalEyesRef.current?.setAttribute("opacity", `${1 - happyProgress}`);
      normalEyesRef.current?.querySelector<SVGGElement>(".completion-normal-eye-left")
        ?.setAttribute("transform", `translate(${-normalEyeSpacing} -4.8)`);
      normalEyesRef.current?.querySelector<SVGGElement>(".completion-normal-eye-right")
        ?.setAttribute("transform", `translate(${normalEyeSpacing} -4.8)`);
      happyEyesRef.current?.setAttribute("opacity", `${happyProgress}`);
      happyEyesRef.current?.setAttribute("transform", `scale(${.76 + happyProgress * .24})`);

      if (elapsed < totalDuration) {
        frame = window.requestAnimationFrame(renderFrame);
      } else {
        onComplete();
      }
    };

    frame = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [animate, durationSeconds, onComplete, startPose]);

  return (
    <svg
      className="completion-reminder-model"
      viewBox="0 0 1000 460"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      style={{
        "--completion-firework-delay": `${Math.round(durationSeconds * 1000 / 1.2 * .45)}ms`,
      } as React.CSSProperties}
    >
      <defs>
        <radialGradient id="completion-orb-fill" cx="35%" cy="25%" r="80%">
          <stop offset="0" stopColor="#17201e" />
          <stop offset=".5" stopColor="#060908" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <filter id="completion-eye-glow" x="-100%" y="-120%" width="300%" height="340%">
          <feGaussianBlur stdDeviation=".68" />
        </filter>
        <path
          id="completion-normal-eye-shape"
          d="M0 -10.56 C3.36 -10.56 5.04 -6.16 5.04 0 C5.04 6.16 3.36 10.56 0 10.56 C-2.4 10.56 -3.96 8.36 -4.68 4.4 C-5.16 1.76 -5.16 -1.76 -4.68 -4.4 C-3.96 -8.36 -2.4 -10.56 0 -10.56 Z"
        />
        <path
          id="completion-happy-eye-shape"
          d="M-13 3 C-10 -5 -5 -9 0 -9 C5 -9 10 -5 13 3 C8 .2 4 -2 0 -2 C-4 -2 -8 .2 -13 3 Z"
        />
      </defs>
      <CompletionFirework x={285} y={250} />
      <CompletionFirework x={715} y={250} />
      <g ref={orbRef} transform={`translate(${startPose.center.x} ${startPose.center.y}) scale(${startPose.scale})`}>
        <circle cx="0" cy="0" r="60" fill="url(#completion-orb-fill)" stroke="#f8fffd" strokeWidth="7" />
        <g ref={normalEyesRef}>
          <g className="completion-normal-eye-left" transform={`translate(${-startPose.eyeHalfSpacing} -4.8)`}>
            <use href="#completion-normal-eye-shape" fill="#f8fffd" />
          </g>
          <g className="completion-normal-eye-right" transform={`translate(${startPose.eyeHalfSpacing} -4.8)`}>
            <use href="#completion-normal-eye-shape" fill="#f8fffd" />
          </g>
        </g>
        <g ref={happyEyesRef} opacity="0">
          <use href="#completion-happy-eye-shape" transform={`translate(${-COMPLETION_ORB_MODEL.endEyeHalfSpacing} -4.8) scale(1.08)`} fill="#49dcff" opacity=".64" filter="url(#completion-eye-glow)" />
          <use href="#completion-happy-eye-shape" transform={`translate(${COMPLETION_ORB_MODEL.endEyeHalfSpacing} -4.8) scale(1.08)`} fill="#49dcff" opacity=".64" filter="url(#completion-eye-glow)" />
          <use href="#completion-happy-eye-shape" transform={`translate(${-COMPLETION_ORB_MODEL.endEyeHalfSpacing} -4.8)`} fill="#ecfcff" />
          <use href="#completion-happy-eye-shape" transform={`translate(${COMPLETION_ORB_MODEL.endEyeHalfSpacing} -4.8)`} fill="#ecfcff" />
        </g>
      </g>
    </svg>
  );
}

function PrimaryRecoveryModel({
  onComplete,
  closeupPose,
  targetEyeHalfSpacing,
}: {
  onComplete: () => void;
  closeupPose: { center: { x: number; y: number }; scale: number };
  targetEyeHalfSpacing: number;
}) {
  const orbRef = useRef<SVGGElement>(null);

  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();

    const renderFrame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / RECOVERY_TRANSITION_MS);
      const xRatio = interpolateKeyframes(progress, [[0, 1], [.62, 1], [.9, .40625], [1, 0]]);
      const yRatio = interpolateKeyframes(progress, [[0, 1], [.38, .875], [.62, .625], [.9, .25], [1, 0]]);
      const scaleRatio = interpolateKeyframes(progress, [[0, 1], [.38, .832], [.62, .437], [.9, .049], [1, 0]]);
      const eyeSpacingRatio = interpolateKeyframes(progress, [[0, 1], [.62, .56], [1, 0]]);
      const x = PRIMARY_ORB_MODEL.startCenter.x
        + (closeupPose.center.x - PRIMARY_ORB_MODEL.startCenter.x) * xRatio;
      const y = PRIMARY_ORB_MODEL.startCenter.y
        + (closeupPose.center.y - PRIMARY_ORB_MODEL.startCenter.y) * yRatio;
      const scale = PRIMARY_ORB_MODEL.startScale
        + (closeupPose.scale - PRIMARY_ORB_MODEL.startScale) * scaleRatio;
      const eyeHalfSpacing = targetEyeHalfSpacing
        + (10.25 - targetEyeHalfSpacing) * eyeSpacingRatio;

      orbRef.current?.setAttribute("transform", `translate(${x} ${y}) scale(${scale})`);
      orbRef.current?.querySelector<SVGGElement>(".recovery-eye-left")
        ?.setAttribute("transform", `translate(${-eyeHalfSpacing} -4.8)`);
      orbRef.current?.querySelector<SVGGElement>(".recovery-eye-right")
        ?.setAttribute("transform", `translate(${eyeHalfSpacing} -4.8)`);

      if (progress < 1) {
        frame = window.requestAnimationFrame(renderFrame);
      } else {
        onComplete();
      }
    };

    frame = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [closeupPose, onComplete, targetEyeHalfSpacing]);

  return (
    <svg
      className="primary-reminder-model recovery-reminder-model"
      viewBox="0 0 1000 460"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="recovery-orb-fill" cx="35%" cy="25%" r="80%">
          <stop offset="0" stopColor="#17201e" />
          <stop offset=".5" stopColor="#060908" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <filter id="recovery-eye-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation=".42" />
        </filter>
        <path
          id="recovery-eye-shape"
          d="M0 -10.56 C3.36 -10.56 5.04 -6.16 5.04 0 C5.04 6.16 3.36 10.56 0 10.56 C-2.4 10.56 -3.96 8.36 -4.68 4.4 C-5.16 1.76 -5.16 -1.76 -4.68 -4.4 C-3.96 -8.36 -2.4 -10.56 0 -10.56 Z"
        />
      </defs>
      <g ref={orbRef} transform={`translate(${closeupPose.center.x} ${closeupPose.center.y}) scale(${closeupPose.scale})`}>
        <circle cx="0" cy="0" r="60" fill="url(#recovery-orb-fill)" stroke="#f8fffd" strokeWidth="7" />
        <g className="recovery-eye-left" transform="translate(-10.25 -4.8)">
          <use href="#recovery-eye-shape" fill="#dffdf6" opacity=".46" filter="url(#recovery-eye-glow)" transform="scale(1.06)" />
          <use href="#recovery-eye-shape" fill="#f8fffd" />
        </g>
        <g className="recovery-eye-right" transform="translate(10.25 -4.8)">
          <use href="#recovery-eye-shape" fill="#dffdf6" opacity=".46" filter="url(#recovery-eye-glow)" transform="scale(1.06)" />
          <use href="#recovery-eye-shape" fill="#f8fffd" />
        </g>
      </g>
    </svg>
  );
}

const formatCountdown = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
};

function FocusClock({
  totalSeconds,
  remainingSeconds,
}: {
  totalSeconds: number;
  remainingSeconds: number;
}) {
  const radius = 176;
  const elapsedProgress = totalSeconds > 0 ? 1 - remainingSeconds / totalSeconds : 0;

  return (
    <section className="focus-clock" aria-label={`剩余专注时间 ${formatCountdown(remainingSeconds)}`}>
      <svg viewBox="0 0 400 400" aria-hidden="true">
        <defs>
          <filter id="clock-progress-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle className="clock-track" cx="200" cy="200" r={radius} />
        <circle
          className="clock-progress"
          cx="200"
          cy="200"
          r={radius}
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - elapsedProgress}
        />
      </svg>
      <div className="focus-clock-content">
        <strong data-testid="countdown">{formatCountdown(remainingSeconds)}</strong>
      </div>
    </section>
  );
}

export default function App() {
  const { releaseScreenWakeLock, requestScreenWakeLock } = useScreenWakeLock();
  const [state, setState] = useState<FocusState>("idle");
  const [motionKey, setMotionKey] = useState(0);
  const [draftTask, setDraftTask] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [setupEngaged, setSetupEngaged] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [focusHistory, setFocusHistory] = useState<FocusHistoryItem[]>(loadFocusHistory);
  const [activeTask, setActiveTask] = useState("");
  const [activeDuration, setActiveDuration] = useState(30);
  const [remainingSeconds, setRemainingSeconds] = useState(30 * 60);
  const [isPaused, setIsPaused] = useState(false);
  const [isAbandoning, setIsAbandoning] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [endScreen, setEndScreen] = useState<"abandon" | "completed" | null>(null);
  const [focusMenu, setFocusMenu] = useState<"paused" | null>(null);
  const [apiConnected, setApiConnected] = useState(false);
  const [displayLogs, setDisplayLogs] = useState<DisplayLogEntry[]>([]);
  const [displayDuration, setDisplayDuration] = useState(4.2);
  const [activeDisplay, setActiveDisplay] = useState("000");
  const [primaryStartPose, setPrimaryStartPose] = useState<OrbPose>({
    center: PRIMARY_ORB_MODEL.startCenter,
    scale: PRIMARY_ORB_MODEL.startScale,
    eyeHalfSpacing: 21,
  });
  const [secondaryStartPose, setSecondaryStartPose] = useState<OrbPose>({
    center: PRIMARY_ORB_MODEL.startCenter,
    scale: PRIMARY_ORB_MODEL.startScale,
    eyeHalfSpacing: 21,
  });
  const [tertiaryStartPose, setTertiaryStartPose] = useState<OrbPose>({
    center: PRIMARY_ORB_MODEL.startCenter,
    scale: PRIMARY_ORB_MODEL.startScale,
    eyeHalfSpacing: 21,
  });
  const [recoveryEyeHalfSpacing, setRecoveryEyeHalfSpacing] = useState(21);
  const [recoveryCloseupPose, setRecoveryCloseupPose] = useState<{
    center: { x: number; y: number };
    scale: number;
  }>(REMINDER_CLOSEUP_POSE);
  const [abandonStartPose, setAbandonStartPose] = useState<OrbPose>({
    center: ABANDON_ORB_MODEL.startCenter,
    scale: ABANDON_ORB_MODEL.startScale,
    eyeHalfSpacing: 21,
  });
  const [completionStartPose, setCompletionStartPose] = useState<OrbPose>({
    center: COMPLETION_ORB_MODEL.startCenter,
    scale: COMPLETION_ORB_MODEL.startScale,
    eyeHalfSpacing: 21,
  });
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [, setSoundReady] = useState(false);
  const stateRef = useRef<FocusState>(state);
  const audioContextRef = useRef<AudioContext | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const startTimerRef = useRef<number | null>(null);
  const sessionTimerRef = useRef<number | null>(null);
  const finishTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const sessionEndsAtRef = useRef<number | null>(null);
  const orbTransitionRef = useRef<HTMLElement | null>(null);
  const orbArrivalTimerRef = useRef<number | null>(null);
  const [orbTransitionActive, setOrbTransitionActive] = useState(false);
  const displayLogIdRef = useRef(0);
  const historyRecordedRef = useRef(false);

  const appendDisplayLog = useCallback((entry: Omit<DisplayLogEntry, "id" | "time">) => {
    displayLogIdRef.current += 1;
    const now = new Date();
    const nextEntry: DisplayLogEntry = {
      ...entry,
      id: displayLogIdRef.current,
      time: now.toLocaleTimeString("zh-CN", { hour12: false }),
    };
    setDisplayLogs((previous) => [...previous, nextEntry].slice(-30));
  }, []);

  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current !== null) window.clearTimeout(durationTimerRef.current);
    durationTimerRef.current = null;
  }, []);

  const clearSessionTimers = useCallback(() => {
    if (sessionTimerRef.current !== null) window.clearTimeout(sessionTimerRef.current);
    if (finishTimerRef.current !== null) window.clearTimeout(finishTimerRef.current);
    if (countdownTimerRef.current !== null) window.clearInterval(countdownTimerRef.current);
    sessionTimerRef.current = null;
    finishTimerRef.current = null;
    countdownTimerRef.current = null;
    sessionEndsAtRef.current = null;
  }, []);

  const unlockSound = useCallback(async () => {
    try {
      const context = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = context;
      if (context.state !== "running") await context.resume();
      const ready = context.state === "running";
      setSoundReady(ready);
      return ready;
    } catch {
      setSoundReady(false);
      return false;
    }
  }, []);

  const playStateTone = useCallback((nextState: FocusState) => {
    if (!soundEnabled || STATE_CONFIG[nextState].tone.length === 0) return;
    const context = audioContextRef.current;
    if (!context) return;

    if (context.state === "running") {
      emitTone(context, nextState);
      return;
    }

    context.resume()
      .then(() => {
        setSoundReady(context.state === "running");
        if (context.state === "running") emitTone(context, nextState);
      })
      .catch(() => setSoundReady(false));
  }, [soundEnabled]);

  const transitionTo = useCallback((nextState: FocusState, duration?: number) => {
    clearDurationTimer();
    stateRef.current = nextState;
    setState(nextState);
    setMotionKey((value) => value + 1);
    playStateTone(nextState);

    if (duration && duration > 0 && !["idle", "focused", "finished"].includes(nextState)) {
      durationTimerRef.current = window.setTimeout(() => {
        setState("focused");
        setMotionKey((value) => value + 1);
        playStateTone("focused");
        durationTimerRef.current = null;
      }, duration * 1000);
    }
  }, [clearDurationTimer, playStateTone]);

  const scheduleSessionEnd = useCallback((seconds: number, delayMs = 0) => {
    if (sessionTimerRef.current !== null) window.clearTimeout(sessionTimerRef.current);
    if (countdownTimerRef.current !== null) window.clearInterval(countdownTimerRef.current);

    const safeSeconds = Math.max(0, seconds);
    const endsAt = Date.now() + delayMs + safeSeconds * 1000;
    sessionEndsAtRef.current = endsAt;
    setRemainingSeconds(safeSeconds);
    countdownTimerRef.current = window.setInterval(() => {
      const nextRemaining = Math.min(safeSeconds, Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
      setRemainingSeconds(nextRemaining);
      if (nextRemaining === 0 && countdownTimerRef.current !== null) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    }, 250);
    sessionTimerRef.current = window.setTimeout(() => {
      sessionEndsAtRef.current = null;
      setCompletionStartPose(readCurrentOrbPose());
      setIsCompleting(true);
      setEndScreen(null);
      transitionTo("ending");
      sessionTimerRef.current = null;
    }, delayMs + safeSeconds * 1000);
  }, [transitionTo]);

  const applyDisplayUpdate = useCallback((update: DisplayUpdate, source = "SSE") => {
    const display = normalizeDisplayCode(update.display);
    const nextState = resolveDisplayState(update);
    const duration = nextState === "distracted" ? update.duration ?? 4.2 : update.duration;
    appendDisplayLog({
      kind: nextState === "error" ? "error" : "message",
      source,
      summary: `${display} → ${nextState}`,
      details: JSON.stringify(update),
    });
    if (display === "000" && ["distracted", "recovered"].includes(stateRef.current)) {
      return;
    }
    if (display === "111") {
      setActiveDisplay(display);
      transitionTo("recovered");
      return;
    }
    if (nextState === "distracted" && ["001", "002", "003"].includes(display)) {
      const startPose = readCurrentOrbPose();
      setRecoveryEyeHalfSpacing(startPose.eyeHalfSpacing);
      if (display === "001") {
        setPrimaryStartPose(startPose);
        setRecoveryCloseupPose({ center: PRIMARY_ORB_MODEL.endCenter, scale: PRIMARY_ORB_MODEL.endScale });
      }
      if (display === "002") {
        setSecondaryStartPose(startPose);
        setRecoveryCloseupPose({ center: SECONDARY_ORB_MODEL.endCenter, scale: SECONDARY_ORB_MODEL.endScale });
      }
      if (display === "003") {
        setTertiaryStartPose(startPose);
        setRecoveryCloseupPose({ center: TERTIARY_ORB_MODEL.endCenter, scale: TERTIARY_ORB_MODEL.endScale });
      }
    }
    setActiveDisplay(display);
    if (nextState === "distracted") setDisplayDuration(duration && duration > 0 ? duration : 4.2);
    transitionTo(nextState, nextState === "distracted" ? undefined : duration);
  }, [appendDisplayLog, transitionTo]);

  const completeRecovery = useCallback(() => {
    setActiveDisplay("000");
    transitionTo("focused");
  }, [transitionTo]);

  const clearOrbTransition = useCallback(() => {
    orbTransitionRef.current?.remove();
    orbTransitionRef.current = null;
    if (orbArrivalTimerRef.current !== null) {
      window.clearTimeout(orbArrivalTimerRef.current);
      orbArrivalTimerRef.current = null;
    }
    setOrbTransitionActive(false);
  }, []);

  const startOrbTransition = useCallback(() => {
    const source = document.querySelector<HTMLElement>('[data-testid="mascot"]');
    const stage = document.querySelector<HTMLElement>(".visual-stage");
    if (!source || !stage) return;

    clearOrbTransition();
    const from = source.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const portrait = window.matchMedia("(orientation: portrait)").matches;
    const unit = portrait
      ? Math.min(window.innerHeight / 1000, window.innerWidth / 460)
      : Math.min(stageRect.width / 1000, stageRect.height / 460);
    const targetDiameter = ORB_BASE_DIAMETER * PAGE_ORB_POSES.focusedLandscape.scale * unit;
    const portraitOffsetX = (window.innerHeight - 1000 * unit) / 2;
    const portraitOffsetY = (window.innerWidth - 460 * unit) / 2;
    const landscapeOffsetX = (stageRect.width - 1000 * unit) / 2;
    const landscapeOffsetY = (stageRect.height - 460 * unit) / 2;
    const targetCenterX = portrait
      ? window.innerWidth - (portraitOffsetY + PAGE_ORB_POSES.focusedLandscape.center.y * unit)
      : stageRect.left + landscapeOffsetX + PAGE_ORB_POSES.focusedLandscape.center.x * unit;
    const targetCenterY = portrait
      ? portraitOffsetX + PAGE_ORB_POSES.focusedLandscape.center.x * unit
      : stageRect.top + landscapeOffsetY + PAGE_ORB_POSES.focusedLandscape.center.y * unit;
    const to = {
      top: targetCenterY - targetDiameter / 2,
      left: targetCenterX - targetDiameter / 2,
      width: targetDiameter,
      height: targetDiameter,
    };
    const clone = source.cloneNode(true) as HTMLElement;
    const stateColor = getComputedStyle(source).getPropertyValue("--state-color");
    clone.removeAttribute("data-testid");
    clone.className = "mascot orb-transition-clone";
    clone.setAttribute("aria-hidden", "true");
    clone.style.setProperty("--state-color", stateColor || "#ffffff");
    Object.assign(clone.style, {
      top: `${from.top}px`,
      left: `${from.left}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
    });
    document.body.appendChild(clone);
    orbTransitionRef.current = clone;
    setOrbTransitionActive(true);

    const targetRotation = window.matchMedia("(orientation: portrait)").matches ? 90 : 0;
    const animation = clone.animate(
      [
        {
          top: `${from.top}px`,
          left: `${from.left}px`,
          width: `${from.width}px`,
          height: `${from.height}px`,
          transform: "rotate(0deg)",
        },
        {
          top: `${to.top}px`,
          left: `${to.left}px`,
          width: `${to.width}px`,
          height: `${to.height}px`,
          transform: `rotate(${targetRotation}deg)`,
        },
      ],
      {
        duration: START_TRANSITION_MS,
        easing: "cubic-bezier(.22, .72, .2, 1)",
        fill: "forwards",
      },
    );

    animation.finished.catch(() => undefined).finally(() => {
      if (orbTransitionRef.current === clone) {
        clone.remove();
        orbTransitionRef.current = null;
      }
    });
  }, [clearOrbTransition]);

  const runStartAnimation = useCallback(async (session?: FocusSessionDraft) => {
    if (!session) return;
    requestCameraStart();
    void requestScreenWakeLock();
    notifyFocusBackend("/api/set_focus", {
      focus_content: session.taskName,
      detection_interval: session.durationMinutes * 60,
    });

    // 点击 START 3 秒后触发 action 004
    window.setTimeout(() => {
      console.log("[action-004] 准备触发...");
      void triggerAction004();
    }, 3000);

    if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
    const orientationRequest = requestLandscapeMode();
    const soundRequest = soundEnabled ? unlockSound() : Promise.resolve(false);
    void Promise.allSettled([orientationRequest, soundRequest]);
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
    startOrbTransition();
    clearSessionTimers();
    const totalSeconds = session.durationMinutes * 60;
    historyRecordedRef.current = false;
    setActiveTask(session.taskName);
    setActiveDuration(session.durationMinutes);
    setIsPaused(false);
    scheduleSessionEnd(totalSeconds, START_TRANSITION_MS);
    transitionTo("starting");
    startTimerRef.current = window.setTimeout(() => {
      clearDurationTimer();
      setState("focused");
      setMotionKey((value) => value + 1);
      orbArrivalTimerRef.current = window.setTimeout(() => {
        setOrbTransitionActive(false);
        orbArrivalTimerRef.current = null;
      }, 360);
      startTimerRef.current = null;
    }, START_TRANSITION_MS);
  }, [clearDurationTimer, clearSessionTimers, requestScreenWakeLock, scheduleSessionEnd, soundEnabled, startOrbTransition, transitionTo, unlockSound]);

  const pauseFocus = useCallback(() => {
    const secondsLeft = sessionEndsAtRef.current === null
      ? remainingSeconds
      : Math.max(0, Math.ceil((sessionEndsAtRef.current - Date.now()) / 1000));
    if (sessionTimerRef.current !== null) window.clearTimeout(sessionTimerRef.current);
    if (countdownTimerRef.current !== null) window.clearInterval(countdownTimerRef.current);
    sessionTimerRef.current = null;
    countdownTimerRef.current = null;
    sessionEndsAtRef.current = null;
    setRemainingSeconds(secondsLeft);
    setIsPaused(true);
    setFocusMenu("paused");
    void releaseScreenWakeLock();
    notifyFocusBackend("/api/stop_temporary_focus", {});
  }, [releaseScreenWakeLock, remainingSeconds]);

  const continueFocus = useCallback(() => {
    void requestScreenWakeLock();
    setIsPaused(false);
    setFocusMenu(null);
    scheduleSessionEnd(remainingSeconds);
    notifyFocusBackend("/api/continue_focus", {});
  }, [remainingSeconds, requestScreenWakeLock, scheduleSessionEnd]);

  const handleDistractionPreview = async (display: "001" | "002" | "003") => {
    if (soundEnabled) await unlockSound();
    const previewText = {
      "001": "用户开始分心，小球探出观察并进行一级提醒",
      "002": "用户现在不专注，需要进行二级提醒",
      "003": "用户持续不专注，需要进行三级警告",
    }[display];
    applyDisplayUpdate({
      text: previewText,
      display,
      focus_state: "distracted",
      duration: 4.2,
    }, "DEV");
  };

  const handleRecoveryPreview = async () => {
    if (soundEnabled) await unlockSound();
    applyDisplayUpdate({
      text: "恢复正常专注状态",
      display: "111",
      focus_state: "focused",
    }, "DEV");
  };

  const handleCompletePreview = () => {
    if (state !== "focused" || isCompleting) return;
    clearSessionTimers();
    clearDurationTimer();
    setRemainingSeconds(0);
    setCompletionStartPose(readCurrentOrbPose());
    setIsPaused(false);
    setFocusMenu(null);
    setEndScreen(null);
    setIsCompleting(true);
    transitionTo("ending");
  };

  const beginAbandonFocus = () => {
    setAbandonStartPose(readCurrentOrbPose());
    setFocusMenu(null);
    setEndScreen(null);
    setIsAbandoning(true);
  };

  const completeAbandonAnimation = useCallback(() => {
    setEndScreen("abandon");
  }, []);

  const completeFocusAnimation = useCallback(() => {
    setEndScreen("completed");
    transitionTo("finished");
  }, [transitionTo]);

  const resetTaskSetup = async () => {
    void releaseScreenWakeLock();
    clearOrbTransition();
    clearSessionTimers();
    clearDurationTimer();
    setActiveTask("");
    setIsPaused(false);
    setIsAbandoning(false);
    setIsCompleting(false);
    setEndScreen(null);
    setFocusMenu(null);
    setRemainingSeconds(durationMinutes * 60);
    await requestPortraitMode();
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
    transitionTo("idle");
  };

  useEffect(() => {
    if (["ending", "finished", "error"].includes(state)) {
      void releaseScreenWakeLock();
    }
  }, [releaseScreenWakeLock, state]);

  useEffect(() => {
    if (state === "idle") void requestPortraitMode();
  }, [state]);

  useEffect(() => {
    const source = new EventSource("./api/display/events");
    const onDisplay = (event: Event) => {
      const raw = (event as MessageEvent<string>).data;
      try {
        const update = JSON.parse(raw) as DisplayUpdate;
        applyDisplayUpdate(update, "SSE");
      } catch (error) {
        appendDisplayLog({
          kind: "error",
          source: "SSE",
          summary: "JSON 解析失败",
          details: `${error instanceof Error ? error.message : "未知错误"} · ${raw.slice(0, 240)}`,
        });
      }
    };

    source.addEventListener("display", onDisplay);
    source.onopen = () => {
      setApiConnected(true);
      appendDisplayLog({ kind: "connection", source: "SSE", summary: "实时连接已建立" });
    };
    source.onerror = () => {
      setApiConnected(false);
      appendDisplayLog({ kind: "error", source: "SSE", summary: "连接中断，浏览器正在重连" });
    };
    return () => {
      source.removeEventListener("display", onDisplay);
      source.close();
    };
  }, [appendDisplayLog, applyDisplayUpdate]);

  useEffect(() => () => {
    clearDurationTimer();
    clearSessionTimers();
    if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
    orbTransitionRef.current?.remove();
    if (orbArrivalTimerRef.current !== null) window.clearTimeout(orbArrivalTimerRef.current);
    audioContextRef.current?.close().catch(() => undefined);
  }, [clearDurationTimer, clearSessionTimers]);

  useEffect(() => {
    if (state !== "finished" || !activeTask || historyRecordedRef.current) return;
    historyRecordedRef.current = true;
    const completed: FocusHistoryItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: activeTask,
      durationMinutes: activeDuration,
      completedAt: new Date().toISOString(),
      rewardCoins: Math.max(5, Math.round(activeDuration / 5) * 2),
    };
    setFocusHistory((previous) => {
      const next = [completed, ...previous].slice(0, 100);
      window.localStorage.setItem(FOCUS_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [activeDuration, activeTask, state]);

  const config = STATE_CONFIG[state];
  const stateColor = state === "distracted" && activeDisplay === "003" ? "#ff301c" : config.color;
  const showTimerSetup = state === "idle";
  const showSetupLayer = state === "idle" || state === "starting";
  const showBaseMascot = !(
    state === "distracted"
    || state === "recovered"
    || isAbandoning
    || isCompleting
    || endScreen
  );
  const timerTotalSeconds = (state === "idle" ? durationMinutes : activeDuration) * 60;

  const updateDuration = (value: number) => {
    const normalized = Number.isFinite(value) ? Math.min(120, Math.max(5, Math.round(value / 5) * 5)) : 5;
    setDurationMinutes(normalized);
    setRemainingSeconds(normalized * 60);
  };

  if (profileOpen) {
    const coins = 180 + focusHistory.reduce((sum, item) => sum + item.rewardCoins, 0);
    return <ProfileScreen history={focusHistory} coins={coins} onBack={() => setProfileOpen(false)} />;
  }

  return (
    <div
      className="app-shell"
      data-state={state}
      data-display={activeDisplay}
      data-orb-arriving={orbTransitionActive ? "true" : undefined}
      data-paused={focusMenu === "paused" ? "true" : undefined}
      data-abandoning={isAbandoning ? "true" : undefined}
      data-completing={isCompleting ? "true" : undefined}
      style={{
        "--state-color": stateColor,
        "--display-duration": `${displayDuration}s`,
      } as React.CSSProperties}
    >
      <main className={`visual-stage ${showTimerSetup ? "setup-mode" : ""}`} aria-label={`当前状态：${config.label}`}>
        <div className="scene-backdrop" aria-hidden="true">
          <div className="scene-haze scene-haze-left" />
          <div className="scene-haze scene-haze-right" />
          <div className="scene-horizon-light" />
        </div>
        <div className="scene-floor" aria-hidden="true">
          <div className="scene-floor-light" />
        </div>
        <div className="scene-pool-light" aria-hidden="true" />
        {showBaseMascot && (
          <div className="orb-coordinate-space">
            <Mascot
              state={state}
              motionKey={motionKey}
              landscapePose={PAGE_ORB_POSES.focusedLandscape}
              portraitPose={PAGE_ORB_POSES.setupPortrait}
              paused={focusMenu === "paused"}
              lookingDown={state === "idle" && setupEngaged}
            />
          </div>
        )}
        {state === "distracted" && activeDisplay === "001" && (
          <PrimaryReminderModel durationSeconds={displayDuration} startPose={primaryStartPose} />
        )}
        {state === "distracted" && activeDisplay === "002" && (
          <SecondaryReminderModel durationSeconds={displayDuration} startPose={secondaryStartPose} />
        )}
        {state === "distracted" && activeDisplay === "003" && (
          <TertiaryReminderModel durationSeconds={displayDuration} startPose={tertiaryStartPose} />
        )}
        {state === "recovered" && activeDisplay === "111" && (
          <PrimaryRecoveryModel
            onComplete={completeRecovery}
            closeupPose={recoveryCloseupPose}
            targetEyeHalfSpacing={recoveryEyeHalfSpacing}
          />
        )}
        {isAbandoning && (
          <AbandonReminderModel
            durationSeconds={4.2}
            startPose={abandonStartPose}
            onComplete={completeAbandonAnimation}
          />
        )}
        {isCompleting && (
          <CompletionReminderModel
            animate={state === "ending"}
            durationSeconds={4.2}
            startPose={completionStartPose}
            onComplete={completeFocusAnimation}
          />
        )}
        {!showTimerSetup && (
          <FocusClock totalSeconds={timerTotalSeconds} remainingSeconds={remainingSeconds} />
        )}
        {showSetupLayer && (
          <FocusSetupScreen
            taskName={draftTask}
            durationMinutes={durationMinutes}
            onTaskNameChange={setDraftTask}
            onDurationChange={updateDuration}
            onEngagementChange={setSetupEngaged}
            onOpenProfile={() => setProfileOpen(true)}
            onStart={runStartAnimation}
          />
        )}
        {endScreen && (
          <button className="end-home-button" type="button" onClick={resetTaskSetup}>HOME</button>
        )}
        {focusMenu && (
          <div className="focus-control-backdrop" role="presentation">
            <section
              className="focus-control-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="focus-control-title"
            >
              <h2 id="focus-control-title" className="sr-only">专注已暂停</h2>
              <div className="focus-control-actions">
                <button type="button" onClick={continueFocus}>
                  继续专注
                </button>
                <button type="button" className="danger" onClick={beginAbandonFocus}>
                  放弃专注
                </button>
              </div>
            </section>
          </div>
        )}
        <span className="sr-only" aria-live="polite">{config.label}</span>
        <div className="scene-foreground scene-foreground-left" aria-hidden="true" />
        <div className="scene-foreground scene-foreground-right" aria-hidden="true" />
      </main>

      {activeTask && state === "focused" && !isAbandoning && (
        <div className="focus-session-tools">
          <span className="focus-session-task" title={activeTask}>{activeTask}</span>
          <button
            type="button"
            className="focus-pause-button"
            onClick={pauseFocus}
            disabled={isPaused}
            aria-label="暂停专注"
          >
            <i aria-hidden="true"><span /><span /></i>
          </button>
        </div>
      )}

      <aside className="developer-panel" aria-label="开发者测试面板">
        <div className="developer-heading">
          <div>
            <span>DEVELOPER</span>
            <h1>状态测试</h1>
          </div>
          <i className={apiConnected ? "online" : ""} title={apiConnected ? "接口已连接" : "接口未连接"} />
        </div>

        <div className="distraction-triggers">
          <button
            className={`distraction-trigger peek ${state === "distracted" && activeDisplay === "001" ? "active" : ""}`}
            onClick={() => handleDistractionPreview("001")}
            data-testid="trigger-distraction"
          >
            <i />
            <span>{state === "distracted" && activeDisplay === "001" ? "观察提醒中" : "一级提醒"}</span>
            <small>001</small>
          </button>
          <button
            className={`distraction-trigger ${state === "distracted" && activeDisplay === "002" ? "active" : ""}`}
            onClick={() => handleDistractionPreview("002")}
            data-testid="trigger-distraction-002"
          >
            <i />
            <span>{state === "distracted" && activeDisplay === "002" ? "二级提醒中" : "二级提醒"}</span>
            <small>002</small>
          </button>
          <button
            className={`distraction-trigger danger ${state === "distracted" && activeDisplay === "003" ? "active" : ""}`}
            onClick={() => handleDistractionPreview("003")}
            data-testid="trigger-distraction-003"
          >
            <i />
            <span>{state === "distracted" && activeDisplay === "003" ? "三级警告中" : "三级警告"}</span>
            <small>003</small>
          </button>
          <button
            className={`distraction-trigger recovery ${state === "recovered" ? "active" : ""}`}
            onClick={handleRecoveryPreview}
            data-testid="trigger-recovery"
          >
            <i />
            <span>{state === "recovered" ? "恢复中" : "恢复专注"}</span>
            <small>111</small>
          </button>
          <button
            className="distraction-trigger completion"
            onClick={handleCompletePreview}
            disabled={state !== "focused" || isCompleting}
            data-testid="trigger-completion"
          >
            <i />
            <span>立即完成任务</span>
            <small>DONE</small>
          </button>
        </div>

        <section className="display-log-panel" aria-label="数据显示日志" data-testid="display-log-panel">
          <div className="display-log-heading">
            <div>
              <span>LIVE DATA</span>
              <strong>接收日志</strong>
            </div>
            <button type="button" onClick={() => setDisplayLogs([])} disabled={displayLogs.length === 0}>清空</button>
          </div>
          <div className="display-log-list" data-testid="display-log-list">
            {displayLogs.length === 0 ? (
              <p className="display-log-empty">等待接口数据…</p>
            ) : (
              [...displayLogs].reverse().map((entry) => (
                <article className={`display-log-entry ${entry.kind}`} key={entry.id}>
                  <div>
                    <time>{entry.time}</time>
                    <b>{entry.source}</b>
                    <span>{entry.summary}</span>
                  </div>
                  {entry.details && <code title={entry.details}>{entry.details}</code>}
                </article>
              ))
            )}
          </div>
        </section>

        <div className="developer-footer">
          {activeTask && state !== "idle" && (
            <div className="session-context" title={activeTask}>
              <span>CURRENT SESSION</span>
              <strong>{activeTask}</strong>
              <small>{activeDuration} 分钟</small>
            </div>
          )}
        </div>
      </aside>

      <div className="portrait-hint" aria-hidden="true"><span>↻</span> 请将手机横屏</div>
    </div>
  );
}
