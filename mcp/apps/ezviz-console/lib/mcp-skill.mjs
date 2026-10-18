import {readFileSync} from 'node:fs';
const base=new URL('../skills/ezviz-camera/',import.meta.url);
const resources=[
 {uri:'ezviz://skills/ezviz-camera/SKILL.md',name:'ezviz-camera-skill',title:'萤石本地摄像头操作说明',description:'应用配置、真实画面、录像和有界云台操作。',mimeType:'text/markdown',text:readFileSync(new URL('SKILL.md',base),'utf8')},
 {uri:'ezviz://skills/ezviz-camera/references/capture.md',name:'ezviz-camera-capture',title:'持久化采集参考',description:'截图、按时长和帧率保存图片、本地视频与任务恢复。',mimeType:'text/markdown',text:readFileSync(new URL('references/capture.md',base),'utf8')}
];
export const CAMERA_SERVER_INSTRUCTIONS='Read resources/read ezviz://skills/ezviz-camera/SKILL.md or ezviz_usage_guide {} once per connection. This is the independent local EZVIZ server at 8791. Use real listed IDs. Analyze directly saved frames via snapshot/capture, not browser screenshots. PTZ requires user intent, serial bounded pulses and confirmed stopping; do not replay uncertain starts. No real EZVIZ device has been validated yet. Encrypted streams require a separate EZOPEN decoder integration.';
export const CAMERA_GUIDE_TOOL={name:'ezviz_usage_guide',description:'读取萤石本地操作说明；section=capture提供持久采集、帧率、文件和时间信息。无需账号即可读取。',inputSchema:{type:'object',properties:{section:{type:'string',enum:['skill','capture'],default:'skill'}},additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}};
export function listSkillResources(){return resources.map(({text,...metadata})=>metadata);}
export function readSkillResource(uri){const resource=resources.find(row=>row.uri===uri);return resource?{uri:resource.uri,mimeType:resource.mimeType,text:resource.text}:undefined;}
export function cameraUsageGuide({section='skill'}={}){const resource=resources[section==='capture'?1:0];return {content:[{type:'text',text:resource.text}],structuredContent:{name:'ezviz-camera',version:'0.1.0',section,uri:resource.uri,mimeType:resource.mimeType}};}
