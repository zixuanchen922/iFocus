import { useCallback, useEffect, useRef, useState } from "react";
import FocusSetupScreen from "./components/FocusSetupScreen";
import type { FocusSessionDraft } from "./components/FocusSetupScreen";
import type { FocusState } from "./types";

interface DisplayUpdate {
  text?: string;
  display: string | number;
  focus_state?: string;
  duration?: number;
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

type LockableScreenOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape") => Promise<void>;
};

type StandaloneNavigator = Navigator & {
  standalone?: boolean;
};

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as StandaloneNavigator).standalone);
}

async function requestImmersiveMode() {
  let fullscreenActive = Boolean(document.fullscreenElement) || isStandaloneMode();

  if (!fullscreenActive && document.documentElement.requestFullscreen) {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      fullscreenActive = Boolean(document.fullscreenElement);
    } catch {
      // Some mobile browsers only remove browser chrome for installed PWAs.
    }
  }

  if (!window.matchMedia("(orientation: landscape)").matches) {
    try {
      const orientation = screen.orientation as LockableScreenOrientation;
      await orientation.lock?.call(orientation, "landscape");
    } catch {
      // iOS and embedded browsers may require the user to rotate the device manually.
    }
  }

  return fullscreenActive || isStandaloneMode();
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
const HOP_DISTANCE_VW = 10.8;

const randomRestDuration = () => 1000 + Math.round(Math.random() * 2000);

