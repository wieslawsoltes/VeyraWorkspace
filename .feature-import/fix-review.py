from pathlib import Path
from hashlib import sha256

root = Path.cwd()
files = ['public/app.js', 'server/index.mjs', 'tests/server.test.mjs', 'tests/browser_calls.py']

def change(name, old, new):
    file = root / name
    text = file.read_text()
    assert text.count(old) == 1, (name, 'Unexpected source; refusing replacement')
    file.write_text(text.replace(old, new))

change('public/app.js', '<h2 id="modal-title">${E(title)}</h2><p>${E(text)}</p>', '<h2>${E(title)}</h2><p>${E(text)}</p>')
change('public/app.js', '<div class="modal-head"><div><h2>${E(title)}</h2>', '<div class="modal-head"><div><h2 id="modal-title">${E(title)}</h2>')
change('server/index.mjs', 'const scrypt = promisify(scryptCallback);', "// Read release metadata once; health checks must not drift from the package version.\nconst { version: VERSION } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));\nconst scrypt = promisify(scryptCallback);")
change('server/index.mjs', "service:'veyra',version:'1.0.0'", "service:'veyra',version:VERSION")
change('tests/server.test.mjs', " await t.test('health is public; bootstrap requires a session',async()=>{assert.equal((await api('/health')).status,200);assert.equal((await api('/bootstrap')).status,401);});", " await t.test('health is public; bootstrap requires a session',async()=>{assert.equal((await api('/health')).status,200);assert.equal((await api('/bootstrap')).status,401);});\n await t.test('health reports the declared package release version',async()=>{const release=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));const health=await api('/health');assert.equal(health.status,200);assert.equal(health.body.version,release.version);});")
change('tests/browser_calls.py', "            await target.locator('#call-join-form').wait_for()", "            await target.locator('#call-join-form').wait_for()\n            await expect(target.get_by_role('dialog', name='Ready when you are', exact=True)).to_be_visible()\n            await expect(target.locator('#modal-title')).to_have_count(1)\n            assert await target.evaluate('window.veyraDiagnostics.version') == json.loads((ROOT / 'package.json').read_text())['version']")

manifest = root / 'MANIFEST.sha256'
lines = manifest.read_text().splitlines()
for name in files:
    matching = [line for line in lines if line.endswith('  ' + name)]
    assert len(matching) == 1
    lines[lines.index(matching[0])] = sha256((root / name).read_bytes()).hexdigest() + '  ' + name
manifest.write_text('\n'.join(lines) + '\n')

expected = {
    'public/app.js': '21ac4e02279b184e90bf4a89ede333b3adc3fd5889230c2a01a0461046100856',
    'server/index.mjs': '9807e449776e7fa53020818eba114db6682f1cef14c9d384034ab23d257657ec',
    'tests/server.test.mjs': '9d223a3cfc636d162f2c343b0bb8349a6a2ee73b97481cd07807a347e0b56817',
    'tests/browser_calls.py': '3e75ad2842e328e3916780e8a0d3ed8ed10c135f40b593c759dfe03dba8d4c9d',
    'MANIFEST.sha256': '5e027f894b8fd91da4efb380986d802589d911b30273459f3508346c13ad97ad',
}
for name, digest in expected.items():
    assert sha256((root / name).read_bytes()).hexdigest() == digest, name
    print('Verified locally tested review fix:', name)
