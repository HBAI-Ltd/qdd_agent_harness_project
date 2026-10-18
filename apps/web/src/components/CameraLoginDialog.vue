<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ElAlert } from "element-plus/es/components/alert/index";
import { ElButton } from "element-plus/es/components/button/index";
import { ElDialog } from "element-plus/es/components/dialog/index";
import { ElForm, ElFormItem } from "element-plus/es/components/form/index";
import { ElInput } from "element-plus/es/components/input/index";
import * as api from "@/api/cameras";
import type { CameraProvider } from "@/api/cameras";

const props = defineProps<{ provider?: CameraProvider | undefined; gatewayUrl: string; token: string }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ connected: [] }>();

// 海康 App 使用的阿里云验证码 2.0 场景（与 HAIK 本地网页一致）
const CAPTCHA_SRC = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const CAPTCHA_SCENE = "lcrd581l";
const CAPTCHA_PREFIX = "1jgloq";

type CaptchaInstance = { destroy?: () => void };
type CaptchaWindow = Window & {
  AliyunCaptchaConfig?: { region: string; prefix: string };
  initAliyunCaptcha?: (options: Record<string, unknown>) => void;
};

const title = computed(() => (props.provider === "haik" ? "登录海康互联" : "登录天翼视联"));
const busy = ref(false);
const error = ref("");
const phone = ref("");
const code = ref("");
const cooldown = ref(0);
const captchaReady = ref(false);
const tyslState = ref("");
const tyslUrl = ref("");
const callbackUrl = ref("");
let controller: AbortController | undefined;
let captcha: CaptchaInstance | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let captchaLoad: Promise<void> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
let nativeController: AbortController | undefined;
let lifecycle = 0;
const HAIK_CONSOLE = "http://127.0.0.1:8787/";
const waitingNative = ref(false);

/** 兜底：滑块在本页被域名白名单拦截时，去海康自带的本地网页登录，这里轮询登录状态。 */
function openNativeConsole() {
  if (!open.value || props.provider !== "haik") return;
  window.open(HAIK_CONSOLE, "_blank", "noopener");
  waitingNative.value = true;
  error.value = "";
  clearInterval(poll);
  const version = lifecycle;
  poll = setInterval(async () => {
    if (nativeController) return;
    const request = new AbortController();
    nativeController = request;
    try {
      const list = await api.listCameraAccounts(props.gatewayUrl, props.token, request.signal);
      if (!isCurrent(version, "haik") || request.signal.aborted) return;
      if (list.find((entry) => entry.provider === "haik")?.connected) {
        clearInterval(poll);
        emit("connected");
        open.value = false;
      }
    } catch {
      // 网关暂不可用时继续等待
    } finally {
      if (nativeController === request) nativeController = undefined;
    }
  }, 3000);
}

