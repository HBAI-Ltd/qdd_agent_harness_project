<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElAlert } from "element-plus/es/components/alert/index";
import { ElButton } from "element-plus/es/components/button/index";
import { ElInput } from "element-plus/es/components/input/index";
import { ElSwitch } from "element-plus/es/components/switch/index";
import { ElTag } from "element-plus/es/components/tag/index";
import type { BrowserInput, BrowserSessionState } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";
import { createBrowserViewer, emptyBrowserViewer, frameCoordinates } from "./browserSession";

const props = defineProps<{ browser: BrowserSessionState; sessionId: string }>();
const emit = defineEmits<{ close: [] }>();
const { workspace } = useWorkspaceContext();
const state = reactive(emptyBrowserViewer());
const viewer = createBrowserViewer(state, () => ({ base: workspace.gatewayUrl.value, token: workspace.token.value }));
const image = ref<HTMLImageElement>();
const displayedFrame = ref(0);
const address = ref("");
const text = ref("");
const pressedButtons = new Set<number>();
let unmounted = false;
let pageActive = true;
let pausedForVisibility = false;
const source = computed(() => state.frame ? `data:image/jpeg;base64,${state.frame.data}` : "");
const canPoint = computed(() => state.manual && state.online && !!state.frame && displayedFrame.value === state.frame.sequence);
const canControl = computed(() => canPoint.value && !state.inputBusy);
const canType = computed(() => state.manual && state.online && !!state.frame && state.frame.tabId === state.session?.tabId);
const modifiers = (event: MouseEvent | WheelEvent | KeyboardEvent): ("Alt" | "Control" | "Meta" | "Shift")[] => {
  const result: ("Alt" | "Control" | "Meta" | "Shift")[] = [];
  if (event.altKey) result.push("Alt");
  if (event.ctrlKey) result.push("Control");
  if (event.metaKey) result.push("Meta");
  if (event.shiftKey) result.push("Shift");
  return result;
};
watch(() => state.session?.url, (url) => { address.value = url ?? ""; });
watch(() => state.frame?.sequence, () => {
  displayedFrame.value = image.value?.complete && image.value.currentSrc === source.value && image.value.naturalWidth > 0
    ? state.frame?.sequence ?? 0 : 0;
});
watch([() => props.sessionId, () => props.browser.browserSessionId, workspace.gatewayUrl, workspace.token], () => {
  text.value = "";
  startWatching();
}, { immediate: true });
watch(() => props.browser.status, (status) => {
  if (status === "closed") {
    pausedForVisibility = false;
    viewer.stop();
    state.session = props.browser;
  }
});

watch(() => state.manual, (manual) => { if (!manual) pressedButtons.clear(); }, { flush: "sync" });

