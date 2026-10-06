import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";

export async function startJsonServer(
  handle: (request: IncomingMessage) => {
    status: number;
    body: unknown;
  }
) {
  const server = createServer((request, response) => {
    const result = handle(request);
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      }),
  };
}
