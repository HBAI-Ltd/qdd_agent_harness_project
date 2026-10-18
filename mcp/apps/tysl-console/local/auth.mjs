import {randomBytes, randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import {TyslCloud, CloudError} from '../lib/cloud.mjs';
import {readVault, writeVault} from './vault.mjs';

const STATE_TTL = 10 * 60 * 1000;
const OFFICIAL_RETURN_URL = 'https://active1-e.ctseelink.cn';
const LOGIN_HOST = 'open.e.189.cn';
const LOGIN_PATH = '/api/logbox/oauth2/separate/unifyAccountLogin.do';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = value => (typeof value === 'string' && value.trim().length > 0) || (typeof value === 'number' && Number.isFinite(value));
const validToken = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 65536 && !/[\r\n]/.test(value);

function candidateFrom(value) {
  if (!record(value) || !validToken(value.token)) throw new CloudError('LOGIN_TOKEN_MISSING', '授权结果没有有效的登录令牌', 502);
  if (!Array.isArray(value.roleInfos) || value.roleInfos.length === 0) throw new CloudError('ROLE_INFO_MISSING', '授权已加密暂存，但官方未返回完整账号角色；当前账号未替换，请保留服务并确认授权结果', 409);
  if (!value.roleInfos.every(role => record(role) && present(role.id) && present(role.roleId) && typeof role.roleName === 'string' && present(role.roleType))) throw new CloudError('ROLE_INFO_INVALID', '授权已暂存，但角色信息不完整，无法确定账号角色', 409);
  const candidate = {...value, roleInfos: value.roleInfos.map(role => ({...role}))};
  if (typeof candidate.phone === 'string') candidate.phone = candidate.phone.replace(/^(?:\+?86)?(\d{3})\d{4}(\d{4})$/, '$1****$2');
  return candidate;
}

function tokenExpiry(token) {
  const parts = token.replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return record(payload) && typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

function officialLoginUrl(value) {
  const raw = typeof value === 'string' ? value : '';
  let url;
  try { url = new URL(raw); } catch { throw new CloudError('LOGIN_URL_INVALID', '云端未返回有效的官方授权地址'); }
  if (url.protocol !== 'https:' || url.hostname !== LOGIN_HOST || url.pathname !== LOGIN_PATH || url.hash || url.username || url.password || (url.port && url.port !== '443')) throw new CloudError('LOGIN_URL_INVALID', '云端授权地址不是已确认的 HTTPS 官方登录地址');
  return url.href;
}

export function callbackParas(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16000 || /[\u0000-\u0020\u007f]/.test(value) || !/^https:\/\/active1-e\.ctseelink\.cn\/?\?/.test(value)) throw new CloudError('LOGIN_CALLBACK_INVALID', '请粘贴官方登录完成后的完整返回地址', 400);
  let url;
  try { url = new URL(value); } catch { throw new CloudError('LOGIN_CALLBACK_INVALID', '返回地址格式无效', 400); }
  if (url.origin !== OFFICIAL_RETURN_URL || url.pathname !== '/' || url.hash || url.username || url.password) throw new CloudError('LOGIN_CALLBACK_INVALID', '仅接受官方指定返回页面的 HTTPS 完整地址', 400);
  if (url.searchParams.getAll('paras').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'paras')) throw new CloudError('LOGIN_CALLBACK_INVALID', '返回地址必须包含唯一的 paras 授权参数', 400);
  const paras = url.searchParams.get('paras');
  if (!paras || paras.length > 12000 || /[\u0000-\u0020\u007f]/.test(paras)) throw new CloudError('LOGIN_PARAS_INVALID', '返回地址中的授权参数无效', 400);
  return paras;
}

export class AuthManager {
  #vault;
  #pendingVault;
  #createCloud;
  #readVault;
  #writeVault;
  #unlink;
  #now;
  #states = new Map();
  #refresh = null;
  #finishing = false;
  #writes = Promise.resolve();

