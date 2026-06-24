#!/usr/bin/env node
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Surfnet } from "@solana/surfpool";

const infoFile = process.env.SURFPOOL_INFO_FILE;

if (!infoFile) {
  throw new Error("SURFPOOL_INFO_FILE is required for the embedded Surfpool harness.");
}

const config = {
  offline: process.env.SURFPOOL_REMOTE_RPC_URL
    ? false
    : parseBoolean("KORA_SURFPOOL_OFFLINE", true),
  blockProductionMode: process.env.KORA_SURFPOOL_BLOCK_PRODUCTION_MODE ?? "transaction",
  ...(process.env.KORA_SURFPOOL_SLOT_TIME_MS && {
    slotTimeMs: Number.parseInt(process.env.KORA_SURFPOOL_SLOT_TIME_MS, 10),
  }),
  ...(process.env.SURFPOOL_REMOTE_RPC_URL && {
    remoteRpcUrl: process.env.SURFPOOL_REMOTE_RPC_URL,
  }),
};

const surfnet = await Promise.resolve(Surfnet.startWithConfig(config));
const state = {
  instanceId: surfnet.instanceId,
  payer: surfnet.payer,
  pid: process.pid,
  rpcUrl: surfnet.rpcUrl,
  wsUrl: surfnet.wsUrl,
};

await mkdir(path.dirname(infoFile), { recursive: true, mode: 0o700 });
const tempFile = `${infoFile}.${process.pid}.tmp`;
await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
await rename(tempFile, infoFile);

console.log(`Embedded Surfpool RPC listening on ${surfnet.rpcUrl}`);
console.log(`Embedded Surfpool WebSocket listening on ${surfnet.wsUrl}`);
console.log(`Embedded Surfpool payer ${surfnet.payer}`);

let stopping = false;

async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await Promise.resolve(surfnet.stop());
  } finally {
    await rm(infoFile, { force: true });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop()
      .then(() => process.exit(0))
      .catch((error) => {
        logError("Embedded Surfpool shutdown failed", error);
        process.exit(1);
      });
  });
}

process.on("uncaughtException", (error) => {
  logError("Embedded Surfpool failed", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  logError("Embedded Surfpool failed", error);
  process.exit(1);
});

setInterval(() => {}, 60_000);

function parseBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return !["0", "false", "no"].includes(value.toLowerCase());
}

function logError(prefix, error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`${prefix}: ${message.replaceAll(/[\r\n]/g, " ")}`);
}
