from pathlib import Path
from hashlib import sha256

root = Path.cwd()
files = ['public/core/calls.js', 'public/core/media.js', 'tests/calls.test.mjs', 'tests/media.test.mjs']

def change(name, old, new):
    file = root / name
    text = file.read_text()
    assert text.count(old) == 1, (name, 'Unexpected source; refusing replacement')
    file.write_text(text.replace(old, new))

change('public/core/calls.js', "      this.muted = !this.media.track('audio')?.enabled; this.camera = !!this.media.track('video')?.enabled;\n", '')
change('public/core/calls.js', "      check(); this.roomId = roomId; this.emit('local', {stream: this.local});", "      check(); this.roomId = roomId;\n      // Capture can end or be interrupted while ICE configuration is in flight.\n      const audio = this.media.track('audio'), video = this.media.track('video');\n      this.muted = !audio?.enabled || !!audio?.muted; this.camera = !!video?.enabled && !video.muted;\n      this.emit('local', {stream: this.local});")
change('public/core/media.js', "    const prefs = this.preferences.video; prefs.deviceId = ''; prefs.facingMode = prefs.facingMode === 'environment' ? 'user' : 'environment';", "    const prefs = this.preferences.video, activeFacing = this.track('video')?.getSettings?.()?.facingMode;\n    const facing = ['user', 'environment'].includes(activeFacing) ? activeFacing : prefs.facingMode;\n    prefs.deviceId = ''; prefs.facingMode = facing === 'environment' ? 'user' : 'environment';")

with (root / 'tests/calls.test.mjs').open('a') as file:
    file.write('''
for (const interruption of ['ended', 'muted']) {
  test(`join advertises current capture state after ICE discovery: ${interruption}`, async t => {
    const {engine, media, provider} = setup(t, 'server'), ice = defer();
    let requested = false;
    provider.request = route => {assert.equal(route, '/ice'); requested = true; return ice.promise;};
    const joining = engine.join('room', {audio: true, video: true});
    await flush(); assert.equal(requested, true); assert.equal(engine.roomId, null);
    for (const kind of ['audio', 'video']) {
      const track = media.track(kind); assert.ok(track);
      if (interruption === 'ended') track.end(); else track.interrupt(true);
    }
    await engine.mediaQueue;
    ice.resolve({iceServers: []}); await joining;
    assert.equal(engine.muted, true); assert.equal(engine.camera, false);
    const announcement = provider.signals.find(signal => signal.type === 'call-join');
    assert.ok(announcement); assert.equal(announcement.muted, true); assert.equal(announcement.camera, false);
  });
}
''')
with (root / 'tests/media.test.mjs').open('a') as file:
    file.write('''
for (const [activeFacing, nextFacing] of [['environment', 'user'], ['user', 'environment']]) {
  test(`camera flip uses the active ${activeFacing} device rather than stale preference`, async t => {
    const {media, devices} = create(); t.after(() => media.dispose());
    await media.request('video');
    const selected = new Track('video');
    selected.getSettings = () => ({deviceId: 'chosen-camera', facingMode: activeFacing});
    devices.handlers.push(() => Promise.resolve(new Stream([selected])));
    await media.select('video', 'chosen-camera');
    media.preferences.video.facingMode = nextFacing;
    devices.handlers.push(constraints => {
      assert.equal(selected.readyState, 'ended');
      assert.equal(constraints.video.facingMode.ideal, nextFacing);
      assert.equal(constraints.video.deviceId, undefined);
      return Promise.resolve(new Stream([new Track('video')]));
    });
    await media.flipCamera();
    assert.equal(media.preferences.video.facingMode, nextFacing);
    assert.equal(media.stream.getVideoTracks().length, 1);
  });
}
''')

manifest = root / 'MANIFEST.sha256'
lines = manifest.read_text().splitlines()
for name in files:
    matching = [line for line in lines if line.endswith('  ' + name)]
    assert len(matching) == 1
    lines[lines.index(matching[0])] = sha256((root / name).read_bytes()).hexdigest() + '  ' + name
manifest.write_text('\n'.join(lines) + '\n')
expected = {
    'public/core/calls.js': 'c8c594758bc3d73ecbd88c7b143989967d455bcf7da3a7157992c294f3d9156d',
    'public/core/media.js': 'df4e18849a065f1b4132dac80c9025e18489cbb932c3fef1c3a45c73fd64f51d',
    'tests/calls.test.mjs': 'acf6cd19fa1f104c13e5c03cea522de1812f205d295bcaecc2bdaa74fae07d90',
    'tests/media.test.mjs': '6b4ecd562d57267be9293911099fbb0fe978ac74da08e8eddaac32bacf08147a',
    'MANIFEST.sha256': '22c94f7b777c4f10ac129243df83c5131435b3c78b4bca50e9deba4eadece24d',
}
for name, digest in expected.items():
    assert sha256((root / name).read_bytes()).hexdigest() == digest, name
    print('Verified locally tested review fix:', name)
