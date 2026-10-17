import { onBeforeUnmount, ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { useWorkspaceContext } from "./workspaceContext";

export type GatewayResourceKey = "overview" | "pending" | "skills" | "schedules" | "connectors";
export interface GatewayResource<T> {
  data: ShallowRef<T | undefined>;
  loading: Ref<boolean>;
  error: Ref<string>;
  refresh: () => Promise<void>;
}

export function useGatewayResource<T>(
  key: GatewayResourceKey,
  loader: (base: string, token: string, signal: AbortSignal) => Promise<T>,
  workspace = useWorkspaceContext().workspace,
): GatewayResource<T> {
  const data = shallowRef<T>();
  const loading = ref(false);
  const error = ref("");
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  async function refresh() {
    controller?.abort();
    if (disposed || !workspace.connected.value) return;
    const request = new AbortController();
    controller = request;
    loading.value = true;
    error.value = "";
    try {
      const result = await loader(workspace.gatewayUrl.value, workspace.token.value, request.signal);
      if (!request.signal.aborted && !disposed && controller === request) data.value = result;
    } catch (cause) {
      if (!request.signal.aborted && !disposed && controller === request) {
        error.value = cause instanceof TypeError ? "无法连接网关，请检查服务状态。"
          : cause instanceof Error ? cause.message : "数据读取失败，请重试。";
      }
    } finally {
      if (controller === request) loading.value = false;
    }
  }

  watch([workspace.gatewayUrl, workspace.token, workspace.connected], () => {
    controller?.abort();
    clearTimeout(timer);
    data.value = undefined;
    error.value = "";
    loading.value = false;
    if (workspace.connected.value) void refresh();
  }, { immediate: true, flush: "sync" });
  watch(() => workspace.gatewayChanges.value[key], () => {
    clearTimeout(timer);
    if (workspace.connected.value) timer = setTimeout(() => { void refresh(); }, 100);
  });
  onBeforeUnmount(() => {
    disposed = true;
    controller?.abort();
    clearTimeout(timer);
  });
  return { data, loading, error, refresh };
}
