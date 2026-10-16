import axios from "@/utils/axios";

export interface HealthResponse {
  status: "ok";
}

export function getHealth(): Promise<HealthResponse> {
  return axios.get<HealthResponse, HealthResponse>("/health", { baseURL: "/" });
}
