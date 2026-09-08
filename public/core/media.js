/** Permission-aware capture. A controller owns its tracks from preview until hang-up.
 * No permission is requested by construction, enumeration, or permission diagnostics.
 * getUserMedia starts synchronously in request(), before any asynchronous work.
 */
const KINDS = ['audio', 'video'];
const label = kind => kind === 'video' ? 'Camera' : 'Microphone';
const stop = stream => stream?.getTracks().forEach(track => track.stop());
const cancelled = () => new DOMException('Device request cancelled.', 'AbortError');

export function mediaIssue(cause, kind, {secure = globalThis.isSecureContext, document = globalThis.document} = {}) {
  const name = cause?.name || 'Error', device = label(kind);
  let code = name, title = `${device} could not start`, detail;
  const policy = document?.permissionsPolicy || document?.featurePolicy;
  let policyBlocked = false;
  try { policyBlocked = policy?.allowsFeature?.(kind === 'video' ? 'camera' : 'microphone') === false; } catch {}
  if (secure === false) {
    code = 'insecure-context'; title = 'A secure connection is required';
    detail = 'Open Veyra over HTTPS, or use localhost on the same computer. An HTTP address on your local network cannot capture devices.';
  } else if (policyBlocked) {
    code = 'permissions-policy'; title = `${device} is blocked by this page’s policy`;
    detail = 'Open Veyra directly in a browser tab. Embedded deployments must explicitly allow camera and microphone in their Permissions-Policy and iframe permissions.';
  } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    title = `${device} access is blocked`;
    detail = 'The browser, operating system, or site permissions refused access. Allow this device for your browser and this site, then select Retry. Veyra cannot override that decision. You can keep using the other device or join without media.';
  } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    title = `No ${device.toLowerCase()} is available`;
    detail = 'Connect or enable a device, select Automatic in the device list, then retry. You can join without this device.';
  } else if (name === 'NotReadableError' || name === 'TrackStartError') {
    title = `${device} is busy or unavailable`;
    detail = 'Another app, tab, or operating-system restriction may be using the device. Close other capture sessions, check device settings, then retry.';
  } else if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    title = `${device} selection is unavailable`;
    detail = 'The chosen device or settings are no longer available. Select Automatic or another device, then retry.';
  } else if (name === 'InvalidStateError') {
    title = 'Bring this tab to the foreground'; detail = 'Keep Veyra visible and active while granting device access, then retry.';
  } else if (name === 'NotSupportedError') {
    title = `${device} capture is not supported here`; detail = 'Open the HTTPS app in a browser that supports media capture. Receive-only calls do not need camera or microphone access.';
  } else if (name === 'AbortError') {
    title = `${device} start was interrupted`; detail = 'The browser interrupted device startup. Keep this tab active and retry when ready.';
  } else {
    detail = 'Check browser and operating-system device access, then retry. You can join without this device.';
  }
  return {kind, code, name, title, detail};
}

export class MediaAccessError extends Error {
  constructor(issues) {
    super(issues.map(issue => issue.title).join('. '));
    this.name = 'MediaAccessError'; this.issues = issues;
  }
}