function loadedFrame(event: Event) {
  if (event.target instanceof HTMLImageElement && event.target.currentSrc === source.value) displayedFrame.value = state.frame?.sequence ?? 0;
}
function point(event: MouseEvent | WheelEvent) {
  if (!canPoint.value || !image.value || !state.frame) return;
  return frameCoordinates(event.clientX, event.clientY, image.value.getBoundingClientRect(), state.frame);
}
function mouse(event: MouseEvent, kind: "move" | "down" | "up") {
  if (kind !== "move" && ![0, 1, 2].includes(event.button)) return;
  if (kind === "move" && pressedButtons.size && event.buttons === 0) releasePointer();
  if (kind === "up" && !pressedButtons.has(event.button)) return;
  const coordinates = point(event);
  if (!coordinates) {
    if (kind === "up") releasePointer();
    return;
  }
  event.preventDefault();
  if (kind === "down") {
    pressedButtons.add(event.button);
    (event.currentTarget as HTMLElement).focus();
  } else if (kind === "up") pressedButtons.delete(event.button);
  // Down/up already produce browser click/dblclick events; never send an extra click.
  void viewer.queuePointer({
    type: "mouse", event: kind, ...coordinates,
    ...(kind !== "move" ? { button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left", clickCount: event.detail >= 2 ? 2 : 1 } : {}),
    modifiers: modifiers(event),
  });
}
function releasePointer() {
  const shouldRelease = state.manual || pressedButtons.size > 0;
  pressedButtons.clear();
  if (shouldRelease) viewer.releaseInput();
}
function wheel(event: WheelEvent) {
  const coordinates = point(event);
  if (!coordinates) return;
  event.preventDefault();
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
  void viewer.queuePointer({ type: "wheel", ...coordinates, deltaX: Math.max(-10000, Math.min(10000, event.deltaX * factor)), deltaY: Math.max(-10000, Math.min(10000, event.deltaY * factor)), modifiers: modifiers(event) });
}
function key(event: KeyboardEvent) {
  if (!canType.value || event.isComposing || ["Control", "Alt", "Meta", "Shift", "Dead", "Process", "Unidentified"].includes(event.key)) return;
  event.stopPropagation();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
  event.preventDefault();
  const mods = modifiers(event);
  if ([...event.key].length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) void viewer.queueKeyboard({ type: "text", text: event.key });
  else void viewer.queueKeyboard({ type: "key", key: event.key === " " ? "Space" : event.key, event: "press", modifiers: mods });
}
function compose(event: CompositionEvent) {
  if (canType.value && event.data) void viewer.queueKeyboard({ type: "text", text: event.data.slice(0, 20000) });
}
function paste(event: ClipboardEvent) {
  if (!canType.value) return;
  const value = event.clipboardData?.getData("text/plain");
  if (!value) return;
  event.preventDefault();
  event.stopPropagation();
  void viewer.queueKeyboard({ type: "text", text: value.slice(0, 20000) });
}
async function sendText() {
  const value = text.value;
  if (value && await viewer.input({ type: "text", text: value })) text.value = "";
}
function navigate() {
  let url: URL;
  try { url = new URL(address.value.trim()); } catch { state.error = "请输入完整的 HTTP 或 HTTPS 地址。"; return; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    state.error = "只支持不含账号密码的 HTTP 或 HTTPS 地址。";
    return;
  }
  void viewer.input({ type: "navigate", url: url.href });
}
function command(type: "back" | "forward" | "reload") {
  void viewer.input({ type } as BrowserInput);
}
function startWatching() {
  if (unmounted) return;
  pausedForVisibility = false;
  if (!pageActive || document.visibilityState !== "visible") {
    viewer.stop();
    state.session = props.browser;
    pausedForVisibility = props.browser.status !== "closed";
    return;
  }
  void viewer.start(props.browser);
}
function blur() { viewer.setManual(false); }
function pagehide() { pageActive = false; visibility(); }
function pageshow() { pageActive = true; visibility(); }
function visibility() {
  if (unmounted) return;
  if (!pageActive || document.visibilityState !== "visible") {
    pausedForVisibility = props.browser.status !== "closed" && state.session?.status !== "closed";
    viewer.stop();
  } else if (pausedForVisibility) {
    pausedForVisibility = false;
    if (props.browser.status !== "closed" && state.session?.status !== "closed") startWatching();
  }
}
onMounted(() => {
  window.addEventListener("blur", blur);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", pageshow);
  document.addEventListener("visibilitychange", visibility);
});
onBeforeUnmount(() => {
  unmounted = true;
  pausedForVisibility = false;
  window.removeEventListener("blur", blur);
  window.removeEventListener("pagehide", pagehide);
  window.removeEventListener("pageshow", pageshow);
  document.removeEventListener("visibilitychange", visibility);
  viewer.stop();
});
</script>

<template>
  <section class="session-browser" aria-label="会话实时浏览器">
    <header class="browser-heading">
      <div><AgentIcon name="code" :size="18" /><strong>实时浏览器</strong><ElTag size="small" :type="state.manual ? 'warning' : 'info'">{{ state.session?.status === "closed" ? "已关闭" : state.manual ? "人工接管中" : "只读观看" }}</ElTag></div>
      <div><ElButton text circle aria-label="重新连接浏览器画面" title="重新连接画面" :disabled="state.connecting || state.session?.status === 'closed'" @click="startWatching"><AgentIcon name="refresh" :size="16" /></ElButton><ElButton text circle aria-label="关闭实时浏览器画面" @click="emit('close')"><AgentIcon name="close" :size="17" /></ElButton></div>
    </header>
    <div class="browser-control-mode">
      <span>{{ state.manual ? "你正在操作当前画面" : "开启人工接管后，可以在画面中点击和输入" }}</span>
      <ElSwitch :model-value="state.manual" :disabled="!state.manual && (!state.online || !state.frame || displayedFrame !== state.frame.sequence)" inline-prompt active-text="人工接管" inactive-text="只读观看" aria-label="人工接管浏览器" @change="viewer.setManual(Boolean($event))" />
    </div>
    <form class="browser-navigation" @submit.prevent="navigate">
      <ElButton text circle aria-label="浏览器后退" :disabled="!canControl || !state.session?.canGoBack" @click="command('back')"><AgentIcon class="browser-back" name="chevron" :size="15" /></ElButton>
      <ElButton text circle aria-label="浏览器前进" :disabled="!canControl || !state.session?.canGoForward" @click="command('forward')"><AgentIcon name="chevron" :size="15" /></ElButton>
      <ElButton text circle aria-label="刷新浏览器页面" :disabled="!canControl" @click="command('reload')"><AgentIcon name="refresh" :size="15" /></ElButton>
      <ElInput v-model="address" size="small" :readonly="!state.manual" :disabled="!state.online" :maxlength="2000" aria-label="浏览器地址" placeholder="https://example.com" />
      <ElButton size="small" native-type="submit" :disabled="!canControl">前往</ElButton>
    </form>
    <ElAlert v-if="state.error" :title="state.error" type="warning" :closable="false" show-icon class="browser-error" />
    <div
      class="browser-screen"
      :class="{ 'browser-screen-manual': state.manual }"
      :tabindex="state.manual ? 0 : -1"
      role="region"
      :aria-label="state.manual ? '浏览器操作画面，点击后可直接输入' : '浏览器只读实时画面'"
      @mousedown="mouse($event, 'down')"
      @mousemove="mouse($event, 'move')"
      @mouseup="mouse($event, 'up')"
      @mouseleave="releasePointer"
      @click.stop.prevent
      @dblclick.stop.prevent
      @contextmenu.prevent
      @auxclick.prevent
      @wheel="wheel"
      @keydown="key"
      @compositionend="compose"
      @paste="paste"
      @blur="releasePointer">
      <img v-if="source" ref="image" :src="source" :alt="state.session?.title || '浏览器实时画面'" draggable="false" @load="loadedFrame" @error="state.error = '无法显示浏览器画面，请重新连接。'" />
      <div v-else class="browser-placeholder">
        <AgentIcon name="code" :size="26" />
        <p>{{ state.session?.status === "closed" ? "此浏览器会话已关闭" : state.connecting ? "正在连接实时画面…" : state.online ? "等待浏览器画面…" : "实时画面已暂停" }}</p>
        <ElButton v-if="!state.connecting && !state.online && state.session?.status !== 'closed'" size="small" @click="startWatching">重新连接</ElButton>
      </div>
    </div>
    <footer class="browser-footer">
      <form class="browser-text" @submit.prevent="sendText"><ElInput v-model="text" size="small" :disabled="!canControl" :maxlength="20000" aria-label="向浏览器输入文本" placeholder="需要输入的文字（支持中文）" /><ElButton size="small" :disabled="!canControl || !text" native-type="submit">输入文本</ElButton></form>
      <p>{{ state.manual ? "在画面内点击、双击、拖动、滚动或按键；移出画面会释放输入，窗口失焦时会退出人工接管。" : "画面按当前会话隔离。只读模式不会向网页发送操作；返回此页面后自动恢复观看。" }}</p>
    </footer>
  </section>
</template>

<style scoped>
.session-browser { flex: 0 0 auto; min-width: 0; margin: 0 34px 14px; border: 1px solid var(--qdd-border); border-radius: 12px; overflow: hidden; background: var(--qdd-surface); }
.browser-heading, .browser-heading > div { display: flex; align-items: center; gap: 10px; }
.browser-heading { justify-content: space-between; padding: 9px 14px; border-bottom: 1px solid var(--qdd-border); }
.browser-heading strong { color: var(--qdd-text); font-size: 13px; font-weight: 600; }
.browser-heading svg { color: var(--qdd-muted); }
.browser-control-mode { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 14px; color: var(--qdd-muted); font-size: 12px; }
.browser-navigation { display: flex; align-items: center; gap: 5px; padding: 0 12px 10px; }
.browser-navigation :deep(.el-button) { flex: 0 0 auto; margin: 0; }
.browser-navigation :deep(.el-input) { flex: 1; min-width: 0; }
.browser-back { transform: rotate(180deg); }
.browser-error { margin: 0 12px 10px; width: auto; }
.browser-screen { position: relative; width: 100%; max-height: 46vh; overflow: auto; background: var(--qdd-bg); outline-offset: -2px; }
.browser-screen-manual { cursor: crosshair; }
.browser-screen img { display: block; width: 100%; height: auto; user-select: none; }
.browser-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 180px; padding: 28px; color: var(--qdd-muted); font-size: 13px; }
.browser-placeholder p { margin: 10px 0; }
.browser-footer { padding: 10px 14px; border-top: 1px solid var(--qdd-border); }
.browser-text { display: flex; gap: 8px; }
.browser-text :deep(.el-input) { flex: 1; min-width: 0; }
.browser-text :deep(.el-button) { flex: 0 0 auto; margin: 0; }
.browser-footer p { margin: 7px 0 0; color: var(--qdd-muted); font-size: 11px; }
@media (max-width: 760px) { .session-browser { margin-inline: 20px; } .browser-control-mode { flex-wrap: wrap; } }
@media (max-width: 460px) { .session-browser { margin-inline: 14px; } .browser-heading > div { flex-wrap: wrap; } }
</style>