  constructor({vault, pendingVault, baseUrl}, dependencies = {}) {
    if (typeof vault !== 'string' || !isAbsolute(vault) || typeof pendingVault !== 'string' || !isAbsolute(pendingVault) || resolve(vault).toLowerCase() === resolve(pendingVault).toLowerCase()) throw new CloudError('AUTH_CONFIG_INVALID', '登录凭据与暂存凭据必须使用不同的绝对文件路径', 500);
    let callbackBase;
    try { callbackBase = new URL(baseUrl); } catch { throw new CloudError('AUTH_CONFIG_INVALID', '本地登录回调地址配置无效', 500); }
    if (!['http:', 'https:'].includes(callbackBase.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(callbackBase.hostname) || callbackBase.username || callbackBase.password || callbackBase.search || callbackBase.hash || callbackBase.pathname !== '/') throw new CloudError('AUTH_CONFIG_INVALID', '登录回调必须使用本地回环服务地址', 500);
    this.#vault = resolve(vault);
    this.#pendingVault = resolve(pendingVault);
    this.#createCloud = dependencies.createCloud || (options => new TyslCloud(options));
    this.#readVault = dependencies.readVault || readVault;
    this.#writeVault = dependencies.writeVault || writeVault;
    this.#unlink = dependencies.unlink || unlink;
    this.#now = dependencies.now || Date.now;
    this.login = null;
    this.pending = null;
  }

  async init() {
    let active;
    try { active = await this.#readVault(this.#vault); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw new CloudError('VAULT_READ_FAILED', '无法解密现有登录凭据，请使用原 Windows 账号运行或重新登录', 500);
    }
    if (active !== undefined) {
      if (!record(active) || active.version !== 1 || !record(active.login)) throw new CloudError('VAULT_INVALID', '现有登录凭据格式无效', 500);
      this.login = candidateFrom(active.login);
    }
    let pending;
    try { pending = await this.#readVault(this.#pendingVault); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw new CloudError('PENDING_VAULT_READ_FAILED', '无法解密暂存的授权结果，请使用原 Windows 账号运行', 500);
    }
    if (pending !== undefined) {
      if (!record(pending) || pending.version !== 1 || !record(pending.login)) throw new CloudError('PENDING_VAULT_INVALID', '暂存授权结果格式无效', 500);
      // A pending login, including an incomplete result, never replaces the active account.
      this.pending = pending.login;
    }
    return this;
  }

  async begin() {
    if (this.#finishing) throw new CloudError('LOGIN_BUSY', '上一份授权正在保存，请稍后再发起登录', 409);
    const now = this.#now();
    // One local flow at a time; no state or return URL is sent to another host.
    this.#states.clear();
    const state = randomBytes(16).toString('hex');
    this.#states.set(state, now + STATE_TTL);
    try {
      const value = await this.#createCloud().post('/user-center/thirdParty/getTyWebLoginUrl', {returnUrl: OFFICIAL_RETURN_URL});
      return {url: officialLoginUrl(value), state, expiresIn: STATE_TTL / 1000};
    } catch (error) {
      this.#states.delete(state);
      if (error instanceof CloudError) throw error;
      throw new CloudError('LOGIN_BEGIN_FAILED', '无法创建天翼账号授权，请稍后重试');
    }
  }

  async finish(state, callbackUrl) {
    if (this.#finishing) throw new CloudError('LOGIN_BUSY', '授权正在交换与保存，请勿重复提交', 409);
    const expires = typeof state === 'string' ? this.#states.get(state) : undefined;
    if (!expires || expires <= this.#now()) {
      if (typeof state === 'string') this.#states.delete(state);
      throw new CloudError('LOGIN_STATE_INVALID', '登录回调已失效或已使用，请重新发起授权', 400);
    }
    const paras = callbackParas(callbackUrl);
    this.#states.delete(state);
    this.#finishing = true;
    try {
      let value;
      try {
        const response = await this.#createCloud().post('/user-center/thirdParty/getAccessTokenByParas', {paras, platformType: 'tianyi', loginType: 0, deviceId: randomUUID()}, {envelope: true});
        value = record(response?.data) && validToken(response.data.token) ? response.data : response;
      } catch (error) {
        if (error instanceof CloudError) throw error;
        throw new CloudError('LOGIN_EXCHANGE_FAILED', '天翼账号授权交换失败，请重新发起授权');
      }
      // Empty/malformed success envelopes must not create an unreadable pending vault.
      if (!record(value) || !validToken(value.token)) throw new CloudError('LOGIN_TOKEN_MISSING', '官方授权结果没有有效令牌；当前账号未替换', 502);
      // Persist the single-use token before checking roles or accepting the account.
      this.pending = value;
      try { await this.#writeVault(this.#pendingVault, {version: 1, createdAt: new Date().toISOString(), login: value}); }
      catch { throw new CloudError('PENDING_VAULT_WRITE_FAILED', '授权结果仍在内存中，但无法加密暂存；请勿关闭本地服务', 500); }
      const candidate = candidateFrom(value);
      this.pending = candidate;
      return candidate;
    } finally { this.#finishing = false; }
  }

  async accept(candidate) { return this.#save(candidate); }

  #save(candidate, expected) {
    const validated = candidateFrom(candidate);
    const operation = this.#writes.then(async () => {
      if (expected !== undefined && this.login !== expected) return this.login;
      try { await this.#writeVault(this.#vault, {version: 1, createdAt: new Date().toISOString(), login: validated}); }
      catch { throw new CloudError('VAULT_WRITE_FAILED', '无法加密保存登录凭据，当前登录未被替换', 500); }
      this.login = validated;
      // A refresh must not erase a different account waiting for explicit acceptance.
      if (expected === undefined || this.pending?.token === candidate.token) {
        try { await this.#unlink(this.#pendingVault); }
        catch (error) {
          if (error?.code !== 'ENOENT') throw new CloudError('PENDING_VAULT_DELETE_FAILED', '登录已保存，但暂存授权文件尚未清理', 500);
        }
        this.pending = null;
      }
      return this.login;
    });
    this.#writes = operation.catch(() => {});
    return operation;
  }

  async ensureFresh() {
    if (this.#refresh) return this.#refresh;
    const current = this.login;
    if (!current) return null;
    const expires = tokenExpiry(current.token);
    if (expires === null || expires > this.#now() + 120000) return current;
    if (!validToken(current.refreshToken)) throw new CloudError('LOGIN_EXPIRED', '登录即将过期且没有刷新凭据，请重新登录', 401);
    const operation = (async () => {
      let value;
      try { value = await this.#createCloud({token: current.token, role: current.roleInfos[0]}).post('/user-center/refreshToken', {token: current.token, refreshToken: current.refreshToken}); }
      catch (error) {
        if (error instanceof CloudError) throw error;
        throw new CloudError('TOKEN_REFRESH_FAILED', '登录刷新失败，请重新登录', 401);
      }
      if (!record(value) || !validToken(value.token)) throw new CloudError('TOKEN_REFRESH_INVALID', '云端没有返回有效的新登录令牌', 502);
      const newExpiry = tokenExpiry(value.token);
      if (newExpiry !== null && newExpiry <= this.#now()) throw new CloudError('TOKEN_REFRESH_INVALID', '云端返回的新登录令牌已经过期', 502);
      const merged = {...current, ...value};
      if (value.refreshToken === undefined) merged.refreshToken = current.refreshToken;
      if (value.roleInfos === undefined) merged.roleInfos = current.roleInfos;
      return this.#save(merged, current);
    })();
    this.#refresh = operation;
    try { return await operation; }
    finally { if (this.#refresh === operation) this.#refresh = null; }
  }
}
