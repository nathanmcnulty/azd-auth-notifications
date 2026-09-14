import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({entryPoints:['src/index.ts'],outfile:'dist/index.cjs',bundle:true,platform:'node',target:'node22',format:'cjs',external:['@azure/functions-core'],legalComments:'linked'});
await writeFile('dist/package.json', JSON.stringify({name:'auth-notifications-runtime',version:'0.1.0',main:'index.cjs'}));
await writeFile('dist/host.json', JSON.stringify({version:'2.0',functionTimeout:'00:10:00',logging:{applicationInsights:{samplingSettings:{isEnabled:true}}}}));
await copyFile('LICENSE','dist/LICENSE');

