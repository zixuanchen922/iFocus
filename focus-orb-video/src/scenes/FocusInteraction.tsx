import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { FocusTimer } from "../components/FocusTimer";
import { Orb } from "../components/Orb";

const blinkAt = (frame: number, center: number) =>
  interpolate(frame, [center - 4, center, center + 4], [1, 0.05, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

export const FocusInteraction: React.FC = () => {
  const frame = useCurrentFrame();

  const jumpProgress = interpolate(frame, [100, 154], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.28, 0, 0.26, 1),
  });
  const jumpY =
    140 - 3200 * jumpProgress * (1 - jumpProgress) + 40 * jumpProgress;

  const isPeek = frame < 100;
  const isAirborne = frame >= 100 && frame < 154;
  const isLanding = frame >= 154 && frame < 185;
  const isExiting = frame >= 185;

  const movingOrbX = isPeek
    ? -400
    : interpolate(frame, [100, 132, 154, 185, 205], [-400, -390, -360, -360, -1250], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.bezier(0.22, 0.8, 0.2, 1),
      });
  const movingOrbY = isPeek
    ? 140
    : isAirborne
      ? jumpY
      : isLanding
        ? interpolate(frame, [154, 161, 169, 178, 185], [180, 210, 150, 190, 180], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        : interpolate(frame, [185, 205], [180, 320], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.4, 0, 1, 1),
          });
  const movingOrbSize = interpolate(
    frame,
    [30, 100, 154, 185, 205],
    [0.64, 0.64, 1.05, 1.05, 0.78],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.2, 0.75, 0.2, 1),
    },
  );

  const closeProgress = interpolate(frame, [220, 252], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const closeBlink = Math.min(blinkAt(frame, 268), blinkAt(frame, 294));
  const timerOffsetX = interpolate(frame, [205, 252], [0, 300], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <Interactive.Div
        name="Start focus button"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 310,
          height: 96,
          marginLeft: -155,
          marginTop: -48,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "2px solid rgba(255,255,255,0.7)",
          borderRadius: 999,
          color: "#fff",
          background: "rgba(255,255,255,0.06)",
          boxShadow: "0 0 30px rgba(255,255,255,0.12)",
          fontSize: 36,
          fontWeight: 600,
          letterSpacing: "0.08em",
          opacity: interpolate(frame, [0, 22, 31], [1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          scale: interpolate(
            frame,
            [0, 13, 17, 22, 31],
            [1, 1, 0.94, 1.03, 0.78],
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.2, 0.8, 0.2, 1),
            },
          ),
          zIndex: 8,
        }}
      >
        开始专注
      </Interactive.Div>

      <Interactive.Div
        name="Tap ripple"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 112,
          height: 112,
          marginLeft: -56,
          marginTop: -56,
          border: "4px solid rgba(255,255,255,0.9)",
          borderRadius: "50%",
          opacity: interpolate(frame, [12, 16, 28], [0, 0.85, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          scale: interpolate(frame, [12, 28], [0.2, 2.8], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          zIndex: 9,
        }}
      />

      {frame >= 30 && frame < 208 ? (
        <Orb
          x={movingOrbX}
          y={movingOrbY}
          size={movingOrbSize}
          squashX={interpolate(
            frame,
            [150, 158, 166, 176, 185],
            [1, 1.24, 0.92, 1.05, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )}
          squashY={interpolate(
            frame,
            [150, 158, 166, 176, 185],
            [1, 0.76, 1.12, 0.96, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )}
          blink={Math.min(blinkAt(frame, 64), blinkAt(frame, 88))}
          eyeAnchorX={isPeek ? 25 : 35}
          zIndex={frame < 104 ? 1 : 3}
          glow={1}
          opacity={isExiting ? interpolate(frame, [196, 207], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }) : 1}
        />
      ) : null}

      {frame >= 220 ? (
        <Orb
          x={interpolate(closeProgress, [0, 1], [-1180, -730])}
          y={interpolate(closeProgress, [0, 1], [-900, -400])}
          size={interpolate(closeProgress, [0, 1], [2.75, 3.25])}
          blink={closeBlink}
          eyeAnchorX={58}
          eyeScale={0.68}
          zIndex={3}
          glow={1.2}
          opacity={interpolate(frame, [220, 226], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        />
      ) : null}

      <FocusTimer frame={frame} offsetX={timerOffsetX} />
    </AbsoluteFill>
  );
};
