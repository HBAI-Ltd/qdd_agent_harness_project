import {CloudError} from './cloud.mjs';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const cameraId = {type: 'string', minLength: 1, maxLength: 256};
const objectSchema = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const dateSchema={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'北京时间日期 YYYY-MM-DD'};
const timeSchema={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',description:'北京时间 YYYY-MM-DD HH:mm:ss'};
const sourceSchema={type:'string',enum:['cloud','sd'],default:'cloud'};
const recordIdSchema={type:'string',minLength:1,maxLength:1024};
const jobIdSchema={type:'string',pattern:'^[a-f0-9]{32}$'};
const qualitySchema={type:'string',enum:['main','sub']};
const widthSchema={type:'integer',minimum:320,maximum:1920,default:1280};
const playbackProperties={cameraId,source:sourceSchema,date:dateSchema,recordId:recordIdSchema,startTime:timeSchema,endTime:timeSchema};
const pagination={offset:{type:'integer',minimum:0,maximum:150000,default:0},limit:{type:'integer',minimum:1,maximum:100,default:50}};
const read={readOnlyHint:true,idempotentHint:true,openWorldHint:true};
const localRead={readOnlyHint:true,idempotentHint:true,openWorldHint:false};
const stream={readOnlyHint:true,idempotentHint:false,openWorldHint:true};
const change={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true};
const TOOLS = [
  {name: 'tysl_camera_status', description: '检查本地天翼视联服务与登录状态，不返回凭据。', inputSchema: objectSchema(), annotations:localRead},
  {name: 'tysl_camera_list', description: '获取本人账号有权访问的天翼视联摄像头列表。', inputSchema: objectSchema(), annotations:read},
  {name: 'tysl_camera_preview', description: '取得摄像头预览的本地网页或 HLS 地址。', inputSchema: objectSchema({cameraId, quality: {type: 'string', enum: ['main', 'sub']}}, ['cameraId']), annotations:stream},
  {name: 'tysl_camera_ptz', description: '发送一次短脉冲云台操作，服务端在 finally 中停止。', inputSchema: objectSchema({cameraId, direction: {type: 'string', enum: ['up', 'down', 'left', 'right']}, durationMs: {type: 'integer', minimum: 200, maximum: 1000, default: 350}, speed: {type: 'integer', minimum: 1, maximum: 5, default: 2}}, ['cameraId', 'direction']), annotations:change},
  {name: 'tysl_camera_stop', description: '停止指定摄像头云台；省略 cameraId 时停止全部活动云台。', inputSchema: objectSchema({cameraId}), annotations:{...change,idempotentHint:true}},
  {name:'tysl_camera_capabilities',description:'查询已授权摄像头的实时、云台、SD回放协议能力；支持协议不代表存有录像。',inputSchema:objectSchema({cameraId},['cameraId']),annotations:read},
  {name:'tysl_camera_recording_dates',description:'查询摄像头有云录像的日期，时间为北京时间。',inputSchema:objectSchema({cameraId},['cameraId']),annotations:read},
  {name:'tysl_camera_recordings',description:'按北京时间日期查询云录像或SD卡录像片段，分页返回片段ID、起止时间和大小，不返回云端签名地址。',inputSchema:objectSchema({cameraId,date:dateSchema,source:sourceSchema,...pagination},['cameraId','date']),annotations:read},
  {name:'tysl_camera_playback',description:'播放已查询的历史录像，返回本地HLS和网页链接。云录像需date和recordId；SD可用date与recordId或起止时间。',inputSchema:objectSchema(playbackProperties,['cameraId']),annotations:stream},
  {name:'tysl_camera_snapshot',description:'从实时视频保存单张JPEG到本地，返回图片绝对路径、下载URL和SHA256。可用图片读取工具继续分析；若pending请查询任务状态。',inputSchema:objectSchema({cameraId,quality:qualitySchema,maxWidth:widthSchema},['cameraId']),annotations:change},
  {name:'tysl_camera_capture_start',description:'启动持久化采集任务：按durationSeconds和fps抽取图片，或kind=video保存H264 MP4。立即返回任务ID；用tysl_capture_status分页取文件路径做图片分析。支持实时或选定历史片段，录像固定15fps无音频。',inputSchema:objectSchema({...playbackProperties,mode:{type:'string',enum:['live','playback'],default:'live'},kind:{type:'string',enum:['frames','video'],default:'frames'},durationSeconds:{type:'integer',minimum:1,maximum:3600,default:10,description:'截图最多3600秒、1800帧；video最多600秒'},fps:{type:'number',minimum:0.1,maximum:5,default:1,description:'仅截图采样帧率，每秒帧数'},maxWidth:widthSchema,quality:qualitySchema},['cameraId','durationSeconds']),annotations:change},
  {name:'tysl_capture_status',description:'查询采集进度、已保存文件和路径，图片分页默认50张；用offset读取后续帧，任务完成文件仍保留。',inputSchema:objectSchema({jobId:jobIdSchema,...pagination},['jobId']),annotations:localRead},
  {name:'tysl_capture_list',description:'列出当前账号的本地采集/录像任务与持久化目录。可按cameraId筛选，不返回其它账号任务。',inputSchema:objectSchema({cameraId}),annotations:localRead},
  {name:'tysl_capture_cancel',description:'停止指定采集任务并保留已生成的图片/视频，不删除文件。',inputSchema:objectSchema({jobId:jobIdSchema},['jobId']),annotations:{...change,idempotentHint:true,openWorldHint:false}}
];
const ACTIONS = {tysl_camera_list:'list',tysl_camera_preview:'preview',tysl_camera_ptz:'ptz',tysl_camera_stop:'stop',tysl_camera_capabilities:'capabilities',tysl_camera_recording_dates:'recording-dates',tysl_camera_recordings:'recordings',tysl_camera_playback:'playback',tysl_camera_snapshot:'snapshot',tysl_camera_capture_start:'capture-start',tysl_capture_status:'capture-status',tysl_capture_list:'capture-list',tysl_capture_cancel:'capture-cancel'};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const validCameraId = value => typeof value === 'string' && value.length >= 1 && value.length <= 256 && value.trim().length > 0;
const result = (id, value) => ({status: 200, body: {jsonrpc: '2.0', id, result: value}});
const rpcError = (id, code, message) => ({status: 200, body: {jsonrpc: '2.0', id, error: {code, message}}});
const toolResult = (value, isError = false) => ({...(isError ? {isError: true} : {}), content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value});
const numberRange=(value,min,max,integer=true)=>(integer?Number.isInteger(value):Number.isFinite(value))&&value>=min&&value<=max;
const dateArg=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const timeArg=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
function playbackArgs(args){
  if(!validCameraId(args.cameraId)||own(args,'source')&&!['cloud','sd'].includes(args.source)||own(args,'date')&&!dateArg(args.date)||own(args,'recordId')&&(typeof args.recordId!=='string'||!args.recordId.length||args.recordId.length>1024)||own(args,'startTime')&&!timeArg(args.startTime)||own(args,'endTime')&&!timeArg(args.endTime))return false;
  return (args.source??'cloud')==='cloud'?dateArg(args.date)&&typeof args.recordId==='string':(dateArg(args.date)&&typeof args.recordId==='string'||timeArg(args.startTime)&&timeArg(args.endTime));
}
function paged(args){return (!own(args,'offset')||numberRange(args.offset,0,150000))&&(!own(args,'limit')||numberRange(args.limit,1,100));}

function toolArgs(name, value) {
  const args = value === undefined ? {} : value;
  if (!record(args)) return null;
  if (name === 'tysl_camera_status' || name === 'tysl_camera_list') return keysOnly(args, []) ? {} : null;
  if(name==='tysl_capture_list')return keysOnly(args,['cameraId'])&&(!own(args,'cameraId')||validCameraId(args.cameraId))?{...args}:null;
  if(name==='tysl_capture_status'||name==='tysl_capture_cancel')return keysOnly(args,name==='tysl_capture_status'?['jobId','offset','limit']:['jobId'])&&typeof args.jobId==='string'&&/^[a-f0-9]{32}$/.test(args.jobId)&&paged(args)?{...args}:null;
  if(['tysl_camera_capabilities','tysl_camera_recording_dates'].includes(name))return keysOnly(args,['cameraId'])&&validCameraId(args.cameraId)?{...args}:null;
  if(name==='tysl_camera_recordings')return keysOnly(args,['cameraId','date','source','offset','limit'])&&validCameraId(args.cameraId)&&dateArg(args.date)&&(!own(args,'source')||['cloud','sd'].includes(args.source))&&paged(args)?{...args}:null;
  if(name==='tysl_camera_playback')return keysOnly(args,Object.keys(playbackProperties))&&playbackArgs(args)?{...args}:null;
  if(name==='tysl_camera_snapshot')return keysOnly(args,['cameraId','quality','maxWidth'])&&validCameraId(args.cameraId)&&(!own(args,'quality')||['main','sub'].includes(args.quality))&&(!own(args,'maxWidth')||numberRange(args.maxWidth,320,1920))?{...args}:null;
  if(name==='tysl_camera_capture_start'){
    if(!keysOnly(args,[...Object.keys(playbackProperties),'mode','kind','durationSeconds','fps','maxWidth','quality'])||!validCameraId(args.cameraId)||!numberRange(args.durationSeconds,1,(args.kind??'frames')==='video'?600:3600)||!['live','playback'].includes(args.mode??'live')||!['frames','video'].includes(args.kind??'frames')||own(args,'fps')&&!numberRange(args.fps,0.1,5,false)||own(args,'maxWidth')&&!numberRange(args.maxWidth,320,1920)||own(args,'quality')&&!['main','sub'].includes(args.quality)||(args.kind??'frames')==='frames'&&Math.ceil(args.durationSeconds*(args.fps??1))>1800)return null;
    if((args.mode??'live')==='playback'&&!playbackArgs(args))return null;
    if((args.mode??'live')==='live'&&['source','date','recordId','startTime','endTime'].some(key=>own(args,key)))return null;
    return {...args};
  }
  if (name === 'tysl_camera_stop') return keysOnly(args, ['cameraId']) && (!own(args, 'cameraId') || validCameraId(args.cameraId)) ? {...args} : null;
  if (name === 'tysl_camera_preview') {
    if (!keysOnly(args, ['cameraId', 'quality']) || !own(args, 'cameraId') || !validCameraId(args.cameraId) || (own(args, 'quality') && !['main', 'sub'].includes(args.quality))) return null;
    return {...args};
  }
  if (name === 'tysl_camera_ptz') {
    if (!keysOnly(args, ['cameraId', 'direction', 'durationMs', 'speed']) || !own(args, 'cameraId') || !own(args, 'direction') || !validCameraId(args.cameraId) || !['up', 'down', 'left', 'right'].includes(args.direction)) return null;
    const durationMs = own(args, 'durationMs') ? args.durationMs : 350;
    const speed = own(args, 'speed') ? args.speed : 2;
    if (!Number.isInteger(durationMs) || durationMs < 200 || durationMs > 1000 || !Number.isInteger(speed) || speed < 1 || speed > 5) return null;
    return {cameraId: args.cameraId, direction: args.direction, durationMs, speed};
  }
  return null;
}

function safeCloudText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[地址已隐藏]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, '[令牌已隐藏]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .slice(0, 240);
}

