const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const cameraId={type:'string',minLength:1,maxLength:128};
const date={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'北京时间 YYYY-MM-DD'};
const time={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',description:'北京时间 YYYY-MM-DD HH:mm:ss'};
const source={type:'string',enum:['cloud','sd'],default:'cloud'};
const recordId={type:'string',minLength:1,maxLength:1024};
const jobId={type:'string',pattern:'^[a-f0-9]{32}$',maxLength:32};
const width={type:'integer',minimum:320,maximum:1920,default:1280};
const page={offset:{type:'integer',minimum:0,maximum:150000,default:0},limit:{type:'integer',minimum:1,maximum:100,default:50}};
const playback={cameraId,date,source,recordId,startTime:time,endTime:time};
const read={readOnlyHint:true,idempotentHint:true,openWorldHint:true};
const localRead={readOnlyHint:true,idempotentHint:true,openWorldHint:false};
const save={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true};
export const MEDIA_TOOLS=[
 {name:'camera_capabilities',description:'读取海康摄像头可用能力；区分协议支持和实际有无录像。',inputSchema:object({cameraId},['cameraId']),annotations:read},
 {name:'camera_recording_dates',description:'读取当前摄像头可查询的录像日期。日期为北京时间，实际支持取决于设备和账号服务。',inputSchema:object({cameraId,source},['cameraId']),annotations:read},
 {name:'camera_recordings',description:'按北京时间日期查询云端或SD卡录像片段，返回片段ID、起止时间并分页，不输出云端签名地址。',inputSchema:object({cameraId,date,source,...page},['cameraId','date']),annotations:read},
 {name:'camera_playback',description:'回放先前查询的录像，返回本机网页/HLS链接。用date/source/recordId选择片段；SD也可指定起止时间。',inputSchema:object(playback,['cameraId']),annotations:read},
 {name:'camera_snapshot',description:'直接解码实时视频并保存单张JPEG，返回本地图片路径、下载URL和SHA256；用图片读取工具查看实际画面后再分析，若pending请查询同一任务。',inputSchema:object({cameraId,quality:{type:'integer',enum:[1,2],default:2},maxWidth:width},['cameraId']),annotations:save},
 {name:'camera_capture_start',description:'启动持久化本地采集。frames按durationSeconds和fps保存JPEG，最多1800帧；video保存H264 MP4（固定15fps无音频，最多600秒）。立即返回job.id，用capture_status分页获取路径继续图片分析。支持实时和已选择的历史片段。',inputSchema:object({...playback,mode:{type:'string',enum:['live','playback'],default:'live'},kind:{type:'string',enum:['frames','video'],default:'frames'},durationSeconds:{type:'integer',minimum:1,maximum:3600},fps:{type:'number',minimum:0.1,maximum:5,default:1},maxWidth:width,quality:{type:'integer',enum:[1,2],default:2}},['cameraId','durationSeconds']),annotations:save},
 {name:'capture_status',description:'查询采集进度和持久文件路径。帧列表默认50张、最多100张，用nextOffset继续；capturedAt是近似采集时间，历史时间见sourceInfo。',inputSchema:object({jobId,...page},['jobId']),annotations:localRead},
 {name:'capture_list',description:'列出当前账号的本地截图/录像任务和保存目录；已完成文件在服务重启后保留，不返回其它账号任务。',inputSchema:object({cameraId}),annotations:localRead},
 {name:'capture_cancel',description:'取消指定截图/录像采集，保留已完成的图片和视频，不删除文件。',inputSchema:object({jobId},['jobId']),annotations:{...save,openWorldHint:false,idempotentHint:true}},
];
export const MEDIA_ACTIONS={'capabilities':'camera_capabilities','recording-dates':'camera_recording_dates','recordings':'camera_recordings','playback':'camera_playback','snapshot':'camera_snapshot','capture-start':'camera_capture_start','capture-status':'capture_status','capture-list':'capture_list','capture-cancel':'capture_cancel'};
export const MEDIA_TOOL_ACTIONS=Object.fromEntries(Object.entries(MEDIA_ACTIONS).map(([action,name])=>[name,action]));
export function validateMediaCombination(name,args){
 if(name==='camera_playback'||name==='camera_capture_start'&&args.mode==='playback'){
  if((args.source??'cloud')==='cloud'&&(!args.date||!args.recordId))throw new Error('云录像需先查询并提供 date 和 recordId');
  if(args.source==='sd'&&!(args.date&&args.recordId)&&!(args.startTime&&args.endTime))throw new Error('SD回放需要date/recordId或startTime/endTime');
 }
 if(name==='camera_capture_start'){
  if((args.kind??'frames')==='frames'&&Math.ceil(args.durationSeconds*(args.fps??1))>1800)throw new Error('单任务最多1800帧，请减少时长或帧率');
  if(args.kind==='video'&&args.durationSeconds>600)throw new Error('单次本地录像最多600秒');
  if((args.mode??'live')==='live'&&['date','source','recordId','startTime','endTime'].some(key=>Object.hasOwn(args,key)))throw new Error('实时采集无需录像来源或片段参数');
 }
}
