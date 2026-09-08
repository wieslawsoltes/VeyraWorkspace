/** Domain invariants, shared by browser and server. No DOM dependency. */
export const VERSION = 1;
export const MAX_MESSAGE_LENGTH = 12000;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_CALL_PEERS = 8;
export const uid = () => crypto.randomUUID();
export const clone = value => structuredClone(value);
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function error(message, status = 400) { return Object.assign(new Error(message), {status}); }
export function identifier(value, name = 'Identifier') {
  if (typeof value !== 'string' || !/^[\w.:@-]{1,512}$/.test(value)) throw error(`${name} is invalid.`);
  return value;
}
export function validText(value, name = 'Text', max = MAX_MESSAGE_LENGTH) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw error(`${name} must contain 1–${max} characters.`);
  return value.trim();
}
export function validateMessage(input) {
  if (!input || typeof input !== 'object') throw error('A message object is required.');
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const files = input.attachments ?? [];
  if (!Array.isArray(files) || files.length > 8 || files.some(f => !f || typeof f !== 'object' || typeof f.id !== 'string')) throw error('Attach up to eight valid files.');
  if ((!content && !files.length) || content.length > MAX_MESSAGE_LENGTH) throw error(`Enter a message up to ${MAX_MESSAGE_LENGTH} characters, or attach a file.`);
  return {id: identifier(input.id || uid()), roomId: identifier(input.roomId, 'Conversation'), content,
    replyTo: input.replyTo ? identifier(input.replyTo) : null, attachments: files.map(f => ({...f, id: identifier(f.id)}))};
}
export function groupReactions(reactions = []) {
  const groups = new Map();
  for (const r of reactions) { const set = groups.get(r.emoji) || new Set(); set.add(r.userId); groups.set(r.emoji, set); }
  return [...groups].map(([emoji, set]) => ({emoji, users: [...set], count: set.size}));
}
export function toggleReaction(message, emoji, userId) {
  if (!message || message.deleted) throw error('This message is unavailable.', 409);
  if (typeof emoji !== 'string' || !emoji.trim() || emoji.length > 24 || /[<>\u0000-\u001f]/.test(emoji)) throw error('Invalid reaction.');
  const reactions = message.reactions || [], exists = reactions.some(r => r.emoji === emoji && r.userId === userId);
  return {...message, reactions: exists ? reactions.filter(r => !(r.emoji === emoji && r.userId === userId)) : [...reactions, {emoji, userId}]};
}
export function safeURL(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function normalizeEvent(input) {
  const start = new Date(input.start), end = new Date(input.end);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || +end <= +start) throw error('The meeting must end after it starts.');
  if (+end - +start > 31 * 86400000) throw error('Meetings are limited to 31 days.');
  return {id: input.id ? identifier(input.id) : uid(), title: validText(input.title, 'Title', 160),
    start: start.toISOString(), end: end.toISOString(), roomId: input.roomId ? identifier(input.roomId) : null,
    description: String(input.description || '').slice(0, 4000), joinUrl: safeURL(input.joinUrl)};
}
export function validateShape(shape) {
  if (!shape || !['pen', 'rect', 'ellipse', 'note', 'arrow'].includes(shape.type)) throw error('Invalid whiteboard shape.');
  identifier(shape.id);
  for (const key of ['x','y','w','h']) if (!Number.isFinite(shape[key]) || Math.abs(shape[key]) > 1e7) throw error('Invalid whiteboard geometry.');
  if (!/^#[\da-f]{6}$/i.test(shape.color)) throw error('Invalid drawing color.');
  if (shape.text !== undefined && (typeof shape.text !== 'string' || shape.text.length > 1000)) throw error('A note may contain at most 1,000 characters.');
  if (shape.points !== undefined && (!Array.isArray(shape.points) || shape.points.length > 10000 || shape.points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n) || Math.abs(n) > 1e7)))) throw error('Invalid pen stroke.');
  return clone(shape);
}
export function validateDocument(kind, input) {
  if (!Number.isSafeInteger(input.version) || input.version < 0) throw error('A valid revision number is required.');
  if (kind === 'notes') {
    if (typeof input.text !== 'string' || input.text.length > 100000) throw error('Notes are limited to 100,000 characters.');
    return {text: input.text};
  }
  if (kind !== 'board' || !Array.isArray(input.shapes) || input.shapes.length > 3000) throw error('Whiteboards are limited to 3,000 shapes.');
  return {shapes: input.shapes.map(validateShape)};
}
export function initials(name = '?') { return name.trim().split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase(); }
export function fileSize(bytes = 0) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round(bytes / 1024))} KB`; }
export function relativeTime(value) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) : date.toLocaleDateString([], {month:'short', day:'numeric'});
}
export function markdown(text) {
  // Escape first. Provider-supplied HTML is never injected into the document.
  return escapeHTML(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)@([\w.-]+)/g, '$1<span class="mention">@$2</span>').replace(/\n/g, '<br>');
}
export function messageFingerprint(input) {
  // Metadata and timestamps are not part of the idempotency identity; stable attachment IDs are.
  return JSON.stringify([input.roomId, input.content, input.replyTo || null, input.attachments.map(a => a.id)]);
}
