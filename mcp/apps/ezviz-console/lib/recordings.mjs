import {createHash} from 'node:crypto';
import {CloudError} from './cloud.mjs';

export function recordingDay(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new CloudError('INVALID_DATE','日期请使用有效的 YYYY-MM-DD（北京时间）',400);
  return value;
}
export function recordingTime(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))throw new CloudError('INVALID_TIME','录像时间请使用 YYYY-MM-DD HH:mm:ss（北京时间）',400);
  recordingDay(value.slice(0,10));
  if(+value.slice(11,13)>23||+value.slice(14,16)>59||+value.slice(17,19)>59)throw new CloudError('INVALID_TIME','录像时间无效',400);
  return value;
}
const millis=value=>Date.parse(recordingTime(value).replace(' ','T')+'+08:00');
const beijing=value=>new Date(value+8*3600000).toISOString().slice(0,19).replace('T',' ');
function sourceType(value='cloud'){if(!['cloud','sd'].includes(value))throw new CloudError('INVALID_SOURCE','请选择云录像或SD卡录像',400);return value;}
export async function recordingDates(client,cameraId,source='cloud',month=new Date(Date.now()+8*3600000).toISOString().slice(0,7)){
  sourceType(source);if(typeof month!=='string'||!/^\d{4}-\d{2}$/.test(month))throw new CloudError('INVALID_MONTH','月份请使用 YYYY-MM',400);recordingDay(month+'-01');
  const camera=await client.camera(cameraId),rows=await client.recordingCalendar(camera,month,source),dates=new Set();
  for(const row of rows){recordingDay(row?.recDay);if(!row.recDay.startsWith(month+'-'))throw new CloudError('INVALID_CALENDAR','录像日历日期与请求月份不一致');if(Number(row[source==='sd'?'local':'cloud'])===1)dates.add(row.recDay);}
  return [...dates].sort();
}

export async function listRecordings(client,cameraId,date,source='cloud'){
  recordingDay(date);sourceType(source);
  const camera=await client.camera(cameraId),token=await client.videoToken(camera);
  const start=millis(date+' 00:00:00'),end=start+86400000-1,rows=new Map();let cursor=start;
  for(let page=0;page<100;page++){
    const data=await client.ys('/api/lapp/video/by/time',token,{deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),startTime:String(cursor),endTime:String(end),recType:source==='cloud'?'1':'2',version:'2.0',pageSize:'500'});
    const legacy=Array.isArray(data),files=legacy?data:data?.files;
    if(!Array.isArray(files)&&!(files==null&&data?.isAll===true))throw new CloudError('INVALID_RECORDINGS','录像片段响应格式不受支持');
    for(const file of files||[]){
      if(!file||typeof file!=='object'||Array.isArray(file))throw new CloudError('INVALID_RECORDINGS','录像片段格式不受支持');
      if(file.recType!=null&&![0,source==='cloud'?1:2].includes(Number(file.recType)))throw new CloudError('INVALID_RECORDINGS','录像响应来源与请求不一致');
      const rawStart=Number(file.startTime),rawEnd=Number(file.endTime);
      if(!Number.isSafeInteger(rawStart)||!Number.isSafeInteger(rawEnd)||rawStart<1e12||rawEnd<=rawStart)throw new CloudError('INVALID_RECORDINGS','录像片段时间格式不受支持');
      if(rawEnd<=start||rawStart>end)continue;
      const channel=file.channelNo??file.cameraNo;
      if(file.deviceSerial&&String(file.deviceSerial)!==camera.deviceSerial||channel!=null&&Number(channel)!==camera.channelNo)throw new CloudError('INVALID_RECORDINGS','录像响应通道与所选摄像头不一致');
      const from=Math.max(rawStart,start),to=Math.min(rawEnd,end),durationSeconds=Math.floor((to-from)/1000);
      if(durationSeconds<1)continue;
      const id=createHash('sha256').update(JSON.stringify([cameraId,source,rawStart,rawEnd,String(file.fileId??file.id??'')])).digest('hex');
      rows.set(id,{id,name:source==='cloud'?'云录像片段':'SD卡录像片段',source,startTime:beijing(from),endTime:beijing(to),durationSeconds,bytes:Number.isSafeInteger(Number(file.fileSize))&&Number(file.fileSize)>0?Number(file.fileSize):null,encrypted:String(file.crypt??'0')!=='0'});
    }
    if(legacy||data.isAll===true)return [...rows.values()].sort((a,b)=>a.startTime.localeCompare(b.startTime)||a.id.localeCompare(b.id));
    const next=Number(data.nextFileTime);
    if(data.isAll!==false||!Number.isSafeInteger(next)||next<=cursor||next>end)throw new CloudError('INVALID_RECORDING_PAGE','录像分页未返回可继续的时间游标');
    cursor=next;
  }
  throw new CloudError('RECORDING_LIMIT','单日录像查询达到分页上限，请缩小查询范围');
}

export async function recordingSource(client,cameraId,args){
  const source=sourceType(args.source),camera=await client.camera(cameraId);
  if(!camera.online)throw new CloudError('CAMERA_OFFLINE','摄像头当前离线',409);
  if(camera.encrypted!==false)throw new CloudError('CAMERA_ENCRYPTED','设备视频加密或加密状态未知，当前本地解码不支持',409);
  let startTime,endTime,recordId;
  if(args.recordId){
    const row=(await listRecordings(client,cameraId,args.date,source)).find(item=>item.id===args.recordId);
    if(!row)throw new CloudError('RECORDING_NOT_FOUND','该片段不在所选摄像头、日期和来源的录像列表中',404);
    if(row.encrypted)throw new CloudError('RECORDING_ENCRYPTED','该录像已加密，当前本地解码不支持',409);
    ({startTime,endTime}=row);recordId=row.id;
  }else{
    if(source!=='sd')throw new CloudError('RECORDING_REQUIRED','云录像需先查询并选择片段',400);
    startTime=recordingTime(args.startTime);endTime=recordingTime(args.endTime);
  }
  const durationSeconds=(millis(endTime)-millis(startTime))/1000;
  if(durationSeconds<=0||durationSeconds>86400||startTime.slice(0,10)!==endTime.slice(0,10))throw new CloudError('INVALID_TIME_RANGE','回放起止时间必须在同一天，且结束晚于开始',400);
  const token=await client.videoToken(camera);
  const data=await client.ys('/api/lapp/v2/live/address/get',token,{deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),protocol:'4',type:source==='cloud'?'3':'2',startTime,stopTime:endTime,expireTime:'300',supportH265:'1',diserr:'1',mute:'1'});
  let url;try{url=new URL(data?.url);}catch{}
  if(!url||url.protocol!=='https:'||url.username||url.password)throw new CloudError('INVALID_PLAY_URL','服务未返回有效的 HTTPS 回放地址');
  return {url:url.href,protocol:'flv',durationSeconds,sourceInfo:{mode:'playback',source,date:startTime.slice(0,10),startTime,endTime,...(recordId?{recordId}:{})}};
}
