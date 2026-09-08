import {cp,mkdir,rm,readdir,stat} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const output=path.join(root,'dist');
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});await cp(path.join(root,'public'),output,{recursive:true});
let files=0,bytes=0;async function scan(dir){for(const x of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,x.name);if(x.isDirectory())await scan(p);else{files++;bytes+=(await stat(p)).size;}}}await scan(output);
console.log(`Built dist/: ${files} files, ${bytes} bytes. Static hosting supports device-local work and configured Microsoft APIs, not the Node collaboration server.`);