export async function handleMcpMessage(message, runtime) {
  if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method.length || (own(message, 'id') && message.id !== null && typeof message.id !== 'string' && (typeof message.id !== 'number' || !Number.isFinite(message.id)))) return rpcError(null, -32600, 'Invalid Request');
  // Notifications, including unknown notifications, never execute tools or reply.
  if (!own(message, 'id')) return {status: 202, body: null};
  const id = message.id;
  if (own(message, 'params') && !record(message.params)) return rpcError(id, -32602, 'Invalid params');
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize':
      if (typeof params.protocolVersion !== 'string' || !params.protocolVersion) return rpcError(id, -32602, 'Invalid params');
      return result(id, {
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'tysl-local', version: '0.2.0'},
        instructions: '这是本地天翼视联摄像头服务。先列摄像头；历史录像按北京时间日期查询后用片段ID回放。图片分析可snapshot或capture_start按时长/帧率启动，再capture_status分页获取本地图片路径，用图片读取工具分析，文件持久化且附SHA256。capturedAt是采集墙钟近似时间，历史拍摄时间请看sourceInfo。云台每次只执行短脉冲并停止。禁止输出凭据。'
      });
    case 'ping':
      return keysOnly(params, []) ? result(id, {}) : rpcError(id, -32602, 'Invalid params');
    case 'tools/list':
      return keysOnly(params, []) ? result(id, {tools: TOOLS}) : rpcError(id, -32602, 'Invalid params');
    case 'tools/call': {
      if (!keysOnly(params, ['name', 'arguments']) || typeof params.name !== 'string' || !TOOLS.some(tool => tool.name === params.name)) return rpcError(id, -32602, 'Unknown tool or invalid params');
      const args = toolArgs(params.name, params.arguments);
      if (args === null) return rpcError(id, -32602, 'Invalid tool arguments');
      try {
        const value = params.name === 'tysl_camera_status' ? await runtime.status() : await runtime.action(ACTIONS[params.name], args);
        if (!record(value)) throw new Error('Invalid runtime result');
        return result(id, toolResult(value));
      } catch (error) {
        const value = error instanceof CloudError ? {code: safeCloudText(error.code), message: safeCloudText(error.message)} : {code: 'LOCAL_ERROR', message: '本地操作未完成，请检查控制台状态。'};
        return result(id, toolResult(value, true));
      }
    }
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}
