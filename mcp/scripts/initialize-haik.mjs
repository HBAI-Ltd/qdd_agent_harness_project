import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {writeVault} from '../sites/haik-console/local/vault.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),vault=path.join(root,'.local/haik-credentials.dpapi');
let exists=false;try{await access(vault);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(!exists){
 const config=JSON.parse(await readFile(path.join(root,'.local/haik-client-config.json'),'utf8'));
 const installation=randomUUID().replaceAll('-','');
 config.headers={...config.headers,deviceId:installation,uuid:installation,deviceName:'Local Windows'};
 config.sdk={...config.sdk,featureCode:installation,uuid:installation};
 await writeVault(vault,{session:{headers:{}},config});
 console.log('Initialized a new, logged-out Windows user vault. Sign in using the local webpage.');
}
