import { CloudError } from './hik-cloud.mjs';
import { validateTool } from './mcp-tools.mjs';
import {MEDIA_ACTIONS} from './media-tools.mjs';
export function validateAction(action, body) {
  const actions = { live: 'get_live_stream', move: 'move_camera', stop: 'stop_camera',...MEDIA_ACTIONS };
  if (Object.hasOwn(actions, action)) {
    const { action: ignored, ...args } = body;
    void ignored;
    try { validateTool(actions[action], args); }
    catch (error) { throw new CloudError('INVALID_ARGUMENT', error.message, 400); }
  }
  if (action === 'send_code' || action === 'login') {
    const allowed = action === 'send_code' ? ['action', 'phone', 'captchaVerifyParam'] : ['action', 'phone', 'code'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new CloudError('INVALID_ARGUMENT', '请求包含不支持的参数', 400);
    if (typeof body.phone !== 'string' || !/^1\d{10}$/.test(body.phone)) throw new CloudError('INVALID_PHONE', '请输入有效的 11 位手机号', 400);
    if (action === 'login' && (typeof body.code !== 'string' || !/^\d{4,8}$/.test(body.code))) throw new CloudError('INVALID_LOGIN', '请输入 4–8 位短信验证码', 400);
    if (action === 'send_code' && (typeof body.captchaVerifyParam !== 'string' || !body.captchaVerifyParam || body.captchaVerifyParam.length > 12000)) throw new CloudError('CAPTCHA_REQUIRED', '请先完成人机验证', 400);
  }
}