function message(cause: unknown): string {
  return cause instanceof TypeError ? "无法连接网关，请检查连接后重试。" : cause instanceof Error ? cause.message : "请求失败，请稍后重试。";
}
function signal(): AbortSignal {
  controller?.abort();
  controller = new AbortController();
  return controller.signal;
}
function isCurrent(version: number, provider: CameraProvider): boolean {
  return version === lifecycle && open.value && props.provider === provider;
}
function requestIsCurrent(request: AbortSignal, version: number, provider: CameraProvider): boolean {
  return !request.aborted && controller?.signal === request && isCurrent(version, provider);
}
function startCooldown(seconds: number) {
  cooldown.value = seconds;
  clearInterval(timer);
  timer = setInterval(() => {
    cooldown.value = Math.max(0, cooldown.value - 1);
    if (!cooldown.value) clearInterval(timer);
  }, 1000);
}
function loadCaptcha(): Promise<void> {
  const w = window as CaptchaWindow;
  w.AliyunCaptchaConfig = { region: "cn", prefix: CAPTCHA_PREFIX };
  if (w.initAliyunCaptcha) return Promise.resolve();
  captchaLoad ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CAPTCHA_SRC;
    script.async = true;
    script.onload = () => (w.initAliyunCaptcha ? resolve() : reject(new Error("人机验证加载不完整，请重试")));
    script.onerror = () => {
      script.remove();
      reject(new Error("无法加载人机验证，请检查网络后重试"));
    };
    document.head.appendChild(script);
  }).catch((cause: unknown) => {
    captchaLoad = undefined;
    throw cause;
  });
  return captchaLoad;
}
/** 嵌入式滑块：点「获取验证码」触发，验证通过后直接发送短信。 */
async function mountCaptcha() {
  const version = lifecycle;
  captcha?.destroy?.();
  captcha = undefined;
  captchaReady.value = false;
  try {
    await loadCaptcha();
    await nextTick();
    if (!isCurrent(version, "haik")) return;
    (window as CaptchaWindow).initAliyunCaptcha!({
      SceneId: CAPTCHA_SCENE,
      mode: "popup",
      element: "#camera-captcha",
      button: "#camera-captcha-trigger",
      getInstance: (instance: CaptchaInstance) => {
        if (!isCurrent(version, "haik")) { instance.destroy?.(); return; }
        captcha = instance;
        captchaReady.value = true;
      },
      success: (param: unknown) => { if (isCurrent(version, "haik")) void sendCode(typeof param === "string" ? param : ""); },
      fail: () => { if (isCurrent(version, "haik")) error.value = "请完成人机验证后重试"; },
      onError: () => { if (isCurrent(version, "haik")) error.value = "人机验证暂不可用，请重试"; },
    });
  } catch (cause) {
    if (isCurrent(version, "haik")) error.value = message(cause);
  }
}
async function sendCode(param: string) {
  if (!open.value || props.provider !== "haik" || busy.value || cooldown.value) return;
  if (!param || !/^1\d{10}$/.test(phone.value.trim())) {
    error.value = param ? "请输入 11 位手机号后再获取验证码" : "人机验证未返回有效结果，请重试";
    void mountCaptcha();
    return;
  }
  error.value = "";
  busy.value = true;
  const version = lifecycle;
  const request = signal();
  try {
    await api.haikSendCode(props.gatewayUrl, props.token, phone.value.trim(), param, request);
    if (!requestIsCurrent(request, version, "haik")) return;
    startCooldown(60);
  } catch (cause) {
    if (requestIsCurrent(request, version, "haik")) error.value = message(cause);
  } finally {
    if (requestIsCurrent(request, version, "haik")) {
      busy.value = false;
      void mountCaptcha(); // 验证结果只能用一次，换一个新实例
    }
  }
}
async function haikLogin() {
  if (!open.value || props.provider !== "haik" || busy.value) return;
  if (!/^1\d{10}$/.test(phone.value.trim())) {
    error.value = "请输入 11 位手机号";
    return;
  }
  if (!/^\d{4,8}$/.test(code.value.trim())) {
    error.value = "请输入短信验证码";
    return;
  }
  busy.value = true;
  error.value = "";
  const version = lifecycle;
  const request = signal();
  try {
    await api.haikLogin(props.gatewayUrl, props.token, phone.value.trim(), code.value.trim(), request);
    if (!requestIsCurrent(request, version, "haik")) return;
    emit("connected");
    open.value = false;
  } catch (cause) {
    if (requestIsCurrent(request, version, "haik")) error.value = message(cause);
  } finally {
    if (requestIsCurrent(request, version, "haik")) busy.value = false;
  }
}
async function tyslStart() {
  if (!open.value || props.provider !== "tysl" || busy.value) return;
  busy.value = true;
  error.value = "";
  const version = lifecycle;
  const request = signal();
  try {
    const result = await api.tyslLoginStart(props.gatewayUrl, props.token, request);
    if (!requestIsCurrent(request, version, "tysl")) return;
    tyslState.value = result.state;
    tyslUrl.value = result.url;
    window.open(result.url, "_blank", "noopener");
  } catch (cause) {
    if (requestIsCurrent(request, version, "tysl")) error.value = message(cause);
  } finally {
    if (requestIsCurrent(request, version, "tysl")) busy.value = false;
  }
}
async function tyslComplete() {
  if (!open.value || props.provider !== "tysl" || busy.value) return;
  let callback: URL | undefined;
  try { callback = new URL(callbackUrl.value.trim()); } catch { /* Show validation below. */ }
  if (callback?.origin !== "https://active1-e.ctseelink.cn" || callback.username || callback.password) {
    error.value = "请粘贴官方登录完成后浏览器地址栏中的完整地址（以 https://active1-e.ctseelink.cn 开头）";
    return;
  }
  busy.value = true;
  error.value = "";
  const version = lifecycle;
  const request = signal();
  try {
    await api.tyslLoginComplete(props.gatewayUrl, props.token, tyslState.value, callbackUrl.value.trim(), request);
    if (!requestIsCurrent(request, version, "tysl")) return;
    emit("connected");
    open.value = false;
  } catch (cause) {
    if (requestIsCurrent(request, version, "tysl")) error.value = message(cause);
  } finally {
    if (requestIsCurrent(request, version, "tysl")) busy.value = false;
  }
}
function reset() {
  lifecycle++;
  controller?.abort();
  controller = undefined;
  nativeController?.abort();
  nativeController = undefined;
  captcha?.destroy?.();
  captcha = undefined;
  captchaReady.value = false;
  busy.value = false;
  error.value = "";
  code.value = "";
  phone.value = "";
  cooldown.value = 0;
  tyslState.value = "";
  tyslUrl.value = "";
  callbackUrl.value = "";
  waitingNative.value = false;
  clearInterval(poll);
  clearInterval(timer);
}
watch(() => [open.value, props.provider, props.gatewayUrl, props.token], () => {
  reset();
  if (open.value && props.provider === "haik") void mountCaptcha();
}, { immediate: true, flush: "sync" });
onBeforeUnmount(() => {
  reset();
  clearInterval(poll);
  clearInterval(timer);
});
</script>

