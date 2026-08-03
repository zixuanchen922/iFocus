import { Easing, Interactive, interpolate } from "remotion";

type FocusTimerProps = {
  frame: number;
  offsetX?: number;
};

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
};

export const FocusTimer: React.FC<FocusTimerProps> = ({ frame, offsetX = 0 }) => {
  const elapsedSeconds = Math.max(0, Math.floor((frame - 28) / 30));
  const remainingSeconds = Math.max(0, 25 * 60 - elapsedSeconds);
  const progress = remainingSeconds / (25 * 60);
  const circumference = 2 * Math.PI * 382;

  return (
    <Interactive.Div
      name="Countdown ring"
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 900,
        height: 900,
        marginLeft: -450,
        marginTop: -450,
        translate: `${offsetX}px 0px`,
        opacity: interpolate(frame, [18, 34], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
        scale: interpolate(frame, [18, 42], [0.72, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
        zIndex: 2,
      }}
    >
      <svg width="900" height="900" viewBox="0 0 900 900">
        <defs>
          <filter id="timer-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="7" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle cx="450" cy="450" r="432" fill="#000" />
        <circle
          cx="450"
          cy="450"
          r="382"
          fill="none"
          stroke="rgba(255,255,255,0.22)"
          strokeWidth="14"
        />
        <circle
          cx="450"
          cy="450"
          r="382"
          fill="none"
          stroke="#fff"
          strokeWidth="30"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          transform="rotate(-90 450 450)"
          filter="url(#timer-glow)"
        />
      </svg>
      <Interactive.Div
        name="Time remaining"
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontSize: 106,
          fontWeight: 560,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.045em",
          textShadow: "0 0 22px rgba(255,255,255,0.36)",
        }}
      >
        {formatTime(remainingSeconds)}
      </Interactive.Div>
    </Interactive.Div>
  );
};
