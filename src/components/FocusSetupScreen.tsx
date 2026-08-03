import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";

const MIN_DURATION = 5;
const MAX_DURATION = 120;
const DURATION_STEP = 5;
const PIXELS_PER_STEP = 18;

const DURATION_VALUES = Array.from(
  { length: (MAX_DURATION - MIN_DURATION) / DURATION_STEP + 1 },
  (_, index) => MIN_DURATION + index * DURATION_STEP,
);

export interface FocusSessionDraft {
  taskName: string;
  durationMinutes: number;
}

interface FocusSetupScreenProps {
  taskName: string;
  durationMinutes: number;
  onTaskNameChange: (value: string) => void;
  onDurationChange: (value: number) => void;
  onEngagementChange: (engaged: boolean) => void;
  onStart: (session: FocusSessionDraft) => void;
}

function clampDuration(value: number) {
  const stepped = Math.round(value / DURATION_STEP) * DURATION_STEP;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, stepped));
}

export default function FocusSetupScreen({
  taskName,
  durationMinutes,
  onTaskNameChange,
  onDurationChange,
  onEngagementChange,
  onStart,
}: FocusSetupScreenProps) {
  const previousDuration = useRef(durationMinutes);
  const transitionTimer = useRef<number | null>(null);
  const dragState = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null);
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [transitionFrom, setTransitionFrom] = useState<number | null>(null);

  useEffect(() => {
    const previous = previousDuration.current;
    if (durationMinutes === previous) return;

    setDirection(durationMinutes > previous ? "up" : "down");
    setTransitionFrom(previous);
    previousDuration.current = durationMinutes;

    if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current);
    transitionTimer.current = window.setTimeout(() => {
      setTransitionFrom(null);
      transitionTimer.current = null;
    }, 320);
  }, [durationMinutes]);

  useEffect(() => () => {
    if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current);
  }, []);

  const changeDuration = (value: number) => {
    onDurationChange(clampDuration(value));
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    onEngagementChange(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: durationMinutes,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const offsetSteps = Math.round((drag.startX - event.clientX) / PIXELS_PER_STEP);
    changeDuration(drag.startValue + offsetSteps * DURATION_STEP);
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onEngagementChange(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      changeDuration(durationMinutes - DURATION_STEP);
    }
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      changeDuration(durationMinutes + DURATION_STEP);
    }
    if (event.key === "Home") {
      event.preventDefault();
      changeDuration(MIN_DURATION);
    }
    if (event.key === "End") {
      event.preventDefault();
      changeDuration(MAX_DURATION);
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaX) < 1 && Math.abs(event.deltaY) < 1) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    changeDuration(durationMinutes + Math.sign(delta) * DURATION_STEP);
  };

  const digitCount = Math.max(
    2,
    String(durationMinutes).length,
    transitionFrom === null ? 0 : String(transitionFrom).length,
  );
  const currentDigits = String(durationMinutes).padStart(digitCount, "0").split("");
  const previousDigits = transitionFrom === null
    ? currentDigits
    : String(transitionFrom).padStart(digitCount, "0").split("");

  return (
    <section className="focus-setup" aria-labelledby="focus-setup-title">
      <h1 className="focus-setup__brand focus-setup__focus-glow" id="focus-setup-title">iFocus</h1>
      <div className="focus-setup__orb-slot" aria-hidden="true" />

      <form
        className="focus-setup__form"
        data-testid="timer-setup"
        onSubmit={(event) => {
          event.preventDefault();
          const normalizedTask = taskName.trim();
          if (!normalizedTask) return;
          onStart({ taskName: normalizedTask, durationMinutes });
        }}
      >
        <label className="focus-setup__prompt" htmlFor="focus-task-name">
          What's your <span className="focus-setup__focus-glow">focus</span> today?
        </label>
        <input
          className="focus-setup__input"
          id="focus-task-name"
          name="taskName"
          type="text"
          value={taskName}
          placeholder="Type your task"
          maxLength={80}
          autoComplete="off"
          onChange={(event) => onTaskNameChange(event.target.value)}
          onFocus={() => onEngagementChange(true)}
          onBlur={() => onEngagementChange(false)}
          data-testid="task-input"
        />

        <div
          className={`focus-setup__duration focus-setup__duration--digits-${digitCount} ${
            transitionFrom === null ? "" : `focus-setup__duration--${direction}`
          }`}
        >
          <span className="focus-setup__number-group" aria-hidden="true">
            {currentDigits.map((digit, index) => {
              const previousDigit = previousDigits[index];
              const changed = transitionFrom !== null && previousDigit !== digit;

              return (
                <span className="focus-setup__number-window" key={index}>
                  {changed && (
                    <span className="focus-setup__digit focus-setup__digit--outgoing">
                      {previousDigit}
                    </span>
                  )}
                  <strong
                    className={`focus-setup__digit focus-setup__digit--current ${
                      changed ? "focus-setup__digit--changing" : ""
                    }`}
                  >
                    {digit}
                  </strong>
                </span>
              );
            })}
          </span>
          <span className="focus-setup__unit">mins</span>
          <span className="sr-only" aria-live="polite">{durationMinutes} mins</span>
        </div>

        <div
          className="focus-ruler"
          role="slider"
          tabIndex={0}
          aria-label="Focus duration in minutes"
          aria-valuemin={MIN_DURATION}
          aria-valuemax={MAX_DURATION}
          aria-valuenow={durationMinutes}
          aria-valuetext={`${durationMinutes} minutes`}
          data-testid="duration-input"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={() => onEngagementChange(false)}
          onFocus={() => onEngagementChange(true)}
          onBlur={() => onEngagementChange(false)}
          onKeyDown={handleKeyDown}
          onWheel={handleWheel}
        >
          <div className="focus-ruler__ticks" aria-hidden="true">
            {DURATION_VALUES.map((value) => {
              const offset = ((value - durationMinutes) / DURATION_STEP) * PIXELS_PER_STEP;
              const isMajor = value % 30 === 0;
              return (
                <span
                  className={`focus-ruler__tick ${isMajor ? "focus-ruler__tick--major" : ""}`}
                  key={value}
                  style={{ left: `calc(50% + ${offset}px)` }}
                >
                  {isMajor && <small>{value}</small>}
                </span>
              );
            })}
          </div>
          <i className="focus-ruler__indicator" aria-hidden="true" />
        </div>

        <button
          className="focus-setup__start"
          type="submit"
          disabled={!taskName.trim()}
          data-testid="start-focus"
        >
          START
        </button>
      </form>
    </section>
  );
}
