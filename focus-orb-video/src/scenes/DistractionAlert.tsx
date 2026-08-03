import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { Orb } from "../components/Orb";

export const DistractionAlert: React.FC = () => {
  const frame = useCurrentFrame();
  const eyeMorph = interpolate(frame, [20, 74], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.3, 0, 0.2, 1),
  });
  const eyeScale = interpolate(frame, [0, 90], [1, 0.78], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <Orb
        x={interpolate(frame, [0, 28, 62, 90], [0, -18, -8, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.2, 0.74, 0.12, 1),
        })}
        y={interpolate(frame, [0, 28, 62, 90], [220, 190, 140, 80], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.2, 0.74, 0.12, 1),
        })}
        size={interpolate(
          frame,
          [0, 24, 56, 88, 120],
          [2.65, 3.05, 4.1, 6.9, 6.9],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.2, 0.74, 0.12, 1),
          },
        )}
        squashX={interpolate(frame, [0, 58, 74, 92], [1, 1, 1.025, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })}
        squashY={interpolate(frame, [0, 58, 74, 92], [1, 1, 0.985, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })}
        eyeMorph={eyeMorph}
        eyeAnchorX={35}
        eyeScale={eyeScale}
        glow={interpolate(frame, [0, 88], [1, 1.45], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })}
        zIndex={2}
      />
    </AbsoluteFill>
  );
};
