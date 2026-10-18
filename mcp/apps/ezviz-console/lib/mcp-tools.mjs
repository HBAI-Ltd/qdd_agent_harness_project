import {CAMERA_GUIDE_TOOL,cameraUsageGuide} from './mcp-skill.mjs';
import {MEDIA_TOOLS,MEDIA_TOOL_ACTIONS,validateMediaCombination} from './media-tools.mjs';
export const CAMERA_TOOLS=[
 CAMERA_GUIDE_TOOL,...MEDIA_TOOLS,
 {name:'ezviz_camera_status',description:'查看账号会话状态；不代表实时画面可用。通常仅在登录/连接问题时调用。首次使用先读 ezviz_usage_guide。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}},
 {name:'ezviz_camera_list',description:'取得当前账号的真实摄像头 ID 与在线状态；一次选定后复用，不要每秒查列表或猜 ID。online 不证明实时画面可用。首次使用先读 ezviz_usage_guide。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:true}},
 {name:'ezviz_camera_preview',description:'打开本机HLS预览并返回本地网页地址。播放依赖设备在线、未加密、取流权限和解码能力；URL不是画面。观察时优先用ezviz_camera_snapshot或持久采集获取实际文件。先读ezviz_usage_guide。',inputSchema:{type:'object',properties:{cameraId:{type:'string'},quality:{type:'integer',enum:[1,2]}},required:['cameraId'],additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:false,openWorldHint:true}},
 {name:'ezviz_camera_ptz',description:'用于用户已请求的云台移动/环绕；同一摄像头串行短步，默认 300ms、速度 1（0慢、1中、2快）。只有停止已确认才继续；错误 details.stopped=true 仅说明停止成功。不要自动重放超时动作或循环重试 20032。无角度反馈，不能据此声称覆盖 360°。先读 ezviz_usage_guide。',inputSchema:{type:'object',properties:{cameraId:{type:'string'},direction:{type:'string',enum:['up','down','left','right','up_left','down_left','up_right','down_right','zoom_in','zoom_out']},durationMs:{type:'integer',minimum:100,maximum:1000,default:300},speed:{type:'integer',minimum:0,maximum:2,default:1}},required:['cameraId','direction'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
 {name:'ezviz_camera_stop',description:'停止未确认时优先调用，显式传入真实最近方向。省略方向仅在本机移动历史存在时有效。服务端有限重试；harness 最多再补试一次，仍未确认则停止后续移动并请用户检查原 App。只有 stopped=true 表示停止已确认。先读 ezviz_usage_guide。',inputSchema:{type:'object',properties:{cameraId:{type:'string'},direction:{type:'string',enum:['up','down','left','right','up_left','down_left','up_right','down_right','zoom_in','zoom_out']}},required:['cameraId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}}
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
 switch(name){case'ezviz_usage_guide':return cameraUsageGuide(args);case'ezviz_camera_status':result=await context.connectionStatus();break;case'ezviz_camera_list':result={cameras:await context.cloud.listCameras()};break;case'ezviz_camera_preview':result=await context.action('preview',{cameraId:args.cameraId,quality:args.quality??2});break;case'ezviz_camera_ptz':result=await context.move(args.cameraId,args.direction,args.durationMs??300,args.speed??1);break;case'ezviz_camera_stop':result=await (context.stop?context.stop(args.cameraId,args.direction):context.cloud.stop(args.cameraId,args.direction));break;}
 return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
}
