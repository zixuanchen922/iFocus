import "./index.css";
import { Composition, Folder } from "remotion";
import { DistractionAlert } from "./scenes/DistractionAlert";
import { FocusInteraction } from "./scenes/FocusInteraction";
import { FocusOrbDemo } from "./FocusOrbDemo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Folder name="Focus-Orb-Demo">
        <Composition
          id="FocusInteraction"
          component={FocusInteraction}
          durationInFrames={330}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="DistractionAlert"
          component={DistractionAlert}
          durationInFrames={120}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="FocusOrbDemo"
          component={FocusOrbDemo}
          durationInFrames={450}
          fps={30}
          width={1920}
          height={1080}
        />
      </Folder>
    </>
  );
};
