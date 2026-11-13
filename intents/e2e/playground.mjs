// Prepares a local surfnet for `apps/intents-playground`: stable wallets in
// `target/playground/wallets`, funded with SOL, USDC, and USDT by cheatcodes, and the definitions
// published to the registry with the `authority` wallet. Each run keeps the wallets and tops them
// up, so the playground's addresses do not change.
//
//   node e2e/playground.mjs [rpc]

import { mkdirSync } from "node:fs";

import { TOKEN_PROGRAM, USDC, USDT, cli, keypair, rpcClient } from "./surfnet.mjs";

const RPC = process.argv[2] ?? "http://127.0.0.1:8899";
const WALLETS = new URL("../target/playground/wallets/", import.meta.url).pathname;
const rpc = rpcClient(RPC);

mkdirSync(WALLETS, { recursive: true });

const authority = keypair(WALLETS, "authority", { keep: true });
const wallets = ["treasury", "alice", "bob"].map((name) => ({ name, ...keypair(WALLETS, name, { keep: true }) }));

for (const { address } of [authority, ...wallets]) {
  await rpc("surfnet_setAccount", [address, { lamports: 100_000_000_000 }]);
}

for (const { address } of wallets.slice(0, 2)) {
  await rpc("surfnet_setTokenAccount", [address, USDC, { amount: 1_000_000_000 }, TOKEN_PROGRAM]);
  await rpc("surfnet_setTokenAccount", [address, USDT, { amount: 1_000_000_000 }, TOKEN_PROGRAM]);
}

const registry = ["--rpc", RPC, "--keypair", authority.path];

if (!cli("plan", ...registry).includes("holds every definition")) {
  cli("apply", ...registry);
}

console.log("the registry holds every definition");
wallets.forEach(({ name, address }) => console.log(`  ${name.padEnd(9)} ${address}`));
console.log(`\nnow run: cargo run -p sdp-intents-service -- --rpc ${RPC} --wallets ${WALLETS}`);
