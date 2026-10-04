import {serverURL, fault} from './guest-protocol.js';

/** Header-authenticated SSE over fetch: guest capabilities never enter query strings,
 * cookies, localStorage, referrers, or access logs. Writes are never retried implicitly.
 */
export class GuestTransport extends EventTarget {
  constructor(server = '', {base = globalThis.location?.href, fetch = globalThis.fetch} = {}) {
    super(); this.base = serverURL(server, base); this.endpoint = new URL('api/guest-meetings', this.base);
    this.fetch = fetch; this.abort = new AbortController(); this.closed = false; this.connected = false;
  }
  emit(type, detail) {if (!this.closed) this.dispatchEvent(new CustomEvent(type, {detail}));}
  async request(path = '', {method = 'GET', body, authorization, keepalive = false} = {}) {
    const abort = new AbortController(), relay = () => abort.abort();
    this.abort.signal.addEventListener('abort', relay, {once: true});
    const timer = setTimeout(relay, 15000);
    try {
      if (this.closed) throw fault('This meeting session has ended.');
      const headers = {Accept: 'application/json'};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (authorization || this.session) headers.Authorization = authorization || `Bearer ${this.session.participantToken}`;
      const response = await this.fetch(this.endpoint.href + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: abort.signal, keepalive});
      const data = await response.json().catch(() => ({error: 'No guest-meeting server is available here. Use a configured server or Direct pairing.'}));
      if (!response.ok) throw fault(data.error || 'Meeting request failed.', response.status);
      return data;
    } finally {clearTimeout(timer); this.abort.signal.removeEventListener('abort', relay);}
  }
  async create(name, title, waitingRoom = true) {this.session = await this.request('', {method: 'POST', body: {name, title, waitingRoom}}); return this.session;}
  async join(roomId, inviteKey, name) {
    this.session = await this.request(`/${roomId}/join`, {method: 'POST', authorization: `Invite ${inviteKey}`, body: {name}}); return this.session;
  }
  path(action) {if (!this.session) throw fault('Join a meeting first.'); return `/${this.session.roomId}/${action}`;}
  ice() {return this.request(this.path('ice'));}
  presence(state) {return this.request(this.path('presence'), {method: 'POST', body: state});}
  signal(target, payload) {return this.request(this.path('signal'), {method: 'POST', body: {target, ...payload}});}
  control(action, options = {}) {return this.request(this.path('control'), {method: 'POST', body: {action, ...options}});}
  start() {if (!this.running && !this.closed) this.running = this.run(); return this.running;}
  async run() {
    let failures = 0;
    while (!this.closed) {
      try {
        const response = await this.fetch(this.endpoint.href + this.path('events'), {headers: {Authorization: `Bearer ${this.session.participantToken}`, Accept: 'text/event-stream'},
          credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: this.abort.signal});
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
          const data = await response.json().catch(() => ({})); throw fault(data.error || 'Signaling is unavailable.', response.status || 502);
        }
        if (!response.body) throw fault('Streaming connections are unsupported in this browser.');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        try {
          while (!this.closed) {
            const {value, done} = await reader.read(); if (done) break;
            buffer = (buffer + decoder.decode(value, {stream: true})).replace(/\r\n/g, '\n');
            if (buffer.length > 160000) throw fault('Signaling frame is too large.');
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (!data) continue;
              const event = JSON.parse(data);
              if (event.type === 'ready') {failures = 0; this.connected = true; this.emit('connection', {connected: true});}
              this.emit('event', event);
              if (['ended', 'expired', 'removed', 'left'].includes(event.type)) {this.close(false); break;}
            }
          }
        } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
      } catch (error) {
        if (this.closed) return;
        if ([401, 403, 404].includes(error.status)) {this.emit('event', {type: 'expired', message: error.message}); this.close(false); return;}
        this.emit('error', {message: error.message});
      }
      if (this.closed) return;
      this.connected = false; this.emit('connection', {connected: false});
      const delay = Math.min(8000, 500 * 2 ** Math.min(failures++, 4));
      await new Promise(resolve => {
        const finish = () => {clearTimeout(timer); this.abort.signal.removeEventListener('abort', finish); resolve();};
        const timer = setTimeout(finish, delay); this.abort.signal.addEventListener('abort', finish, {once: true});
      });
    }
  }
  close(notify = true) {
    if (this.closed) return;
    this.closed = true; this.connected = false; this.abort.abort();
    if (notify && this.session) this.fetch(this.endpoint.href + this.path('leave'), {method: 'POST',
      headers: {Authorization: `Bearer ${this.session.participantToken}`, 'Content-Type': 'application/json'}, body: '{}',
      credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true, signal: AbortSignal.timeout(3000)}).catch(() => {});
    this.session = null;
  }
}
