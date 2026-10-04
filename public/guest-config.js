/** Public deployment settings, not secrets. Empty uses the current site.
 * For GitHub Pages, set signalingURL to your HTTPS Veyra server and allow the
 * Pages origin in that server's GUEST_ALLOWED_ORIGINS. Direct pairing needs no broker.
 * Never put TURN shared secrets or long-lived privileged credentials here.
 */
export const guestConfig = Object.freeze({signalingURL: '', directIceServers: []});
