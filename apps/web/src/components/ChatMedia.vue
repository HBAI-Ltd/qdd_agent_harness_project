<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { downloadAttachment } from "@/api/workspace";
import type { MediaKind } from "@/utils/media";

const props = defineProps<{
  src?: string | undefined;
  attachmentId?: string | undefined;
  gatewayUrl?: string | undefined;
  token?: string | undefined;
  kind: MediaKind;
  label: string;
}>();
const source = ref("");
const active = ref(false);
const loading = ref(false);
const error = ref("");
const video = ref<HTMLVideoElement>();
const isImage = computed(() => props.kind === "image");
let version = 0;
let controller: AbortController | undefined;
let objectUrl = "";
let destroyPlayer: (() => void) | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;

function release() {
  version++;
  clearTimeout(timeout);
  controller?.abort();
  controller = undefined;
  destroyPlayer?.();
  destroyPlayer = undefined;
  if (video.value) {
    video.value.pause();
    video.value.removeAttribute("src");
    video.value.load();
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = "";
}

function fail(message: string) {
  release();
  loading.value = false;
  active.value = false;
  error.value = message;
}

function ready() {
  clearTimeout(timeout);
  loading.value = false;
}

watch(() => [props.src, props.attachmentId, props.gatewayUrl, props.token, props.kind], () => {
  release();
  source.value = props.src ?? "";
  active.value = isImage.value && !props.attachmentId;
  error.value = "";
  loading.value = false;
}, { immediate: true });
onBeforeUnmount(release);

async function start() {
  release();
  const current = version;
  error.value = "";
  loading.value = true;
  timeout = setTimeout(() => {
    if (current === version) fail("媒体加载超时，请检查网络或链接有效期后重试。");
  }, 20_000);
  try {
    if (props.attachmentId) {
      controller = new AbortController();
      const blob = await downloadAttachment(props.gatewayUrl ?? "", props.token ?? "", props.attachmentId, controller.signal);
      if (current !== version) return;
      objectUrl = URL.createObjectURL(blob);
      source.value = objectUrl;
    } else {
      source.value = props.src ?? "";
    }
    active.value = true;
    await nextTick();
    if (current !== version || isImage.value) return;
    const element = video.value;
    if (!element) throw new Error("播放器未就绪");
    if (props.kind === "hls" && !element.canPlayType("application/vnd.apple.mpegurl")) {
      const { default: Hls } = await import("hls.js");
      if (current !== version) return;
      if (!Hls.isSupported()) throw new Error("当前浏览器不支持 HLS 播放");
      const player = new Hls();
      destroyPlayer = () => player.destroy();
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && current === version) fail("HLS 播放失败，请检查链接、跨域权限和视频编码。");
      });
      player.loadSource(source.value);
      player.attachMedia(element);
    } else if (props.kind === "flv") {
      const { default: mpegts } = await import("mpegts.js");
      if (current !== version) return;
      if (!mpegts.isSupported()) throw new Error("当前浏览器不支持 FLV 播放");
      const player = mpegts.createPlayer({ type: "flv", url: source.value, isLive: !props.attachmentId }, { enableWorker: false });
      destroyPlayer = () => player.destroy();
      player.on(mpegts.Events.ERROR, () => {
        if (current === version) fail("FLV 播放失败，请检查链接、跨域权限和视频编码。");
      });
      player.attachMediaElement(element);
      player.load();
    } else {
      element.src = source.value;
    }
    await element.play();
  } catch (cause) {
    if (current !== version) return;
    if (cause instanceof Error && cause.name === "NotAllowedError") {
      ready();
      error.value = "浏览器阻止了播放，请点击视频控件中的播放按钮。";
    } else {
      fail(cause instanceof Error ? `媒体加载失败：${cause.message}` : "媒体加载失败，请重试。");
    }
  }
}
</script>

<template>
  <figure class="chat-media">
    <a v-if="isImage && active && !error" :href="source" target="_blank" rel="noopener noreferrer" :aria-label="`查看原图：${label}`">
      <img :src="source" :alt="label" loading="lazy" referrerpolicy="no-referrer" @load="ready" @error="fail('图片加载失败，请检查链接有效期或文件格式后重试。')" />
    </a>
    <video v-if="!isImage && active" ref="video" controls playsinline preload="none" :aria-label="label"
      @loadeddata="ready" @playing="ready" @error="fail('视频加载失败，请检查链接、跨域权限和视频编码。')"></video>
    <figcaption>
      <span>{{ label }}</span>
      <button v-if="!active" type="button" :disabled="loading" @click="start">
        {{ loading ? "加载中…" : error ? "重试" : isImage ? "预览图片" : "播放视频" }}
      </button>
      <span v-if="loading && active" role="status">加载中…</span>
      <a v-if="src" :href="src" target="_blank" rel="noopener noreferrer">打开原链接</a>
    </figcaption>
    <p v-if="error" class="chat-media-error" role="alert">{{ error }}</p>
  </figure>
</template>

<style scoped>
.chat-media { min-width: 0; max-width: 640px; margin: 12px 0; padding: 10px; border: 1px solid var(--qdd-border); border-radius: 10px; background: var(--qdd-surface); }
.chat-media img, .chat-media video { display: block; width: 100%; max-height: 420px; object-fit: contain; border-radius: 6px; }
.chat-media video { aspect-ratio: 16 / 9; background: #111; }
figcaption { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 6px; font-size: 12px; overflow-wrap: anywhere; }
figcaption span { min-width: 0; }
button { padding: 4px 10px; border: 1px solid var(--qdd-border); border-radius: 6px; background: var(--qdd-bg); color: var(--qdd-text); cursor: pointer; }
a { color: var(--qdd-primary); }
.chat-media-error { margin: 6px 0 0; color: var(--el-color-danger); font-size: 12px; }
</style>
