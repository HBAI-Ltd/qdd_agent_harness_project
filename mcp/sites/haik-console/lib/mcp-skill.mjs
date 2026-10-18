import {CAMERA_SKILL_MARKDOWN,CAMERA_CAPTURE_MARKDOWN,CAMERA_SURVEY_MARKDOWN,CAMERA_SURVEY_SCRIPT} from './mcp-skill-data.mjs';
export const CAMERA_SKILL_URI='haik://skills/haik-camera/SKILL.md';
export const CAMERA_CAPTURE_URI='haik://skills/haik-camera/references/capture.md';
export const CAMERA_SURVEY_URI='haik://skills/haik-camera/references/survey.md';
export const CAMERA_SURVEY_SCRIPT_URI='haik://skills/haik-camera/scripts/camera-survey.mjs';
export const CAMERA_SKILL_VERSION='1.2.0';
const resources=[
 {uri:CAMERA_SKILL_URI,name:'haik-camera-skill',title:'Haik camera operating skill',description:'Fast tool routing, saved-frame observations, PTZ stopping, and error recovery.',mimeType:'text/markdown',text:CAMERA_SKILL_MARKDOWN},
 {uri:CAMERA_CAPTURE_URI,name:'haik-camera-capture',title:'Local camera capture reference',description:'Persistent snapshot/capture jobs, file access, timestamps, decoder fallback, and remote artifact limits.',mimeType:'text/markdown',text:CAMERA_CAPTURE_MARKDOWN},
 {uri:CAMERA_SURVEY_URI,name:'haik-camera-survey',title:'海康云台调测与观察技巧',description:'Buffered-video settling, probe inspection, pan limits, fleet observations and bounded survey helper usage.',mimeType:'text/markdown',text:CAMERA_SURVEY_MARKDOWN},
 {uri:CAMERA_SURVEY_SCRIPT_URI,name:'haik-camera-survey-script',title:'Local MCP survey helper',description:'Optional JavaScript helper source; reading does not run it. Uses persistent local capture jobs and bounded serial movement.',mimeType:'text/javascript',text:CAMERA_SURVEY_SCRIPT},
];
export const CAMERA_SERVER_INSTRUCTIONS=`Read the built-in skill once per connection: resources/read ${CAMERA_SKILL_URI}, or camera_usage_guide {} for tools-only clients. For PTZ diagnosis/surveys read section=survey for the user's fleet tips, buffered-video settling and pan limits; section=survey-script returns optional helper source without running it. Use listed camera IDs; reuse one live URL per direct capture. Save directly decoded frames at 1 fps before analysis; never use computer use/browser screenshots to read camera data. Only move for user-requested PTZ/surrounding views. Move serially and require stopped:true (or error details.stopped:true) before another step. Prioritize explicit-direction stop after uncertain motion; do not replay timed-out movements or loop on 20032. Instructions guide the harness; server validation and stop gating remain enforced.`;
export const CAMERA_GUIDE_TOOL={name:'camera_usage_guide',description:'Read the Haik operating skill once. section=capture covers saved media; survey covers fleet tips, delayed frames and pan limits; survey-script returns optional helper source without executing it. Works without login or camera access.',inputSchema:{type:'object',properties:{section:{type:'string',enum:['skill','capture','survey','survey-script'],default:'skill'}},additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}};
export function listSkillResources(){return resources.map(({text,...metadata})=>{void text;return metadata;});}
export function readSkillResource(uri){const resource=resources.find(item=>item.uri===uri);return resource?{uri:resource.uri,mimeType:resource.mimeType,text:resource.text}:undefined;}
export function cameraUsageGuide({section='skill'}={}){
 const resource=readSkillResource(({skill:CAMERA_SKILL_URI,capture:CAMERA_CAPTURE_URI,survey:CAMERA_SURVEY_URI,'survey-script':CAMERA_SURVEY_SCRIPT_URI})[section]||CAMERA_SKILL_URI);
 return {content:[{type:'text',text:resource.text}],structuredContent:{name:'haik-camera',version:CAMERA_SKILL_VERSION,section,uri:resource.uri,mimeType:resource.mimeType}};
}
