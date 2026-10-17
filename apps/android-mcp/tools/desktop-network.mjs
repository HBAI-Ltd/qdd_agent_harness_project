import { lanUrls, privateAddress, privateRequest as allowsPrivateRequest } from "../src/lan.ts";

export { privateAddress };

export function privateRequest(request) {
  return allowsPrivateRequest(request.headers.host, request.headers.origin, request.socket.remoteAddress);
}

export function deviceBaseUrl(port, interfaces) {
  return lanUrls(Number(port), interfaces)[0].replace(/\/$/u, "");
}
