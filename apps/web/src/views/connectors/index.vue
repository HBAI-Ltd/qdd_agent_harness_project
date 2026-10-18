<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElAlert } from "element-plus/es/components/alert/index";
import { ElButton } from "element-plus/es/components/button/index";
import { ElCard } from "element-plus/es/components/card/index";
import { ElDialog } from "element-plus/es/components/dialog/index";
import { ElEmpty } from "element-plus/es/components/empty/index";
import { ElForm, ElFormItem } from "element-plus/es/components/form/index";
import { ElInput } from "element-plus/es/components/input/index";
import { ElRadioButton, ElRadioGroup } from "element-plus/es/components/radio/index";
import { ElSelect } from "element-plus/es/components/select/index";
import { ElSkeleton } from "element-plus/es/components/skeleton/index";
import { ElTag } from "element-plus/es/components/tag/index";
import type { ConnectorCatalogEntry, ConnectorPermission, ConnectorView, FeishuConnectorInput, LocalMcpConnectorInput, LocalMcpProvider } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import CameraLoginDialog from "@/components/CameraLoginDialog.vue";
import * as cameraApi from "@/api/cameras";
import StringSelectOption from "@/components/StringSelectOption";
import * as api from "@/api/connectors";
import { useGatewayResource } from "@/composables/useGatewayResource";
import { useWorkspaceContext } from "@/composables/workspaceContext";

type ReceiveIdType = NonNullable<FeishuConnectorInput["receiveIdType"]>;
type ConnectorAction = "verify" | "test" | "delete";
const { workspace, navigation, notify } = useWorkspaceContext();
const { connected, gatewayUrl, token } = workspace;
const { data, loading, error, refresh } = useGatewayResource("connectors", api.listConnectors);
const catalog = computed(() => data.value?.catalog ?? []);
const connectors = computed(() => data.value?.connectors ?? []);
const connectedCount = computed(() => connectors.value.filter((entry) => entry.status === "connected").length);
const originLabels = { installed: "已安装", builtin: "内置数据", mcp: "配置文件" };
const permissions: { value: ConnectorPermission; label: string }[] = [
  { value: "read", label: "只查看数据" },
  { value: "confirm", label: "助手推送需确认" },
  { value: "auto", label: "助手自动推送" },
];
const receiveTypes: { value: ReceiveIdType; label: string }[] = [
  { value: "chat_id", label: "群 ID（chat_id）" },
  { value: "open_id", label: "Open ID" },
  { value: "user_id", label: "用户 ID" },
  { value: "union_id", label: "Union ID" },
  { value: "email", label: "邮箱" },
];
const cameraAccounts = ref<cameraApi.CameraAccountStatus[]>([]);
const cameraLoginOpen = ref(false);
const cameraProvider = ref<cameraApi.CameraProvider>();
let cameraVersion = 0;
async function loadCameraAccounts() {
  const version = ++cameraVersion;
  if (!connected.value) {
    cameraAccounts.value = [];
    return;
  }
  try {
    const list = await cameraApi.listCameraAccounts(gatewayUrl.value, token.value);
    if (version === cameraVersion && !disposed) cameraAccounts.value = list;
  } catch {
    if (version === cameraVersion && !disposed) cameraAccounts.value = [];
  }
}
function cameraAccount(connector: ConnectorView): cameraApi.CameraAccountStatus | undefined {
  const provider = cameraApi.providerOf(connector.id);
  return provider ? cameraAccounts.value.find((entry) => entry.provider === provider) : undefined;
}
function cameraAccountText(account: cameraApi.CameraAccountStatus): string {
  if (!account.reachable) return account.detail || "本地服务未启动";
  if (!account.connected) return account.detail || "未登录云端账号";
  return ["已登录", account.account, account.detail].filter(Boolean).join(" · ");
}
function openCameraLogin(connector: ConnectorView) {
  cameraProvider.value = cameraApi.providerOf(connector.id);
  if (cameraProvider.value && connected.value) cameraLoginOpen.value = true;
}
async function onCameraConnected() {
  notify("摄像头账号已登录");
  await Promise.all([loadCameraAccounts(), refresh()]);
}
watch(data, () => void loadCameraAccounts(), { immediate: true });
const formOpen = ref(false);
const editing = ref<ConnectorView>();
const formBusy = ref(false);
const formError = ref("");
const installType = ref("feishu");
const availableProviders = ref<NonNullable<ConnectorCatalogEntry["providers"]>>([]);
const selectedProvider = ref<LocalMcpProvider | "">("");
const mcpForm = computed(() => editing.value ? isMcp(editing.value) : installType.value === "pos" || installType.value === "camera");
const formTitle = computed(() => editing.value ? `${editing.value.name} · 设置` : `安装${catalog.value.find((entry) => entry.type === installType.value)?.name ?? "连接器"}`);
const form = reactive({
  name: "",
  mode: "webhook" as "webhook" | "app",
  permission: "confirm" as ConnectorPermission,
  webhookUrl: "",
  signSecret: "",
  appId: "",
  appSecret: "",
  receiveId: "",
  receiveIdType: "chat_id" as ReceiveIdType,
});
const availableModes = ref<string[]>([]);
const actionOpen = ref(false);
const actionTarget = ref<ConnectorView>();
const action = ref<ConnectorAction>("verify");
const actionBusy = ref(false);
const actionError = ref("");
const testText = ref("【钱多多】这是一条测试消息。");
let formVersion = 0;
let actionVersion = 0;
let formController: AbortController | undefined;
let actionController: AbortController | undefined;
let disposed = false;

