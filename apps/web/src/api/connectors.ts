import type { ConnectorCatalogEntry, ConnectorInput, ConnectorPermission, ConnectorView, FeishuConnectorInput } from "@qdd/shared";
import { gatewayJson } from "./workspace";

export interface ConnectorCollection {
  catalog: ConnectorCatalogEntry[];
  connectors: ConnectorView[];
}

export interface ConnectorUpdate {
  name?: string;
  permission?: ConnectorPermission;
  receiveId?: string;
  receiveIdType?: FeishuConnectorInput["receiveIdType"];
}

const connectorPath = (id: string) => `/api/connectors/${encodeURIComponent(id)}`;

export function listConnectors(base: string, token: string, signal?: AbortSignal): Promise<ConnectorCollection> {
  return gatewayJson(base, token, "/api/connectors", { signal: signal ?? null });
}

export function getConnector(base: string, token: string, id: string, signal?: AbortSignal): Promise<ConnectorView> {
  return gatewayJson(base, token, connectorPath(id), { signal: signal ?? null });
}

export function installConnector(base: string, token: string, input: ConnectorInput, signal?: AbortSignal): Promise<ConnectorView> {
  return gatewayJson(base, token, "/api/connectors", { method: "POST", body: JSON.stringify(input), signal: signal ?? null });
}

export function updateConnector(base: string, token: string, id: string, input: ConnectorUpdate, signal?: AbortSignal): Promise<ConnectorView> {
  return gatewayJson(base, token, connectorPath(id), { method: "PUT", body: JSON.stringify(input), signal: signal ?? null });
}

export function verifyConnector(base: string, token: string, id: string, signal?: AbortSignal): Promise<ConnectorView> {
  return gatewayJson(base, token, `${connectorPath(id)}/verify`, { method: "POST", signal: signal ?? null });
}

export function testConnector(base: string, token: string, id: string, text: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return gatewayJson(base, token, `${connectorPath(id)}/test`, { method: "POST", body: JSON.stringify({ text }), signal: signal ?? null });
}

export function deleteConnector(base: string, token: string, id: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return gatewayJson(base, token, connectorPath(id), { method: "DELETE", signal: signal ?? null });
}
