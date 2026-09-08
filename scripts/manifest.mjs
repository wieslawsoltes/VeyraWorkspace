/** Rebuild checksums of the release source. Output and local credentials are excluded. */
import {readdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['.git','node_modules','data','dist','__pycache__','tests/output','public/vendor','.feature-import']);
const files = [];
async function walk(relative = '') {
  for (const entry of await readdir(path.join(root,relative),{withFileTypes:true})) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded.has(name) || excluded.has(entry.name) || entry.name === 'MANIFEST.sha256' || /\.log$/.test(name) || /^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') continue;
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile()) files.push(name);
  }
}
await walk(); files.sort();
const hashes = await Promise.all(files.map(async file => `${createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')}  ${file}`));
await writeFile(path.join(root,'MANIFEST.sha256'),hashes.join('\n')+'\n');
console.log(`Wrote ${files.length} release-file checksums.`);
