import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='win32'||Number(process.versions.node.split('.')[0])<24){
  throw new Error('Use Node.js 24.5+ on Windows; credential storage uses Windows DPAPI.');
}
if(!process.env.npm_execpath)throw new Error('Run npm run setup from the mcp directory.');
for(const project of ['tools','sites/haik-console','apps/ezviz-console']){
  const result=spawnSync(process.execPath,[process.env.npm_execpath,'ci','--prefix',path.join(root,project),'--no-audit','--no-fund'],{cwd:root,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
const result=spawnSync(process.execPath,[path.join(root,'sites/haik-console/scripts/build-mcp-skill.mjs')],{stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
