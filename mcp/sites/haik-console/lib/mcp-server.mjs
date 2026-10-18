import { CAMERA_TOOLS, callCameraTool, validateTool } from './mcp-tools.mjs';
import {CAMERA_SERVER_INSTRUCTIONS,listSkillResources,readSkillResource} from './mcp-skill.mjs';
const response = (id, result) => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
const failure = (id, code, message, status = 200) => ({ status, body: { jsonrpc: '2.0', id, error: { code, message } } });
export const parseFailure = () => failure(null, -32700, 'Parse error', 400);
export async function handleMcpMessage(message, getContext) {
  const validId = value => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string' || ('id' in message && !validId(message.id)) ||
      ('params' in message && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)))) {
    return failure(null, -32600, 'Invalid request', 400);
  }
  if (!Object.hasOwn(message, 'id')) return { status: 202, body: null };
  const id = message.id;
  if (message.method === 'initialize') {
    const supported = ['2025-06-18', '2025-03-26', '2024-11-05'];
    const version = message.params?.protocolVersion;
    return response(id, { protocolVersion: supported.includes(version) ? version : supported[0],
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: 'haik-local', version: '1.3.0' },instructions:CAMERA_SERVER_INSTRUCTIONS });
  }
  if (message.method === 'ping') return response(id, {});
  if (message.method === 'tools/list') return response(id, { tools: CAMERA_TOOLS });
  if(message.method==='resources/list'||message.method==='resources/templates/list'){
    const params=message.params||{};
    if(Object.keys(params).some(key=>!['cursor','_meta'].includes(key))||params.cursor!==undefined)return failure(id,-32602,'This resource list has no pagination cursor');
    return response(id,message.method==='resources/list'?{resources:listSkillResources()}:{resourceTemplates:[]});
  }
  if(message.method==='resources/read'){
    const params=message.params||{};
    if(typeof params.uri!=='string'||Object.keys(params).some(key=>!['uri','_meta'].includes(key)))return failure(id,-32602,'Expected a resource URI');
    const resource=readSkillResource(params.uri);
    return resource?response(id,{contents:[resource]}):failure(id,-32002,'Resource not found');
  }
  if (message.method !== 'tools/call') return failure(id, -32601, 'Method not found');
  const args = Object.hasOwn(message.params || {}, 'arguments') ? message.params.arguments : {};
  try { validateTool(message.params?.name, args); }
  catch (error) { return failure(id, -32602, error.message); }
  try { return response(id, await callCameraTool(message.params.name, args, message.params.name==='camera_usage_guide'?undefined:await getContext())); }
  catch (error) {
    const detail = { code: error.code || 'LOCAL_SERVICE_ERROR',
      message: error.code ? error.message : '本地服务请求未完成，请稍后重试',
      ...(error.details ? { details: error.details } : {}) };
    return response(id, { isError: true, content: [{ type: 'text', text: JSON.stringify(detail) }], structuredContent: detail });
  }
}
