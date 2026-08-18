#!/usr/bin/env node
import net from "node:net";

const listenHost = process.env.KORA_RPC_PROXY_LISTEN_HOST;
const listenPort = Number.parseInt(process.env.KORA_RPC_PROXY_LISTEN_PORT ?? "", 10);
const targetPort = Number.parseInt(process.env.KORA_RPC_PROXY_TARGET_PORT ?? "", 10);

if (!listenHost || !Number.isFinite(listenPort) || !Number.isFinite(targetPort)) {
  throw new Error(
    "KORA_RPC_PROXY_LISTEN_HOST, KORA_RPC_PROXY_LISTEN_PORT, and KORA_RPC_PROXY_TARGET_PORT are required."
  );
}

// Surfpool only binds 127.0.0.1 and offers no bind-host option. On Linux the
// Kora container's host-gateway address is the docker bridge gateway, from
// which the host's loopback is unreachable, so this forwarder republishes the
// Surfpool RPC on that gateway address only.
const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, "127.0.0.1");
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
});

server.listen(listenPort, listenHost, () => {
  console.log(`Forwarding ${listenHost}:${listenPort} -> 127.0.0.1:${targetPort}`);
});