function configText(connector: ConnectorView, key: string): string {
  const value = connector.config[key];
  return typeof value === "string" ? value : "";
}
function modeLabel(connector: ConnectorView): string {
  if (isMcp(connector)) return "本地 MCP";
  return configText(connector, "mode") === "app" ? "企业自建应用" : "群机器人 Webhook";
}
function isMcp(connector: ConnectorView): boolean {
  return connector.origin === "mcp" || configText(connector, "mode") === "mcp";
}
function providerInstalled(provider: LocalMcpProvider): boolean {
  return connectors.value.some((connector) => connector.id === `mcp:${provider}` || (isMcp(connector) && configText(connector, "provider") === provider));
}
function providerName(connector: ConnectorView): string {
  const provider = configText(connector, "provider");
  return catalog.value.flatMap((entry) => entry.providers ?? []).find((entry) => entry.id === provider)?.name ?? provider;
}
function permissionLabel(connector: ConnectorView): string {
  const { permission, origin } = connector;
  if (origin !== "installed" || isMcp(connector)) return permission === "auto" ? "允许自动操作" : permission === "confirm" ? "操作需确认" : "只查看数据";
  return permissions.find((entry) => entry.value === permission)?.label ?? permission;
}
function displayDate(value: string | null): string {
  if (!value) return "尚未验证";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间待同步"
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function canInstall(entry: ConnectorCatalogEntry): boolean {
  if (!entry.available) return false;
  if (entry.type === "feishu") return entry.modes.some((mode) => mode === "webhook" || mode === "app");
  return (entry.type === "pos" || entry.type === "camera") && entry.modes.includes("mcp") && !!entry.providers?.length;
}
function sendsVerificationMessage(connector: ConnectorView): boolean {
  return configText(connector, "mode") === "webhook" || !!configText(connector, "receiveId");
}
function canSendTest(connector: ConnectorView): boolean {
  return !isMcp(connector) && connector.permission !== "read" && (configText(connector, "mode") === "webhook" || !!configText(connector, "receiveId"));
}
function resetSecrets() {
  form.webhookUrl = "";
  form.signSecret = "";
  form.appSecret = "";
}
function stopForm() {
  formVersion++;
  formController?.abort();
  formController = undefined;
  formBusy.value = false;
  resetSecrets();
}
function stopAction() {
  actionVersion++;
  actionController?.abort();
  actionController = undefined;
  actionBusy.value = false;
}
function openInstall(entry: ConnectorCatalogEntry) {
  if (!connected.value || !canInstall(entry)) return;
  stopForm();
  editing.value = undefined;
  installType.value = entry.type;
  availableProviders.value = entry.providers ?? [];
  selectedProvider.value = "";
  availableModes.value = entry.modes;
  Object.assign(form, {
    name: "",
    mode: entry.modes.includes("webhook") ? "webhook" : "app",
    permission: "confirm",
    webhookUrl: "",
    signSecret: "",
    appId: "",
    appSecret: "",
    receiveId: "",
    receiveIdType: "chat_id",
  });
  formError.value = "";
  formOpen.value = true;
}
function openEdit(connector: ConnectorView) {
  if (!connected.value || connector.origin !== "installed") return;
  stopForm();
  editing.value = connector;
  installType.value = connector.type;
  selectedProvider.value = "";
  Object.assign(form, {
    name: connector.name,
    permission: connector.permission,
    mode: configText(connector, "mode") === "app" ? "app" : "webhook",
    appId: configText(connector, "appId"),
    receiveId: configText(connector, "receiveId"),
    receiveIdType: configText(connector, "receiveIdType") || "chat_id",
  });
  formError.value = "";
  formOpen.value = true;
}
function openAction(connector: ConnectorView, next: ConnectorAction) {
  if (!connected.value || connector.origin !== "installed" || (next === "test" && !canSendTest(connector))) return;
  stopAction();
  actionTarget.value = connector;
  action.value = next;
  actionError.value = "";
  testText.value = "【钱多多】这是一条测试消息。";
  actionOpen.value = true;
}
function validateForm(): string {
  if (editing.value && !form.name.trim()) return "请填写连接器名称。";
  if (mcpForm.value) {
    if (editing.value) return "";
    if (!selectedProvider.value || !availableProviders.value.some((entry) => entry.id === selectedProvider.value)) return "请选择要接入的平台。";
    return providerInstalled(selectedProvider.value) ? "这个平台已安装，请在工作空间连接器中管理。" : "";
  }
  if (!editing.value && form.mode === "webhook") {
    try {
      const url = new URL(form.webhookUrl.trim());
      if (
        url.protocol !== "https:" ||
        !["open.feishu.cn", "open.larksuite.com"].includes(url.hostname) ||
        url.port ||
        url.username ||
        url.password ||
        !/^\/open-apis\/bot\/v2\/hook\/[^/\s]+/.test(url.pathname)
      )
        throw new Error();
    } catch {
      return "请填写飞书自定义机器人的 HTTPS Webhook 地址。";
    }
  }
  if (!editing.value && form.mode === "app" && (!form.appId.trim() || !form.appSecret.trim())) return "请填写 App ID 和 App Secret。";
  return "";
}
function requestError(cause: unknown): string {
  return cause instanceof TypeError ? "无法连接网关，请检查连接后重试。" : cause instanceof Error ? cause.message : "请求失败，请稍后重试。";
}
async function saveConnector() {
  if (formBusy.value || !connected.value) return;
  formError.value = validateForm();
  if (formError.value) return;
  const controller = new AbortController();
  formController = controller;
  const version = formVersion;
  const base = gatewayUrl.value;
  const accessToken = token.value;
  const target = editing.value;
  const current = () =>
    !disposed && !controller.signal.aborted && version === formVersion && formOpen.value && base === gatewayUrl.value && accessToken === token.value;
  formBusy.value = true;
  try {
    if (target) {
      await api.updateConnector(
        base,
        accessToken,
        target.id,
        {
          name: form.name.trim(),
          ...(!mcpForm.value ? {
            permission: form.permission,
            ...(form.mode === "app" ? { receiveId: form.receiveId.trim(), receiveIdType: form.receiveIdType } : {}),
          } : {}),
        },
        controller.signal,
      );
    } else if (mcpForm.value) {
      const input: LocalMcpConnectorInput = {
        type: installType.value === "pos" ? "pos" : "camera",
        mode: "mcp",
        provider: selectedProvider.value as LocalMcpProvider,
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
      };
      await api.installConnector(base, accessToken, input, controller.signal);
    } else {
      const input: FeishuConnectorInput = {
        type: "feishu",
        mode: form.mode,
        permission: form.permission,
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        ...(form.mode === "webhook"
          ? {
              webhookUrl: form.webhookUrl.trim(),
              ...(form.signSecret.trim() ? { signSecret: form.signSecret.trim() } : {}),
            }
          : {
              appId: form.appId.trim(),
              appSecret: form.appSecret.trim(),
              ...(form.receiveId.trim() ? { receiveId: form.receiveId.trim(), receiveIdType: form.receiveIdType } : {}),
            }),
      };
      await api.installConnector(base, accessToken, input, controller.signal);
    }
    if (!current()) return;
    await refresh();
    if (!current()) return;
    notify(target ? "连接器设置已保存" : "连接器已验证并安装");
    formOpen.value = false;
  } catch (cause) {
    if (current()) formError.value = requestError(cause);
  } finally {
    if (formController === controller) {
      formController = undefined;
      formBusy.value = false;
    }
  }
}
async function runAction() {
  const target = actionTarget.value;
  if (!target || target.origin !== "installed" || actionBusy.value || !connected.value) return;
  const selectedAction = action.value;
  if (selectedAction === "test" && !testText.value.trim()) {
    actionError.value = "请填写测试消息。";
    return;
  }
  const controller = new AbortController();
  actionController = controller;
  const version = actionVersion;
  const base = gatewayUrl.value;
  const accessToken = token.value;
  const current = () =>
    !disposed &&
    !controller.signal.aborted &&
    version === actionVersion &&
    actionOpen.value &&
    base === gatewayUrl.value &&
    accessToken === token.value;
  actionBusy.value = true;
  actionError.value = "";
  try {
    let verification: ConnectorView | undefined;
    if (selectedAction === "verify") verification = await api.verifyConnector(base, accessToken, target.id, controller.signal);
    else if (selectedAction === "test") await api.testConnector(base, accessToken, target.id, testText.value.trim(), controller.signal);
    else await api.deleteConnector(base, accessToken, target.id, controller.signal);
    if (!current()) return;
    await refresh();
    if (!current()) return;
    if (verification?.status === "error") {
      actionError.value = verification.detail || "连接器验证失败。";
      return;
    }
    notify(selectedAction === "verify" ? "连接器验证成功" : selectedAction === "test" ? "测试消息已发送" : "连接器已删除");
    actionOpen.value = false;
  } catch (cause) {
    if (current()) actionError.value = requestError(cause);
  } finally {
    if (actionController === controller) {
      actionController = undefined;
      actionBusy.value = false;
    }
  }
}
watch(
  formOpen,
  (open) => {
    if (!open) stopForm();
  },
  { flush: "sync" },
);
watch(
  actionOpen,
  (open) => {
    if (!open) stopAction();
  },
  { flush: "sync" },
);
watch(
  [gatewayUrl, token, connected],
  () => {
    stopForm();
    stopAction();
    formOpen.value = false;
    actionOpen.value = false;
    formError.value = "";
    actionError.value = "";
  },
  { flush: "sync" },
);
onBeforeUnmount(() => {
  disposed = true;
  stopForm();
  stopAction();
});
</script>

<template>
  <div class="feature-page connectors-page">
    <header class="feature-header">
      <div>
        <span class="feature-eyebrow">连接器</span>
        <h1>把门店里的系统和设备接给助手</h1>
        <p>连接真实的数据来源与通知渠道，按你的授权范围工作。</p>
      </div>
      <ElTag :type="connected ? 'success' : 'info'" effect="plain" round>
        {{ connected && data ? `已连接 ${connectedCount} 个` : "连接网关后同步" }}
      </ElTag>
    </header>
    <ElAlert v-if="error" :title="error" type="error" show-icon :closable="false" />
    <ElCard v-if="!connected" shadow="never">
      <ElEmpty description="连接工作空间后，查看和安装连接器" :image-size="70">
        <ElButton type="primary" @click="navigation.openView('settings')">连接工作空间</ElButton>
      </ElEmpty>
    </ElCard>
    <ElSkeleton v-else-if="loading && !data" :rows="8" animated />
    <template v-else>
      <section aria-labelledby="installed-connectors-title">
        <div class="section-heading">
          <div>
            <h2 id="installed-connectors-title">工作空间连接器</h2>
            <p>配置文件来源只读展示；已安装的连接器可单独管理。</p>
          </div>
          <ElButton :loading="loading" @click="refresh">
            <AgentIcon name="refresh" :size="15" />
            刷新
          </ElButton>
        </div>
        <ElEmpty v-if="!connectors.length && !loading" description="暂无连接器" :image-size="65" />
        <div class="installed-grid">
          <ElCard v-for="connector in connectors" :key="connector.id" class="installed-card" shadow="never">
            <div class="connector-heading">
              <span class="connector-mark" aria-hidden="true">{{ connector.name.slice(0, 1) }}</span>
              <ElTag :type="connector.status === 'connected' ? 'success' : 'danger'" size="small" effect="plain">
                {{ connector.status === "connected" ? "已连接" : "连接异常" }}
              </ElTag>
            </div>
            <h2>{{ connector.name }}</h2>
            <div class="connector-tags">
              <ElTag type="info" size="small" effect="plain">{{ originLabels[connector.origin] }}</ElTag>
              <ElTag :type="connector.permission === 'auto' ? 'warning' : 'info'" size="small" effect="plain">
                {{ permissionLabel(connector) }}
              </ElTag>
              <ElTag v-if="connector.origin === 'installed'" type="info" size="small" effect="plain">{{ modeLabel(connector) }}</ElTag>
            </div>
            <p class="connector-detail">{{ connector.detail }}</p>
            <dl v-if="connector.origin === 'installed'" class="connector-config">
              <template v-if="isMcp(connector)">
                <dt>接入平台</dt>
                <dd>{{ providerName(connector) }}</dd>
                <dt>账号登录</dt>
                <dd>
                  <a v-if="configText(connector, 'consoleUrl')" :href="configText(connector, 'consoleUrl')" target="_blank" rel="noopener noreferrer">打开登录控制台</a>
                  <span v-else>控制台地址不可用</span>
                </dd>
              </template>
              <template v-else-if="configText(connector, 'mode') === 'webhook'">
                <dt>Webhook</dt>
                <dd>{{ configText(connector, "webhookUrl") || "地址不可用" }}</dd>
                <dt>签名密钥</dt>
                <dd>{{ connector.config.signSecret ? "已设置" : "未设置" }}</dd>
              </template>
              <template v-else>
                <dt>App ID</dt>
                <dd>{{ configText(connector, "appId") }}</dd>
                <dt>App Secret</dt>
                <dd>{{ connector.config.appSecret ? "已设置" : "未设置" }}</dd>
                <dt>接收方</dt>
                <dd>{{ configText(connector, "receiveId") || "尚未设置，暂不能推送" }}</dd>
              </template>
            </dl>
            <div v-if="connector.origin === 'installed'" class="installed-footer">
              <small>{{ displayDate(connector.lastVerifiedAt) }} 验证</small>
              <div class="connector-actions">
                <ElButton link type="primary" @click="openEdit(connector)">设置</ElButton>
                <ElButton link @click="openAction(connector, 'verify')">重新验证</ElButton>
                <ElButton
                  v-if="!isMcp(connector)"
                  link
                  :disabled="!canSendTest(connector)"
                  :title="canSendTest(connector) ? '向接收方发送测试消息' : '只查看权限或未设置接收方时不能推送'"
                  @click="openAction(connector, 'test')">
                  测试消息
                </ElButton>
                <ElButton link type="danger" @click="openAction(connector, 'delete')">删除</ElButton>
              </div>
            </div>
            <div v-else-if="cameraAccount(connector)" class="installed-footer">
              <small>
                <ElTag :type="cameraAccount(connector)!.connected ? 'success' : 'warning'" size="small" effect="plain">
                  {{ cameraAccountText(cameraAccount(connector)!) }}
                </ElTag>
              </small>
              <div class="connector-actions">
                <ElButton link type="primary" :disabled="!cameraAccount(connector)!.reachable" @click="openCameraLogin(connector)">
                  {{ cameraAccount(connector)!.connected ? "更换账号" : "登录账号" }}
                </ElButton>
              </div>
            </div>
            <p v-else class="readonly-note">{{ connector.origin === "mcp" ? "在网关配置文件中管理此来源。" : "内置只读数据，无需安装。" }}</p>
          </ElCard>
        </div>
      </section>

      <section class="catalog-section" aria-labelledby="connector-catalog-title">
        <div class="section-heading">
          <div>
            <h2 id="connector-catalog-title">添加连接器</h2>
            <p>可安装的类型由当前网关提供，其余类型将在开放后支持。</p>
          </div>
        </div>
        <div class="connector-grid">
          <ElCard v-for="entry in catalog" :key="entry.type" class="connector-card" shadow="never">
            <div class="connector-heading">
              <span class="connector-mark" aria-hidden="true">{{ entry.name.slice(0, 1) }}</span>
              <ElTag :type="canInstall(entry) ? 'success' : 'info'" size="small" effect="plain">
                {{ canInstall(entry) ? "可安装" : "暂未开放" }}
              </ElTag>
            </div>
            <h2>{{ entry.name }}</h2>
            <p>{{ entry.category }}</p>
            <div class="connector-tags">
              <ElTag v-for="tag in entry.tags" :key="tag" type="info" effect="plain" size="small" round>{{ tag }}</ElTag>
            </div>
            <ElButton :type="canInstall(entry) ? 'primary' : 'default'" :disabled="!canInstall(entry)" @click="openInstall(entry)">
              {{ canInstall(entry) ? "安装连接器" : "暂未开放" }}
            </ElButton>
          </ElCard>
        </div>
      </section>
    </template>

    <CameraLoginDialog
      v-model="cameraLoginOpen"
      :provider="cameraProvider"
      :gateway-url="gatewayUrl"
      :token="token"
      @connected="onCameraConnected" />

    <ElDialog
      v-model="formOpen"
      :title="formTitle"
      width="min(620px, calc(100vw - 32px))"
      destroy-on-close>
      <ElAlert v-if="formError" :title="formError" type="error" show-icon :closable="false" />
      <ElAlert
        v-if="!editing && !mcpForm"
        title="安装前会验证连接：群机器人会发送一条验证消息；自建应用设置了接收方时也会发送。只查看权限同样会执行这次安装验证。"
        type="info"
        show-icon
        :closable="false" />
      <ElAlert
        v-if="!editing && mcpForm"
        title="选择平台后，点击“验证并安装”才会接入该平台。请先启动对应本地服务，安装完成后在登录控制台登录账号。"
        type="info"
        show-icon
        :closable="false" />
      <ElForm label-position="top" class="connector-form" :disabled="formBusy" @submit.prevent="saveConnector">
        <ElFormItem label="连接器名称">
          <ElInput v-model="form.name" maxlength="30" :placeholder="mcpForm ? '选填，例如：门店摄像头' : '例如：门店经营通知群'" autocomplete="off" />
        </ElFormItem>
        <template v-if="mcpForm">
          <ElFormItem v-if="!editing" label="接入平台" required>
            <ElSelect v-model="selectedProvider" aria-label="接入平台" :disabled="formBusy" class="recipient-select">
              <StringSelectOption
                v-for="provider in availableProviders"
                :key="provider.id"
                :value="provider.id"
                :label="provider.name + (providerInstalled(provider.id) ? '（已安装）' : '')"
                :disabled="providerInstalled(provider.id)" />
            </ElSelect>
          </ElFormItem>
          <p class="form-note">{{ installType === 'pos' ? '收银系统只查看经营数据。' : '摄像头数据可查看；云台、截图、采集等操作需要店长确认。' }}</p>
          <p v-if="editing" class="form-note">这里只修改名称。更换接入平台，请删除后重新安装。</p>
        </template>
        <template v-else>
        <ElFormItem label="接入方式">
          <ElTag v-if="editing" type="info" effect="plain">{{ modeLabel(editing) }}</ElTag>
          <ElRadioGroup v-else v-model="form.mode">
            <ElRadioButton v-if="availableModes.includes('webhook')" value="webhook">群机器人 Webhook</ElRadioButton>
            <ElRadioButton v-if="availableModes.includes('app')" value="app">企业自建应用</ElRadioButton>
          </ElRadioGroup>
        </ElFormItem>
        <template v-if="!editing && form.mode === 'webhook'">
          <ElFormItem label="Webhook 地址" required>
            <ElInput
              v-model="form.webhookUrl"
              type="password"
              show-password
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
              autocomplete="off" />
          </ElFormItem>
          <ElFormItem label="签名校验密钥（选填）">
            <ElInput v-model="form.signSecret" type="password" show-password autocomplete="new-password" placeholder="机器人开启签名校验时填写" />
          </ElFormItem>
        </template>
        <template v-if="!editing && form.mode === 'app'">
          <ElFormItem label="App ID" required><ElInput v-model="form.appId" placeholder="cli_…" autocomplete="off" /></ElFormItem>
          <ElFormItem label="App Secret" required>
            <ElInput v-model="form.appSecret" type="password" show-password autocomplete="new-password" />
          </ElFormItem>
        </template>
        <template v-if="form.mode === 'app'">
          <div class="recipient-fields">
            <ElFormItem label="接收方类型" for="connector-receive-type">
              <ElSelect id="connector-receive-type" v-model="form.receiveIdType" class="recipient-select" :disabled="formBusy">
                <StringSelectOption v-for="item in receiveTypes" :key="item.value" :value="item.value" :label="item.label" />
              </ElSelect>
            </ElFormItem>
            <ElFormItem label="接收方 ID（选填）">
              <ElInput v-model="form.receiveId" placeholder="群 ID、用户 ID 或邮箱" autocomplete="off" />
            </ElFormItem>
          </div>
          <p class="form-note">可稍后补充接收方；未设置时不能推送。修改接收方后，可重新验证确认可达。</p>
        </template>
        <ElFormItem label="推送权限">
          <ElRadioGroup v-model="form.permission" class="permission-options">
            <ElRadioButton v-for="item in permissions" :key="item.value" :value="item.value">{{ item.label }}</ElRadioButton>
          </ElRadioGroup>
        </ElFormItem>
        <ElAlert
          v-if="form.permission === 'auto'"
          title="助手自动推送：助手在对话中可以直接发送消息，无需店长逐次确认。"
          type="warning"
          show-icon
          :closable="false" />
        <p v-else class="form-note">
          {{
            form.permission === "read"
              ? "只查看数据，不能发送后续通知或测试消息。安装与重新验证仍可能发送验证消息。"
              : "助手在对话中发起的推送，需要店长逐次确认。手动测试消息由你点击发送。"
          }}
        </p>
        <p v-if="form.permission !== 'read'" class="form-note">为定时任务配置此通知接收方，即授权该任务在完成后推送结果，无需每次再次确认。</p>
        <p v-if="editing" class="form-note">这里只修改名称、推送权限与接收方。更换 Webhook 或应用凭据，请删除后重新安装。</p>
        </template>
      </ElForm>
      <template #footer>
        <ElButton @click="formOpen = false">取消</ElButton>
        <ElButton type="primary" :loading="formBusy" :disabled="!connected" @click="saveConnector">
          {{ editing ? "保存设置" : "验证并安装" }}
        </ElButton>
      </template>
    </ElDialog>

    <ElDialog
      v-model="actionOpen"
      :title="action === 'delete' ? '删除连接器' : action === 'test' ? '发送测试消息' : '重新验证连接器'"
      width="min(520px, calc(100vw - 32px))"
      destroy-on-close>
      <template v-if="actionTarget">
        <p class="action-target">{{ actionTarget.name }}</p>
        <ElAlert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
        <p v-if="action === 'delete'" class="form-note">{{ isMcp(actionTarget) ? '删除后将停止此服务，助手不再通过此连接器访问门店数据或设备。' : '删除后将停止通过此连接器推送。若有定时任务正在使用，请先修改对应任务的通知设置。' }}</p>
        <template v-else-if="action === 'verify'">
          <ElAlert
            :title="
              isMcp(actionTarget)
                ? '检查本地服务与 MCP 工具是否可用；账号登录请在该平台的登录控制台完成。'
                : sendsVerificationMessage(actionTarget)
                ? '重新验证会向机器人或已配置的接收方发送一条验证消息，即使权限是只查看。'
                : '本次验证应用凭据与机器人信息；尚未配置接收方，不会推送消息。'
            "
            type="info"
            show-icon
            :closable="false" />
        </template>
        <template v-else>
          <p class="form-note">点击发送后，这条消息会立即发送到连接器配置的接收方。</p>
          <ElInput
            v-model="testText"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 7 }"
            :maxlength="500"
            show-word-limit
            :disabled="actionBusy"
            aria-label="测试消息内容" />
        </template>
      </template>
      <template #footer>
        <ElButton @click="actionOpen = false">取消</ElButton>
        <ElButton :type="action === 'delete' ? 'danger' : 'primary'" :loading="actionBusy" :disabled="!connected" @click="runAction">
          {{ action === "delete" ? "删除连接器" : action === "test" ? "发送测试消息" : "开始验证" }}
        </ElButton>
      </template>
    </ElDialog>
  </div>
