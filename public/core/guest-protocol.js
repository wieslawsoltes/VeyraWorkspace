/** Shared, dependency-free guest meeting validation. Never trust peer-supplied identity. */
export const MAX_GUEST_PEERS = 8;
export const MAX_CHAT_LENGTH = 2000;
export const REACTIONS = Object.freeze(['👍', '👏', '❤️', '😂', '🎉']);
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export function fault(message, status = 400) { return Object.assign(new Error(message), {status}); }
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('A JSON object is required.');
  return value;
}
export function text(value, max, label = 'Text') {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
    throw fault(`${label} must contain 1–${max} characters.`);
  return value.trim();
}
export function mediaState(value = {}) {
  return Object.fromEntries(['audio', 'video', 'screen', 'screenAudio', 'hand'].map(key => [key, value[key] === true]));
}
export function rtcSignal(value) {
  object(value);
  if (value.description) {
    const d = object(value.description);
    if (!['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string' || d.sdp.length > 70000 || !d.sdp.startsWith('v=0'))
      throw fault('Invalid session description.');
    return {description: {type: d.type, sdp: d.sdp}};
  }
  if (value.candidate) {
    const c = object(value.candidate);
    if (typeof c.candidate !== 'string' || c.candidate.length > 4000 ||
        (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 32)) ||
        (c.sdpMLineIndex != null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 8)))
      throw fault('Invalid ICE candidate.');
    return {candidate: {candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null}};
  }
  throw fault('A session description or ICE candidate is required.');
}
export function iceConfiguration(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw fault('ICE configuration must be an array of at most eight servers.');
  return value.map(server => {
    object(server);
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8 || urls.some(url => typeof url !== 'string' || url.length > 500 || !/^(stun|stuns|turn|turns):[^\s/@]+(?::\d+)?(?:\?transport=(udp|tcp))?$/i.test(url)))
      throw fault('Only explicit STUN/TURN URLs are supported.');
    const result = {urls};
    for (const key of ['username', 'credential']) if (server[key] !== undefined) {
      if (typeof server[key] !== 'string' || server[key].length > 512) throw fault('Invalid ICE credential.');
      result[key] = server[key];
    }
    return result;
  });
}
export function meetingURL(base, roomId, inviteKey, server = '') {
  if (!ID_PATTERN.test(roomId) || !TOKEN_PATTERN.test(inviteKey)) throw fault('Invalid invitation.');
  const url = new URL(base); url.search = ''; url.hash = new URLSearchParams({room: roomId, key: inviteKey, ...(server ? {server} : {})}).toString();
  return url.href;
}
export function parseInvitation(value, base) {
  const url = new URL(value, base), params = new URLSearchParams(url.hash.slice(1));
  const roomId = params.get('room'), inviteKey = params.get('key');
  if (!ID_PATTERN.test(roomId || '') || !TOKEN_PATTERN.test(inviteKey || '')) throw fault('Paste a complete Veyra meeting invitation.');
  const server = params.get('server') || '';
  if (server) serverURL(server, base);
  return {roomId, inviteKey, server};
}
export function serverURL(value, base) {
  const url = new URL(value || './', base);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw fault('Use an HTTPS signaling server, or localhost for development.');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}
