import type { HealthResponse } from "@qdd/shared";
import axios from "@/utils/axios";

export function getHealth(): Promise<HealthResponse> {
  // TODO: 联调时确认后端健康检查地址；当前服务已提供 GET /health。
  return axios.get<HealthResponse, HealthResponse>("/health");
}
