import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';

// The loopback browser session survives service updates within this Windows profile.
// The cloud account still requires its own separately encrypted login session.
export async function localKey(path){
 try{const key=(await readFile(path,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Invalid local access key');return key;}
 catch(e){if(e.code!=='ENOENT')throw e;}
 const key=randomBytes(32).toString('hex');
 try{await writeFile(path,key,{mode:0o600,flag:'wx'});return key;}
 catch(e){if(e.code!=='EEXIST')throw e;return localKey(path);}
}