</template>

<style scoped>
.connector-grid,
.installed-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}
.installed-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.connector-card :deep(.el-card__body),
.installed-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 23px;
}
.connector-card :deep(.el-card__body) {
  min-height: 240px;
}
.connector-heading,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.connector-mark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: var(--qdd-bg);
  color: var(--qdd-muted);
  font-size: 21px;
  font-weight: 600;
}
.connector-card h2,
.installed-card h2 {
  font-size: 17px;
  font-weight: 600;
  margin: 17px 0 7px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.connector-card p,
.connector-detail {
  margin: 0;
  color: var(--qdd-muted);
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.connector-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 15px;
}
.connector-card :deep(.el-button) {
  align-self: flex-start;
  margin-top: auto;
}
.catalog-section {
  margin-top: 34px;
}
.section-heading {
  margin-bottom: 17px;
}
.section-heading h2 {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 6px;
}
.section-heading p {
  margin: 0;
  color: var(--qdd-muted);
  font-size: 12px;
  line-height: 1.8;
}
.section-heading > :deep(.el-button) {
  flex-shrink: 0;
}
.connector-config {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 7px 12px;
  margin: 17px 0;
  font-size: 12px;
}
.connector-config dt {
  color: var(--qdd-muted);
}
.connector-config dd {
  margin: 0;
  color: var(--qdd-text);
  overflow-wrap: anywhere;
}
.installed-footer {
  margin-top: auto;
  padding-top: 14px;
  border-top: 1px solid var(--qdd-border);
}
.installed-footer small,
.readonly-note {
  color: var(--qdd-muted);
  font-size: 11px;
}
.readonly-note {
  margin: auto 0 0;
  padding-top: 18px;
}
.connector-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-top: 10px;
}
.connector-actions :deep(.el-button) {
  margin: 0;
  font-size: 12px;
}
.connector-form {
  margin-top: 20px;
}
.recipient-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 14px;
}
.recipient-select {
  width: 100%;
}
.permission-options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 0;
}
.form-note {
  margin: 10px 0 18px;
  color: var(--qdd-muted);
  line-height: 1.8;
  font-size: 13px;
}
.action-target {
  margin: 0 0 16px;
  font-size: 16px;
  color: var(--qdd-text);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.connector-form :deep(.el-alert),
.connectors-page :deep(.el-dialog__body > .el-alert) {
  margin-top: 12px;
}
@media (max-width: 1120px) {
  .connector-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 920px) {
  .installed-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .connector-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .connector-card :deep(.el-card__body),
  .installed-card :deep(.el-card__body) {
    min-height: 0;
    padding: 21px;
  }
  .section-heading {
    align-items: flex-start;
  }
  .recipient-fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
}
</style>
