import {CloudError} from './cloud.mjs';
import {createHash} from 'node:crypto';

export function recordingDay(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new CloudError('INVALID_DATE','日期请使用 YYYY-MM-DD（北京时间）',400);
  const date=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw new CloudError('INVALID_DATE','录像日期无效',400);
  return value;
}
export function recordingTime(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))throw new CloudError('INVALID_TIME','录像时间请使用 YYYY-MM-DD HH:mm:ss（北京时间）',400);
  recordingDay(value.slice(0,10));
  if(Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)throw new CloudError('INVALID_TIME','录像时间无效',400);
  return value;
}
export function recordingRange(start,end,maxSeconds=86400){
  recordingTime(start);recordingTime(end);
  const seconds=(Date.parse(end.replace(' ','T')+'+08:00')-Date.parse(start.replace(' ','T')+'+08:00'))/1000;
  if(seconds<=0||seconds>maxSeconds)throw new CloudError('INVALID_TIME_RANGE','结束时间必须晚于开始时间，且范围不能超过 '+maxSeconds+' 秒',400);
  return seconds;
}
export function cloudFileTimes(item){
  const match=String(item.name||'').match(/^(\d{14})-(\d{14})(?:_|\.)/);
  const expand=value=>value.slice(0,4)+'-'+value.slice(4,6)+'-'+value.slice(6,8)+' '+value.slice(8,10)+':'+value.slice(10,12)+':'+value.slice(12,14);
  if(match){
    const startTime=expand(match[1]),endTime=expand(match[2]);
    try{return {startTime,endTime,durationSeconds:recordingRange(startTime,endTime)};}catch{}
  }
  return {startTime:null,endTime:null,durationSeconds:null};
}

const cloudRoute='/device-center/application/app/application/cloud/';
export async function recordingDates(client,deviceCode){
  const data=await client.post(cloudRoute+'getFolderList',{deviceCode});
  if(!Array.isArray(data))throw new CloudError('INVALID_RECORDING_DATES','云录像日期格式不受支持');
  const dates=new Set();
  for(const item of data){
    const name=String(item.name||'');
    if(/^\d{8}$/.test(name)){const day=name.slice(0,4)+'-'+name.slice(4,6)+'-'+name.slice(6,8);try{dates.add(recordingDay(day));}catch{}}
  }
  return [...dates].sort().reverse();
}

export async function cloudRecordings(client,deviceCode,date){
  recordingDay(date);
  const items=new Map();let fetched=0;
  for(let pageNum=1;pageNum<=100;pageNum++){
    const data=await client.post(cloudRoute+'getFileList',{deviceCode,path:date.replaceAll('-',''),isHttp:true,pageSize:1500,pageNum});
    if(!Array.isArray(data?.fileList)||!Number.isSafeInteger(data.count)||data.count<0)throw new CloudError('INVALID_RECORDINGS','云录像片段格式不受支持');
    let added=0;
    for(const item of data.fileList){
      if(typeof item.id!=='string'||!item.id||item.id.length>1024)continue;
      if(!items.has(item.id))added++;
      items.set(item.id,{id:item.id,name:String(item.name||'录像片段').slice(0,200),source:'cloud',...cloudFileTimes(item),bytes:Number.isFinite(item.size)?item.size:null,encrypted:String(item.extendProps?.streamEncrypt||'0')!=='0'});
    }
    fetched+=data.fileList.length;
    if(data.fileList.length===0||fetched>=data.count)return [...items.values()];
    if(added===0)throw new CloudError('INVALID_RECORDING_PAGE','云录像分页没有取得新片段');
  }
  throw new CloudError('RECORDING_LIMIT','云录像分页超过上限');
}

export async function cloudRecordingSource(client,deviceCode,id){
  const value=await client.post(cloudRoute+'getFileUrlById',{deviceCode,id,isHttp:true,fileType:0,type:1});
  const raw=value?.url;let url;
  try{url=new URL(raw);}catch{throw new CloudError('NO_RECORDING_URL','云端没有返回有效的录像地址');}
  if(!['http:','https:','rtsp:','rtsps:'].includes(url.protocol)||url.username||url.password)throw new CloudError('INVALID_RECORDING_URL','录像地址协议不受支持');
  return {url:raw};
}

export async function sdRecordingSource(client,deviceCode,startTime,endTime,recordName){
  recordingRange(startTime,endTime);
  const value=await client.post('/device-center/control/sd-card/record/url',{deviceCode,beginTime:startTime,endTime,playProtocol:3,...(recordName?{recordName}:{} )});
  const raw=value?.streamUrl;let url;
  try{url=new URL(raw);}catch{throw new CloudError('NO_RECORDING_URL','云端没有返回可用的 SD 卡回放地址');}
  if(!['http:','https:','rtsp:','rtsps:'].includes(url.protocol))throw new CloudError('INVALID_RECORDING_URL','SD 卡回放协议不受支持');
  return {url:raw};
}

export async function sdRecordings(client,deviceCode,date){
  recordingDay(date);
  const data=await client.post('/device-center/control/sd-card/records/list',{deviceCode,beginTime:date+' 00:00:00',endTime:date+' 23:59:59'});
  if(!Array.isArray(data))throw new CloudError('INVALID_RECORDINGS','SD 卡录像片段格式不受支持');
  return data.map(item=>{
    const startTime=recordingTime(item.beginTime),endTime=recordingTime(item.endTime),durationSeconds=recordingRange(startTime,endTime);
    const name=String(item.recordName||'').slice(0,200);
    return {id:createHash('sha256').update(JSON.stringify([deviceCode,startTime,endTime,name])).digest('hex'),name,source:'sd',startTime,endTime,durationSeconds,bytes:null,encrypted:false};
  });
}
