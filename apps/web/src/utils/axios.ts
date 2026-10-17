import axios from "axios";
import { ElMessage } from "element-plus/es/components/message/index";

const instance = axios.create({
  // TODO: 联调时确认 API 前缀；业务任务接口统一在 api/workspace.ts 中配置。
  baseURL: "/api",
  timeout: 10_000,
});

// Preserve the existing window.$axios contract: successful calls return the body.
instance.interceptors.response.use(
  (response) => response.data,
  (error: unknown) => {
    const message = axios.isAxiosError(error)
      ? error.response
        ? `请求失败（HTTP ${error.response.status}）`
        : "无法连接服务，请检查网络或后端服务"
      : "请求失败，请稍后重试";
    void ElMessage.error(message);
    return Promise.reject(error);
  },
);

export default instance;
