import { AbsoluteFill, Sequence } from "remotion";
import { DistractionAlert } from "./scenes/DistractionAlert";
import { FocusInteraction } from "./scenes/FocusInteraction";

export const FocusOrbDemo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Sequence name="Focus interaction" durationInFrames={330}>
        <FocusInteraction />
      </Sequence>
      <Sequence name="Distraction alert" from={330} durationInFrames={120}>
        <DistractionAlert />
      </Sequence>
    </AbsoluteFill>
  );
};
