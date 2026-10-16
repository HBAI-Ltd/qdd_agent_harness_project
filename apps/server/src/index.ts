import { createServer } from "node:http";
import { SERVICE_NAME, type HealthResponse } from "@qdd/shared";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535.");
}

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method === "GET" && request.url === "/health") {
    const body: HealthResponse = { status: "ok", service: SERVICE_NAME };
    response.writeHead(200);
    response.end(JSON.stringify(body));
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ error: "Not Found" }));
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const address = server.address();
  if (address && typeof address !== "string") {
    const displayHost = address.address.includes(":")
      ? `[${address.address}]`
      : address.address;
    console.log(`${SERVICE_NAME} listening on http://${displayHost}:${address.port}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
