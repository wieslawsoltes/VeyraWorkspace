/** Only public, boolean call state belongs in presence. Never spread client payloads. */
export function callState(value = {}) {
  return {muted: value.muted !== false, camera: value.camera === true, hand: value.hand === true, screen: value.screen === true};
}
