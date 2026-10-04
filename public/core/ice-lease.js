/** Renew short-lived broker TURN credentials before future ICE gathers.
 * A paused/stopped lease discards in-flight results. No secrets are persisted.
 */
export class IceLease {
  constructor({request, apply, onError = () => {}, now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id)}) {
    this.request = request; this.apply = apply; this.onError = onError;
    this.now = now; this.schedule = schedule; this.cancel = cancel; this.generation = 0;
    this.active = false; this.closed = false;
  }
  start(lease) {
    if (this.closed) return;
    this.pause(); this.active = true; this.plan(lease, this.generation);
  }
  plan(lease, generation) {
    if (!this.active || this.closed || generation !== this.generation) return;
    this.cancel(this.timer);
    if (lease.expiresAt == null) return; // Explicit non-expiring ICE configuration.
    if (!Number.isFinite(lease.expiresAt)) {this.onError(new Error('Invalid ICE credential expiry.')); return;}
    const remaining = lease.expiresAt - this.now();
    // Half-life renewal, capped at five minutes; retry never exceeds the broker budget.
    const delay = Math.max(15000, Math.min(300000, remaining / 2));
    this.timer = this.schedule(() => this.refresh(generation), delay);
  }
  async refresh(generation = this.generation) {
    if (!this.active || this.closed || generation !== this.generation) return;
    try {
      const lease = await this.request();
      if (!this.active || this.closed || generation !== this.generation) return;
      await this.apply(lease.iceServers);
      this.plan(lease, generation);
    } catch (error) {
      if (!this.active || this.closed || generation !== this.generation) return;
      this.onError(error);
      this.timer = this.schedule(() => this.refresh(generation), 30000);
    }
  }
  pause() {++this.generation; this.active = false; this.cancel(this.timer); this.timer = null;}
  close() {this.pause(); this.closed = true;}
}
