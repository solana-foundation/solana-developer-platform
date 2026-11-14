// Runs Zolana's Photon indexer and prover against a surfnet, in the foreground, until it is stopped.
// Photon indexes from the surfnet's current slot, because a mainnet fork starts far past slot 0.
// The prover fetches each proving key on first use into `intents/target/zolana/proving-keys`.
//
//   node programs/tools/zolana-services.mjs [rpc]

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const RPC = process.argv[2] ?? "http://127.0.0.1:8899";
const TARGET = new URL("../../target/zolana/", import.meta.url).pathname;
const { binaries } = JSON.parse(readFileSync(new URL("./zolana-artifacts.json", import.meta.url), "utf8"));
const binary = (role) => `${TARGET}${binaries.find((entry) => entry.role === role).asset}`;

const answer = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
});
const { result: slot } = await answer.json();
mkdirSync(`${TARGET}proving-keys`, { recursive: true });

const children = [
  spawn(binary("photon"), ["--rpc-url", RPC, "--port", "8784", "--start-slot", String(slot)], { stdio: "inherit" }),
  spawn(
    binary("prover"),
    ["start", "--keys-dir", `${TARGET}proving-keys/`, "--prover-address", "0.0.0.0:3001", "--indexer-url", "http://127.0.0.1:8784", "--auto-download"],
    { stdio: "inherit" },
  ),
];

const stop = () => children.forEach((child) => child.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((child) => child.on("exit", stop));