function Mascot({
  state,
  motionKey,
  lookingDown = false,
}: {
  state: FocusState;
  motionKey: number;
  lookingDown?: boolean;
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

    if (state !== "focused" || !mascot || !body || !shadow || !reflection) {
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
            { transform: `translate3d(${fromX}vw, 0, -45px) scale(.97)` },
            { transform: `translate3d(${toX}vw, 0, -45px) scale(.97)` },
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

      if (!cancelled) mascot.style.transform = `translate3d(${toX}vw, 0, -45px) scale(.97)`;
      animations.forEach((animation) => {
        activeAnimations.delete(animation);
        animation.cancel();
      });
    };

    const runIdleMotion = async () => {
      let currentX = 0;
      mascot.style.opacity = "1";
      mascot.style.transform = "translate3d(0, 0, -45px) scale(.97)";

      while (!cancelled) {
        for (let hop = 0; hop < HOP_HEIGHTS.length; hop += 1) {
          await wait(randomRestDuration());
          if (cancelled) return;

          setGaze("right");
          await wait(240);
          if (cancelled) return;

          const nextX = (hop + 1) * HOP_DISTANCE_VW;
          await playHop(currentX, nextX, HOP_HEIGHTS[hop], HOP_TILTS[hop]);
          currentX = nextX;
          if (cancelled) return;

          setGaze("center");
        }

        await wait(randomRestDuration());
        if (cancelled) return;
        setGaze("left");
        await wait(240);
        if (cancelled) return;

        const fadeOut = mascot.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 180,
          easing: "ease-out",
          fill: "forwards",
        });
        activeAnimations.add(fadeOut);
        await fadeOut.finished.catch(() => undefined);
        activeAnimations.delete(fadeOut);
        fadeOut.cancel();
        if (cancelled) return;

        currentX = 0;
        mascot.style.opacity = "0";
        mascot.style.transform = "translate3d(0, 0, -45px) scale(.97)";
        setGaze("center");
        await wait(100);

        const fadeIn = mascot.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 220,
          easing: "ease-out",
          fill: "forwards",
        });
        activeAnimations.add(fadeIn);
        await fadeIn.finished.catch(() => undefined);
        activeAnimations.delete(fadeIn);
        fadeIn.cancel();
        mascot.style.opacity = "1";
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
  }, [motionKey, state]);

  return (
    <div
      ref={mascotRef}
      className={`mascot mascot-${state} mascot-gaze-${gaze} ${lookingDown ? "mascot-looking-down" : ""}`}
      key={motionKey}
      data-testid="mascot"
      role="img"
      aria-label="iFocus 形象"
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
  const [state, setState] = useState<FocusState>("idle");
  const [motionKey, setMotionKey] = useState(0);
  const [draftTask, setDraftTask] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [setupEngaged, setSetupEngaged] = useState(false);
  const [activeTask, setActiveTask] = useState("");
  const [activeDuration, setActiveDuration] = useState(30);
  const [remainingSeconds, setRemainingSeconds] = useState(30 * 60);
  const [apiConnected, setApiConnected] = useState(false);
  const [showFullscreenHint, setShowFullscreenHint] = useState(false);
  const [displayLogs, setDisplayLogs] = useState<DisplayLogEntry[]>([]);
  const [displayDuration, setDisplayDuration] = useState(4.2);
  const [activeDisplay, setActiveDisplay] = useState("000");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [, setSoundReady] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const startTimerRef = useRef<number | null>(null);
  const sessionTimerRef = useRef<number | null>(null);
  const finishTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const orbTargetRef = useRef<HTMLDivElement | null>(null);
  const orbTransitionRef = useRef<HTMLElement | null>(null);
  const orbArrivalTimerRef = useRef<number | null>(null);
  const [orbTransitionActive, setOrbTransitionActive] = useState(false);
  const displayLogIdRef = useRef(0);

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

  const applyDisplayUpdate = useCallback((update: DisplayUpdate, source = "SSE") => {
    const nextState = resolveDisplayState(update);
    const display = normalizeDisplayCode(update.display);
    const duration = nextState === "distracted" ? update.duration ?? 4.2 : update.duration;
    appendDisplayLog({
      kind: nextState === "error" ? "error" : "message",
      source,
      summary: `${display} → ${nextState}`,
      details: JSON.stringify(update),
    });
    setActiveDisplay(display);
    if (nextState === "distracted") setDisplayDuration(duration && duration > 0 ? duration : 4.2);
    transitionTo(nextState, duration);
  }, [appendDisplayLog, transitionTo]);

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
    const target = orbTargetRef.current;
    if (!source || !target) return;

    clearOrbTransition();
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
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
    if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
    if (session) startOrbTransition();
    const immersiveRequest = session
      ? requestImmersiveMode().then((enteredFullscreen) => setShowFullscreenHint(!enteredFullscreen))
      : Promise.resolve(false);
    if (session) {
      clearSessionTimers();
      const totalSeconds = session.durationMinutes * 60;
      const endsAt = Date.now() + START_TRANSITION_MS + totalSeconds * 1000;
      setActiveTask(session.taskName);
      setActiveDuration(session.durationMinutes);
      setRemainingSeconds(totalSeconds);
      countdownTimerRef.current = window.setInterval(() => {
        const nextRemaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        setRemainingSeconds(nextRemaining);
        if (nextRemaining === 0 && countdownTimerRef.current !== null) {
          window.clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
        }
      }, 250);
      sessionTimerRef.current = window.setTimeout(() => {
        transitionTo("ending");
        finishTimerRef.current = window.setTimeout(() => {
          transitionTo("finished");
          finishTimerRef.current = null;
        }, 1_050);
        sessionTimerRef.current = null;
      }, START_TRANSITION_MS + session.durationMinutes * 60_000);
    }
    const soundRequest = soundEnabled ? unlockSound() : Promise.resolve(false);
    transitionTo("starting");
    startTimerRef.current = window.setTimeout(() => {
      transitionTo("focused");
      orbArrivalTimerRef.current = window.setTimeout(() => {
        setOrbTransitionActive(false);
        orbArrivalTimerRef.current = null;
      }, 360);
      startTimerRef.current = null;
    }, START_TRANSITION_MS);
    await Promise.allSettled([immersiveRequest, soundRequest]);
  }, [clearSessionTimers, soundEnabled, startOrbTransition, transitionTo, unlockSound]);

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

  const resetTaskSetup = () => {
    clearOrbTransition();
    clearSessionTimers();
    clearDurationTimer();
    setActiveTask("");
    setShowFullscreenHint(false);
    setRemainingSeconds(durationMinutes * 60);
    transitionTo("idle");
  };

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

  const config = STATE_CONFIG[state];
  const stateColor = state === "distracted" && activeDisplay === "003" ? "#ff301c" : config.color;
  const showTimerSetup = state === "idle";
  const showSetupLayer = state === "idle" || state === "starting";
  const timerTotalSeconds = (state === "idle" ? durationMinutes : activeDuration) * 60;

  useEffect(() => {
    const onFullscreenChange = () => {
      if (state !== "idle" && !document.fullscreenElement && !isStandaloneMode()) {
        setShowFullscreenHint(true);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [state]);

  const updateDuration = (value: number) => {
    const normalized = Number.isFinite(value) ? Math.min(120, Math.max(5, Math.round(value / 5) * 5)) : 5;
    setDurationMinutes(normalized);
    setRemainingSeconds(normalized * 60);
  };

  return (
    <div
      className="app-shell"
      data-state={state}
      data-display={activeDisplay}
      data-orb-arriving={orbTransitionActive ? "true" : undefined}
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
        <Mascot state={state} motionKey={motionKey} lookingDown={state === "idle" && setupEngaged} />
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
            onStart={runStartAnimation}
          />
        )}
        {state === "finished" && (
          <button className="new-task-button" onClick={resetTaskSetup}>设置新任务</button>
        )}
        <span className="sr-only" aria-live="polite">{config.label}</span>
        <div className="scene-foreground scene-foreground-left" aria-hidden="true" />
        <div className="scene-foreground scene-foreground-right" aria-hidden="true" />
      </main>

      <div className="focus-orb-target-stage" aria-hidden="true">
        <div ref={orbTargetRef} className="focus-orb-target-probe" />
      </div>

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

      {showFullscreenHint && state !== "idle" && (
        <div className="fullscreen-hint" role="status" data-testid="fullscreen-hint">
          <span>浏览器限制了全屏，请添加到主屏幕后重新打开</span>
          <button type="button" onClick={() => setShowFullscreenHint(false)} aria-label="关闭提示">×</button>
        </div>
      )}

      <div className="portrait-hint" aria-hidden="true"><span>↻</span> 请将手机横屏</div>
    </div>
  );
}