<template>
  <ElDialog v-model="open" :title="title" width="min(520px, calc(100vw - 32px))" destroy-on-close>
    <ElAlert v-if="error" :title="error" type="error" show-icon :closable="false" />
    <template v-if="provider === 'haik'">
      <p class="camera-hint">使用海康互联 App 的手机号登录。登录状态由本机海康服务加密保存，网关不保存令牌。</p>
      <ElForm label-position="top" :disabled="busy" @submit.prevent="haikLogin">
        <ElFormItem label="手机号">
          <ElInput v-model="phone" maxlength="11" inputmode="numeric" autocomplete="tel" placeholder="11 位手机号" />
        </ElFormItem>
        <ElFormItem label="短信验证码">
          <div class="camera-code">
            <ElInput v-model="code" maxlength="8" inputmode="numeric" autocomplete="one-time-code" placeholder="验证码" />
            <ElButton id="camera-captcha-trigger" :disabled="!captchaReady || cooldown > 0 || busy">
              {{ cooldown ? `${cooldown} 秒后重发` : captchaReady ? "获取验证码" : "验证组件加载中" }}
            </ElButton>
          </div>
          <div id="camera-captcha" />
        </ElFormItem>
      </ElForm>
      <ElAlert
        :title="waitingNative ? '请在新打开的海康本地页面完成登录，完成后这里会自动刷新…' : '滑块验证加载失败或一直不通过？'"
        :type="waitingNative ? 'success' : 'warning'"
        :closable="false">
        <p class="camera-hint">
          验证码只允许在海康本机页面使用，请在运行海康服务的电脑上
          <ElButton link type="primary" @click="openNativeConsole">打开海康本地登录页</ElButton>
          ，点左下角「我的云端账号」登录。
        </p>
      </ElAlert>
    </template>
    <template v-else-if="provider === 'tysl'">
      <ol class="camera-steps">
        <li>点击「打开官方登录页」，用天翼视联账号的手机号和短信完成登录。</li>
        <li>登录完成后页面会跳转到 <code>active1-e.ctseelink.cn</code>，复制浏览器地址栏中的完整地址。</li>
        <li>粘贴到下方并提交（10 分钟内有效，不要发给他人）。</li>
      </ol>
      <ElButton type="primary" plain :loading="busy && !tyslState" @click="tyslStart">
        {{ tyslState ? "重新打开官方登录页" : "打开官方登录页" }}
      </ElButton>
      <p v-if="tyslUrl" class="camera-hint">
        浏览器未弹出新窗口？<a :href="tyslUrl" target="_blank" rel="noopener">点此打开</a>
      </p>
      <ElForm v-if="tyslState" label-position="top" :disabled="busy" class="camera-form" @submit.prevent="tyslComplete">
        <ElFormItem label="官方返回地址">
          <ElInput v-model="callbackUrl" type="textarea" :rows="3" placeholder="https://active1-e.ctseelink.cn/?paras=..." autocomplete="off" />
        </ElFormItem>
      </ElForm>
    </template>
    <template #footer>
      <ElButton :disabled="busy" @click="open = false">取消</ElButton>
      <ElButton v-if="provider === 'haik'" type="primary" :loading="busy" @click="haikLogin">登录</ElButton>
      <ElButton v-else type="primary" :loading="busy && !!tyslState" :disabled="!tyslState" @click="tyslComplete">完成登录</ElButton>
    </template>
  </ElDialog>
</template>

<style scoped>
.camera-hint {
  margin: 12px 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.camera-code {
  display: flex;
  gap: 8px;
  width: 100%;
}
.camera-steps {
  margin: 12px 0;
  padding-left: 20px;
  line-height: 1.8;
  font-size: 13px;
}
.camera-form {
  margin-top: 12px;
}
</style>
