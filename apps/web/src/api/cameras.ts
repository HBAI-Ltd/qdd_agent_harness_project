import type { CameraAccountStatus, CameraProvider } from "@qdd/shared";
import { gatewayJson } from "./workspace";

export type { CameraAccountStatus, CameraProvider } from "@qdd/shared";

const post = <T>(base: string, token: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
  gatewayJson(base, token, path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? null });

export function listCameraAccounts(base: string, token: string, signal?: AbortSignal): Promise<CameraAccountStatus[]> {
  return gatewayJson(base, token, "/api/cameras", { signal: signal ?? null });
}

export function haikSendCode(base: string, token: string, phone: string, captchaVerifyParam: string, signal?: AbortSignal): Promise<{ sent: true }> {
  return post(base, token, "/api/cameras/haik/send-code", { phone, captchaVerifyParam }, signal);
}

export function haikLogin(base: string, token: string, phone: string, code: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return post(base, token, "/api/cameras/haik/login", { phone, code }, signal);
}

export function tyslLoginStart(base: string, token: string, signal?: AbortSignal): Promise<{ url: string; state: string; expiresIn: number }> {
  return post(base, token, "/api/cameras/tysl/login-start", undefined, signal);
}

export function tyslLoginComplete(base: string, token: string, state: string, callbackUrl: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return post(base, token, "/api/cameras/tysl/login-complete", { state, callbackUrl }, signal);
}

export const providerOf = (connectorId: string): CameraProvider | undefined =>
  connectorId === "mcp:haik" ? "haik" : connectorId === "mcp:tysl" ? "tysl" : undefined;
