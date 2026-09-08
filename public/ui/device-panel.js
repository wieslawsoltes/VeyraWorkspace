import {escapeHTML as E} from '../core/model.js';
import {MediaAccessError, MicrophoneMeter, mediaIssue} from '../core/media.js';

/** Shared preflight/in-call device UI. The owner, not the panel, owns media tracks. */
export class DevicePanel {
  constructor(root, media, {call = null, onIntent = () => {}} = {}) {
    this.root = root; this.media = media; this.call = call; this.onIntent = onIntent; this.closed = false;
    this.abort = new AbortController(); const signal = this.abort.signal;
    root.classList.add('device-panel');
    root.innerHTML = `<div class="device-preview"><video data-device-preview autoplay playsinline muted></video><span data-preview-placeholder>Camera is off. Devices start only when you choose Test, Enable, or Join.</span><button type="button" class="button small" data-device-command="play" hidden>Play preview</button></div>
      <div class="device-level"><span>Microphone level</span><meter data-input-level min="0" max="1" value="0" aria-label="Microphone input level"></meter></div>
      <div class="device-options">${['audio', 'video'].map(kind => `<section data-device-kind="${kind}"><div class="row between"><strong>${kind === 'audio' ? 'Microphone' : 'Camera'}</strong><span data-device-status="${kind}" role="status">Not started</span></div><select data-device-select="${kind}" aria-label="${kind === 'audio' ? 'Microphone' : 'Camera'} device"><option value="">Automatic</option></select><div class="row"><button type="button" class="button small" data-device-command="${kind}">Enable ${kind === 'audio' ? 'microphone' : 'camera'}</button>${kind === 'video' ? '<button type="button" class="button small" data-device-command="flip">Flip camera</button>' : ''}</div></section>`).join('')}</div>
      <div class="device-tools"><button type="button" class="button small" data-device-command="test">Test selected devices</button><button type="button" class="button small" data-device-command="stop">Turn both off</button><button type="button" class="button small" data-device-command="refresh">Refresh devices</button></div>
      <div data-device-errors role="alert"></div><p class="device-notice">Preview is local and muted. No test media is uploaded. Turning a device off releases it; cancelling closes all preview tracks.</p>
      <details class="device-help"><summary>Camera or microphone blocked?</summary><p>Allow camera and microphone in this site’s browser permissions and in your operating-system settings, then select Retry for the device. Veyra cannot change these permissions for you.</p><p>On iPhone or iPad: check Settings → Privacy &amp; Security → Camera and Microphone for your browser. For Chrome, check Chrome’s site permissions as well. For Safari, check the website’s camera and microphone settings. Keep this tab visible while starting capture.</p><p>Open Veyra directly over HTTPS, not inside an embedded preview. Close other camera sessions when a device is busy. Microphone-only, camera-only, and receive-only calls are supported.</p></details>`;
    this.video = root.querySelector('video'); this.video.muted = true; this.video.defaultMuted = true; this.video.playsInline = true;
    this.meter = new MicrophoneMeter(level => {const meter = root.querySelector('meter'); if (meter) meter.value = level;});
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-device-command]'); if (!button || button.disabled) return;
      event.preventDefault(); this.meter.unlock();
      Promise.resolve(this.command(button.dataset.deviceCommand)).catch(cause => this.showError(cause));
    }, {signal});
    root.addEventListener('change', event => {
      const kind = event.target.dataset.deviceSelect; if (!kind) return;
      const result = call ? call.selectDevice(kind, event.target.value) : media.select(kind, event.target.value);
      Promise.resolve(result).catch(cause => this.showError(cause));
    }, {signal});
    media.addEventListener('change', () => this.update(), {signal});
    media.addEventListener('devices', () => this.updateDevices(), {signal});
    this.video.addEventListener('loadedmetadata', () => this.play(), {signal});
    this.update(); media.refreshDevices();
  }
  command(command) {
    if (command === 'play') return this.play();
    if (command === 'refresh') return this.media.refreshDevices();
    if (command === 'stop') return Promise.all(['audio', 'video'].map(kind => this.enable(kind, false)));
    if (command === 'test') {
      const form = this.root.closest('form');
      const audio = form?.elements.namedItem('audio')?.checked ?? true;
      const video = form?.elements.namedItem('video')?.checked ?? true;
      return Promise.all([this.enable('audio', audio), this.enable('video', video)]);
    }
    if (command === 'flip') {this.onIntent('video', true); return this.call ? this.call.flipCamera() : this.media.flipCamera();}
    if (command === 'audio' || command === 'video') {
      const status = this.media.snapshot()[command];
      return this.enable(command, !(status.capturing && !status.interrupted && !status.issue));
    }
  }
  enable(kind, enabled) {
    this.onIntent(kind, enabled);
    if (this.call) return kind === 'audio' ? this.call.setMuted(!enabled) : this.call.setCamera(enabled);
    return enabled ? this.media.request(kind, {force: !!this.media.track(kind)?.muted}) : this.media.release(kind);
  }
  play() {
    if (this.closed || !this.video.srcObject) return Promise.resolve();
    const button = this.root.querySelector('[data-device-command=play]');
    return this.video.play().then(() => {button.hidden = true;}, () => {if (!this.closed) button.hidden = false;});
  }
  update() {
    if (this.closed) return;
    const snapshot = this.media.snapshot();
    for (const kind of ['audio', 'video']) {
      const value = snapshot[kind], noun = kind === 'audio' ? 'microphone' : 'camera';
      this.root.querySelector(`[data-device-status=${kind}]`).textContent = value.busy ? 'Waiting for permission…' : value.issue ? 'Needs attention' : value.interrupted ? 'Interrupted — retry' : value.capturing ? 'Ready' : 'Off';
      const button = this.root.querySelector(`[data-device-command=${kind}]`);
      button.disabled = value.busy; button.textContent = value.issue || value.interrupted ? `Retry ${noun}` : value.capturing ? `Turn ${noun} off` : `Enable ${noun}`;
      button.setAttribute('aria-pressed', String(value.capturing));
      this.root.querySelector(`[data-device-select=${kind}]`).disabled = value.busy;
    }
    this.root.querySelector('[data-device-command=flip]').disabled = snapshot.video.busy;
    this.root.querySelector('[data-device-command=test]').disabled = snapshot.audio.busy || snapshot.video.busy;
    this.root.querySelector('[data-preview-placeholder]').hidden = snapshot.video.capturing && !snapshot.video.interrupted;
    this.video.classList.toggle('mirror', (this.media.track('video')?.getSettings?.().facingMode || this.media.preferences.video.facingMode) !== 'environment');
    if (this.video.srcObject !== this.media.stream) this.video.srcObject = this.media.stream;
    if (snapshot.video.capturing) this.play();
    this.meter.attach(this.media.track('audio'));
    this.renderIssues(Object.values(snapshot).map(value => value.issue).filter(Boolean));
  }
  renderIssues(issues) {
    this.root.querySelector('[data-device-errors]').innerHTML = issues.map(issue => `<div class="device-error"><strong>${E(issue.title)}</strong><p>${E(issue.detail)}</p></div>`).join('');
  }
  showError(cause) {
    if (this.closed || cause?.name === 'AbortError' && this.media.closed) return;
    const issues = Object.values(this.media.snapshot()).map(value => value.issue).filter(Boolean);
    this.renderIssues(cause instanceof MediaAccessError ? cause.issues : issues.length ? issues : [mediaIssue(cause, 'audio')]);
  }
  updateDevices() {
    if (this.closed) return;
    for (const [kind, type] of [['audio', 'audioinput'], ['video', 'videoinput']]) {
      const select = this.root.querySelector(`[data-device-select=${kind}]`), selected = this.media.preferences[kind].deviceId || '';
      const choices = this.media.devices.filter(device => device.kind === type && device.deviceId);
      select.replaceChildren(new Option('Automatic', ''));
      choices.forEach((device, i) => select.add(new Option(device.label || `${kind === 'audio' ? 'Microphone' : 'Camera'} ${i + 1}`, device.deviceId)));
      if (selected && !choices.some(device => device.deviceId === selected)) select.add(new Option('Previously selected device (unavailable)', selected));
      select.value = selected;
    }
  }
  dispose() {
    if (this.closed) return; this.closed = true; this.abort.abort(); this.meter.dispose();
    this.video.pause(); this.video.srcObject = null;
  }
}
