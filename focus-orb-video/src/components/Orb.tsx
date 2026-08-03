import { Interactive } from "remotion";
import { EyeExpression } from "./EyeExpression";

type OrbProps = {
  x: number;
  y: number;
  size: number;
  squashX?: number;
  squashY?: number;
  blink?: number;
  eyeMorph?: number;
  eyeAnchorX?: number;
  eyeScale?: number;
  opacity?: number;
  zIndex?: number;
  glow?: number;
};

export const Orb: React.FC<OrbProps> = ({
  x,
  y,
  size,
  squashX = 1,
  squashY = 1,
  blink = 1,
  eyeMorph = 0,
  eyeAnchorX = 35,
  eyeScale = 1,
  opacity = 1,
  zIndex = 1,
  glow = 1,
}) => {
  return (
    <Interactive.Div
      name="White-ring focus orb"
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 360,
        height: 360,
        marginLeft: -180,
        marginTop: -180,
        translate: `${x}px ${y}px`,
        scale: size,
        opacity,
        zIndex,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          border: "14px solid rgba(255,255,255,0.98)",
          borderRadius: "50%",
          overflow: "hidden",
          background:
            "radial-gradient(circle at 38% 28%, #242424 0%, #0a0a0a 46%, #000 76%)",
          boxShadow: `0 0 ${26 * glow}px rgba(255,255,255,0.48), inset 0 0 24px rgba(255,255,255,0.08)`,
          scale: `${squashX} ${squashY}`,
          transformOrigin: "50% 78%",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 14,
            borderRadius: "50%",
            background:
              "radial-gradient(circle at 36% 22%, rgba(255,255,255,0.12), transparent 32%)",
          }}
        />

        <EyeExpression
          morph={eyeMorph}
          blink={blink}
          anchorX={eyeAnchorX}
          eyeScale={eyeScale}
        />
      </div>
    </Interactive.Div>
  );
};
