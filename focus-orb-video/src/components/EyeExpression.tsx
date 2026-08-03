import { interpolate, interpolateColors } from "remotion";

type EyeExpressionProps = {
  morph: number;
  blink: number;
  anchorX: number;
  eyeScale?: number;
};

const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

const leftEyePath = (morph: number) => `
  M ${mix(83, 14, morph)} ${mix(14, 18, morph)}
  C ${mix(93, 24, morph)} ${mix(14, 12, morph)},
    ${mix(101, 40, morph)} ${mix(37, 20, morph)},
    ${mix(101, 106, morph)} ${mix(65, 54, morph)}
  C ${mix(101, 108, morph)} ${mix(93, 70, morph)},
    ${mix(93, 104, morph)} ${mix(116, 92, morph)},
    ${mix(83, 98, morph)} ${mix(116, 102, morph)}
  C ${mix(73, 84, morph)} ${mix(116, 110, morph)},
    ${mix(65, 38, morph)} ${mix(104, 104, morph)},
    ${mix(65, 22, morph)} ${mix(65, 88, morph)}
  C ${mix(65, 16, morph)} ${mix(37, 72, morph)},
    ${mix(73, 10, morph)} ${mix(14, 30, morph)},
    ${mix(83, 14, morph)} ${mix(14, 18, morph)}
  Z
`;

export const EyeExpression: React.FC<EyeExpressionProps> = ({
  morph,
  blink,
  anchorX,
  eyeScale = 1,
}) => {
  const fill = interpolateColors(morph, [0, 1], ["#ffffff", "#ffdc19"]);
  const glow = interpolateColors(
    morph,
    [0, 1],
    ["rgba(210,235,255,0.92)", "rgba(255,160,0,0.96)"],
  );

  return (
    <div
      style={{
        position: "absolute",
        left: `${interpolate(morph, [0, 1], [anchorX, 50])}%`,
        top: `${interpolate(morph, [0, 1], [45, 47])}%`,
        width: 220,
        height: 110,
        translate: "-50% -50%",
        scale: `${eyeScale} ${eyeScale * blink}`,
        filter: `drop-shadow(0 0 ${interpolate(morph, [0, 1], [11, 18])}px ${glow})`,
      }}
    >
      <svg width="220" height="110" viewBox="0 0 260 130">
        <path d={leftEyePath(morph)} fill={fill} />
        <g transform="translate(260 0) scale(-1 1)">
          <path d={leftEyePath(morph)} fill={fill} />
        </g>
      </svg>
    </div>
  );
};
