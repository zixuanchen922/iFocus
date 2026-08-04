export const IFOCUS_CAMERA_START_EVENT = "ifocus:start-camera";

export function requestCameraStart() {
  window.dispatchEvent(new Event(IFOCUS_CAMERA_START_EVENT));
}