export class MediaController extends EventTarget {
  constructor({mediaDevices = globalThis.navigator?.mediaDevices, Stream = globalThis.MediaStream,
    secure = globalThis.isSecureContext, document = globalThis.document} = {}) {
    super();
    this.devicesAPI = mediaDevices; this.Stream = Stream; this.context = {secure, document};
    this.stream = Stream ? new Stream() : null; this.closed = false;
    this.preferences = {audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}, video: {facingMode: 'user'}};
    this.devices = []; this.pending = {}; this.versions = {audio: 0, video: 0}; this.handlers = new Map();
    this.status = {audio: 'off', video: 'off'}; this.issues = {audio: null, video: null}; this.deviceRevision = 0;
    this.deviceChanged = () => {clearTimeout(this.deviceTimer); this.deviceTimer = setTimeout(() => this.refreshDevices(), 150);};
    this.devicesAPI?.addEventListener?.('devicechange', this.deviceChanged);
  }
  track(kind) {return this.stream?.getTracks().find(t => t.kind === kind && t.readyState === 'live') || null;}
  snapshot() {
    return Object.fromEntries(KINDS.map(kind => [kind, {status: this.status[kind], issue: this.issues[kind],
      busy: !!this.pending[kind], enabled: !!this.track(kind)?.enabled,
      interrupted: !!this.track(kind)?.muted, capturing: !!this.track(kind)}]));
  }
  changed() {if (!this.closed) this.dispatchEvent(new CustomEvent('change', {detail: this.snapshot()}));}
  preflight(kind) {
    const policy = this.context.document?.permissionsPolicy || this.context.document?.featurePolicy;
    let blocked = false;
    try {blocked = policy?.allowsFeature?.(kind === 'video' ? 'camera' : 'microphone') === false;} catch {}
    if (this.context.secure === false || blocked) throw new DOMException('Capture is not allowed in this context.', 'NotAllowedError');
    if (!this.devicesAPI?.getUserMedia || !this.stream) throw new DOMException('Capture is unavailable.', 'NotSupportedError');
  }
  constraints(kind, simple = false) {
    if (simple) return {audio: kind === 'audio', video: kind === 'video'};
    const pref = this.preferences[kind], value = kind === 'audio'
      ? {echoCancellation: pref.echoCancellation, noiseSuppression: pref.noiseSuppression, autoGainControl: pref.autoGainControl}
      : {width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 24, max: 30}, facingMode: {ideal: pref.facingMode}};
    if (pref.deviceId) value.deviceId = {exact: pref.deviceId};
    return {audio: kind === 'audio' ? value : false, video: kind === 'video' ? value : false};
  }
  request(kind, {force = false} = {}) {
    if (!KINDS.includes(kind)) return Promise.reject(new TypeError('Expected audio or video.'));
    if (this.closed) return Promise.reject(cancelled());
    if (this.pending[kind]) return this.pending[kind];
    if (!force && this.track(kind)?.enabled && !this.track(kind)?.muted) return Promise.resolve(this.track(kind));
    const revision = ++this.versions[kind];
    // iOS may support only one active camera. Release the old camera before switching.
    if (kind === 'video') this.removeTracks(kind);
    this.status[kind] = 'requesting'; this.issues[kind] = null;
    let capture;
    try {this.preflight(kind); capture = this.devicesAPI.getUserMedia(this.constraints(kind));}
    catch (cause) {capture = Promise.reject(cause);}
    const current = () => !this.closed && revision === this.versions[kind];
    const work = Promise.resolve(capture).catch(cause => {
      // Relax device-independent constraints once; NEVER retry a permission denial.
      if (current() && cause.name === 'OverconstrainedError' && !this.preferences[kind].deviceId)
        return this.devicesAPI.getUserMedia(this.constraints(kind, true));
      throw cause;
    }).then(stream => {
      if (!current()) {stop(stream); throw cancelled();}
      const track = stream.getTracks().find(t => t.kind === kind && t.readyState === 'live');
      if (!track) {stop(stream); throw new DOMException('No live device track was returned.', 'NotFoundError');}
      stream.getTracks().filter(t => t !== track).forEach(t => t.stop());
      this.removeTracks(kind); this.stream.addTrack(track); track.enabled = true;
      const ended = () => {
        if (this.track(kind) && this.track(kind) !== track) return;
        this.unwatch(track); this.stream.removeTrack(track); this.status[kind] = 'ended';
        this.issues[kind] = {kind, code: 'track-ended', title: `${label(kind)} stopped`, detail: 'The device was disconnected or access was revoked. Reconnect or allow the device, then select Retry.'};
        this.changed();
      };
      const muted = () => {if (this.track(kind) === track) {this.status[kind] = 'interrupted'; this.changed();}};
      const unmuted = () => {if (this.track(kind) === track) {this.status[kind] = 'ready'; this.issues[kind] = null; this.changed();}};
      this.handlers.set(track, {ended, mute: muted, unmute: unmuted});
      for (const [name, handler] of Object.entries(this.handlers.get(track))) track.addEventListener(name, handler);
      this.status[kind] = track.muted ? 'interrupted' : 'ready'; this.refreshDevices();
      return track;
    }).catch(cause => {
      if (current()) {this.issues[kind] = mediaIssue(cause, kind, this.context); this.status[kind] = 'error';}
      throw cause;
    }).finally(() => {
      if (this.pending[kind] === work) delete this.pending[kind];
      if (current()) this.changed();
    });
    this.pending[kind] = work; this.changed(); return work;
  }
  prepare({audio = false, video = false} = {}) {
    const requests = [];
    // Separate requests preserve a working microphone when the camera is denied (and vice versa).
    // Both are issued in the caller's click stack, not after enumeration/permission awaits.
    for (const [kind, enabled] of Object.entries({audio, video})) {
      if (!enabled) this.release(kind);
      else requests.push(this.request(kind).then(() => null, cause => {
        if (this.closed) throw cancelled();
        return this.issues[kind] || mediaIssue(cause, kind, this.context);
      }));
    }
    return Promise.all(requests).then(issues => {
      if (this.closed) throw cancelled();
      const failures = issues.filter(Boolean); if (failures.length) throw new MediaAccessError(failures);
      return this.stream;
    });
  }
  unwatch(track) {
    for (const [name, handler] of Object.entries(this.handlers.get(track) || {})) track.removeEventListener(name, handler);
    this.handlers.delete(track);
  }
  removeTracks(kind) {
    for (const track of this.stream?.getTracks().filter(t => t.kind === kind) || []) {
      this.unwatch(track); this.stream.removeTrack(track); track.stop();
    }
  }
  release(kind) {
    ++this.versions[kind]; delete this.pending[kind]; this.removeTracks(kind);
    this.status[kind] = 'off'; this.issues[kind] = null; this.changed();
  }
  select(kind, deviceId = '') {
    this.preferences[kind].deviceId = String(deviceId);
    if (!this.track(kind)) {this.changed(); return Promise.resolve();}
    return this.request(kind, {force: true});
  }
  flipCamera() {
    const prefs = this.preferences.video, activeFacing = this.track('video')?.getSettings?.()?.facingMode;
    const facing = ['user', 'environment'].includes(activeFacing) ? activeFacing : prefs.facingMode;
    prefs.deviceId = ''; prefs.facingMode = facing === 'environment' ? 'user' : 'environment';
    return this.request('video', {force: true});
  }
  async refreshDevices() {
    const revision = ++this.deviceRevision;
    try {
      const devices = await this.devicesAPI?.enumerateDevices?.();
      if (this.closed || revision !== this.deviceRevision) return;
      this.devices = Array.from(devices || []).filter(d => ['audioinput', 'videoinput', 'audiooutput'].includes(d.kind));
      this.dispatchEvent(new CustomEvent('devices', {detail: this.devices}));
    } catch { /* Enumeration is optional and never gates permission requests. */ }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.deviceTimer);
    this.devicesAPI?.removeEventListener?.('devicechange', this.deviceChanged);
    for (const kind of KINDS) this.release(kind);
  }
}

