import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');let build;try{({build}=await import('esbuild'));}catch{console.error('Run npm install before npm run build:microsoft.');process.exit(1);}
await mkdir(path.join(root,'public/vendor'),{recursive:true});
for(const [name,dependency] of [['msal','@azure/msal-browser'],['acs-calling','@azure/communication-calling'],['acs-common','@azure/communication-common']]){
 await build({stdin:{contents:`export * from '${dependency}';`,resolveDir:root,sourcefile:`${name}-entry.js`},bundle:true,platform:'browser',format:'esm',target:['es2022'],outfile:path.join(root,`public/vendor/${name}.js`),sourcemap:true,minify:true,legalComments:'linked'});
}
await writeFile(path.join(root,'public/vendor/README.txt'),'Official Microsoft SDK distributions. Preserve emitted license files and consult each upstream SDK license.\nSet useBundledSDKs: true in public/config.js before deployment.\n');
console.log('Built public/vendor/. Set useBundledSDKs: true in public/config.js. No service credentials are bundled.');
