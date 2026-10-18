import process from 'node:process';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {dirname} from 'node:path';

const encrypt="Add-Type -AssemblyName System.Security;$bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write('dpapi-v2:'+ [Convert]::ToBase64String($cipher));[Array]::Clear($bytes,0,$bytes.Length)";
const decrypt="$text=[Console]::In.ReadToEnd();if($text.StartsWith('dpapi-v2:')){Add-Type -AssemblyName System.Security;$cipher=[Convert]::FromBase64String($text.Substring(9));$bytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);try{[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))}finally{[Array]::Clear($bytes,0,$bytes.Length)}}else{$secure=ConvertTo-SecureString $text;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}}";

function protect(input,script){
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;"+script],{
      env:{...process.env,PSModulePath:(process.env.SystemRoot||'C:\\Windows')+'\\System32\\WindowsPowerShell\\v1.0\\Modules'},
      windowsHide:true,stdio:['pipe','pipe','pipe']
    });
    let output='';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>output+=chunk);
    child.stderr.resume();
    child.on('error',()=>reject(new Error('无法调用 Windows 凭据加密服务')));
    child.on('close',code=>code===0?resolve(output):reject(new Error('Windows 凭据加解密失败，请使用同一 Windows 账号运行')));
    child.stdin.end(input);
  });
}

export async function readVault(path){
  const encrypted=(await readFile(path,'utf8')).replace(/^\uFEFF/,'').trim();
  return JSON.parse((await protect(encrypted,decrypt)).replace(/^\uFEFF/,'').trim());
}

export async function writeVault(path,value){
  await mkdir(dirname(path),{recursive:true});
  const encrypted=await protect(JSON.stringify(value),encrypt);
  await writeFile(path+'.tmp',encrypted,{mode:0o600});
  await rename(path+'.tmp',path);
}
