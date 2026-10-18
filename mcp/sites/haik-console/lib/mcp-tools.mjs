import {CAMERA_GUIDE_TOOL,cameraUsageGuide} from './mcp-skill.mjs';
import {MEDIA_TOOLS,MEDIA_TOOL_ACTIONS,validateMediaCombination} from './media-tools.mjs';
export const CAMERA_TOOLS=[
 CAMERA_GUIDE_TOOL,...MEDIA_TOOLS,
 {name:'camera_connection_status',description:'查看账号会话状态；不代表实时画面可用。通常仅在登录/连接问题时调用。首次使用先读 camera_usage_guide。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}},
 {name:'list_cameras',description:'取得当前账号的真实摄像头 ID 与在线状态；一次选定后复用，不要每秒查列表或猜 ID。online 不证明实时画面可用。首次使用先读 camera_usage_guide。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
 {name:'get_live_stream',description:'获取约 300 秒有效的 HTTPS FLV 地址（H.264/H.265），每次采集复用一个地址。直接解码并按 1fps 保存实际帧后分析；禁止用 computer use/浏览器截图读取摄像头数据。URL 不是画面，勿公开签名地址。先读 camera_usage_guide。',inputSchema:{type:'object',properties:{cameraId:{type:'string'},quality:{type:'integer',enum:[1,2]}},required:['cameraId'],additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:false,openWorldHint:true}},
 {name:'move_camera',description:'用于用户已请求的云台移动/环绕；同一摄像头串行短步，默认 300ms、速度 2。只有停止已确认才继续；错误 details.stopped=true 仅说明停止成功。不要自动重放超时动作或循环重试 20032。无角度反馈，不能据此声称覆盖 360°。先读 camera_usage_guide。',inputSchema:{type:'object',properties:{cameraId:{type:'string'},direction:{type:'string',enum:['up','down','left','right','up_left','down_left','up_right','down_right','zoom_in','zoom_out']},durationMs:{type:'integer',minimum:100,maximum:1000,default:300},speed:{type:'integer',minimum:1,maximum:5,default:2}},required:['cameraId','direction'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
 {name:'stop_camera',description:'停止未确认时优先调用，显式传入真实最近方向。省略方向仅在本机移动历史存在时有效。服务端有限重试；harness 最多再补试一次，仍未确认则停止后续移动并请用户检查原 App。只有 stopped=true 表示停止已确认。先读 camera_usage_guide。',inputSchema:{type:'object',properties:{cameraId:{type:'string'},direction:{type:'string',enum:['up','down','left','right','up_left','down_left','up_right','down_right','zoom_in','zoom_out']}},required:['cameraId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}}
];
export function validateTool(name,args={}){
 const tool=CAMERA_TOOLS.find(t=>t.name===name);if(!tool)throw new Error('未知工具');
 if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('参数必须为对象');
 for(const k of Object.keys(args))if(!Object.hasOwn(tool.inputSchema.properties,k))throw new Error('不支持的参数：'+k);
 for(const k of tool.inputSchema.required||[])if(!(k in args))throw new Error('缺少参数：'+k);
 for(const [k,v]of Object.entries(args)){const s=tool.inputSchema.properties[k];if(s.type==='string'&&(typeof v!=='string'||v.length<(s.minLength??1)||v.length>(s.maxLength??128)||(s.pattern&&!new RegExp(s.pattern).test(v))))throw new Error('字符串参数无效：'+k);if(['integer','number'].includes(s.type)&&((s.type==='integer'?!Number.isInteger(v):!Number.isFinite(v))||(s.minimum!==undefined&&v<s.minimum)||(s.maximum!==undefined&&v>s.maximum)))throw new Error('数值参数无效：'+k);if(s.enum&&!s.enum.includes(v))throw new Error('枚举参数无效：'+k);}
 validateMediaCombination(name,args);
 return tool;
}
export async function callCameraTool(name,args,context){
 validateTool(name,args);let result;
 if(Object.hasOwn(MEDIA_TOOL_ACTIONS,name)){result=await context.action(MEDIA_TOOL_ACTIONS[name],args);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
 switch(name){case'camera_usage_guide':return cameraUsageGuide(args);case'camera_connection_status':result=await context.connectionStatus();break;case'list_cameras':result={cameras:await context.cloud.listCameras()};break;case'get_live_stream':result=await context.cloud.live(args.cameraId,args.quality??2);break;case'move_camera':result=await context.move(args.cameraId,args.direction,args.durationMs??300,args.speed??2);break;case'stop_camera':result=await (context.stop?context.stop(args.cameraId,args.direction):context.cloud.stop(args.cameraId,args.direction));break;}
 return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
}
