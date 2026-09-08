import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let count=0;
async function visit(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(['node_modules','data','dist','vendor'].includes(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory()){await visit(file);continue;}if(!/\.(?:mjs|js)$/.test(file))continue;const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr);process.exitCode=1;}const code=await readFile(file,'utf8');for(const match of code.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)){if(match[1].includes('/vendor/'))continue;try{await stat(path.resolve(path.dirname(file),match[1]));}catch{console.error('Missing module',file,match[1]);process.exitCode=1;}}count++;}}
await visit(root);console.log(`Checked ${count} JavaScript modules and their relative imports.`);