/** No connection to the destination: the microphone test never feeds back to speakers. */
export class MicrophoneMeter {
  constructor(onLevel, {Context = globalThis.AudioContext || globalThis.webkitAudioContext, Stream = globalThis.MediaStream} = {}) {
    this.onLevel = onLevel; this.Context = Context; this.Stream = Stream; this.track = null;
  }
  unlock() {
    try {this.context ||= this.Context ? new this.Context() : null; this.context?.resume().catch(() => {}); if (this.track && !this.source) this.attach(this.track);} catch {}
  }
  attach(track) {
    if (track === this.track && (!track || this.source)) return;
    this.disconnect(); this.track = track;
    if (!track || !this.context || this.context.state === 'closed') return;
    try {
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 512;
      this.source = this.context.createMediaStreamSource(new this.Stream([track])); this.source.connect(this.analyser);
      const samples = new Float32Array(this.analyser.fftSize);
      this.timer = setInterval(() => {
        this.analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
        this.onLevel(track.enabled && !track.muted ? Math.min(1, rms * 4) : 0);
      }, 100);
    } catch {this.disconnect();}
  }
  disconnect() {clearInterval(this.timer); this.source?.disconnect(); this.analyser?.disconnect(); this.source = null; this.analyser = null; this.track = null; this.onLevel(0);}
  dispose() {this.disconnect(); this.context?.close().catch(() => {}); this.context = null;}
}

export function recordingOptions(Recorder, hasVideo) {
  const types = hasVideo ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const mimeType = types.find(type => Recorder.isTypeSupported(type)); return mimeType ? {mimeType} : undefined;
}
export function recordingExtension(mime) {return /mp4/i.test(mime) ? (/^audio\//i.test(mime) ? 'm4a' : 'mp4') : /ogg/i.test(mime) ? 'ogg' : 'webm';}
