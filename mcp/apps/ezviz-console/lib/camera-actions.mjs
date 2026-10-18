import {CloudError,validateCredentials} from './cloud.mjs';
import {validateTool} from './mcp-tools.mjs';
import {MEDIA_ACTIONS} from './media-tools.mjs';
export function validateAction(action,body){
 const map={live:'ezviz_camera_preview',move:'ezviz_camera_ptz',stop:'ezviz_camera_stop',...MEDIA_ACTIONS};
 if(Object.hasOwn(map,action)){const {action:ignored,...args}=body;try{validateTool(map[action],args);}catch(error){throw new CloudError('INVALID_ARGUMENT',error.message,400);}}
 if(action==='connect'){
  if(Object.keys(body).some(key=>!['action','appKey','appSecret'].includes(key)))throw new CloudError('INVALID_ARGUMENT','应用连接参数无效',400);
  validateCredentials(body.appKey,body.appSecret);
 }
}
