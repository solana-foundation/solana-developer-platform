// Runs the whole flow against a local surfnet that forks mainnet: publish the definitions to the
// registry, then plan, verify, sign, and send intents with every onchain check on. Start the
// surfnet with `just surfnet`, then run `just e2e`, which places the programs first.
//
//   node e2e/run.mjs [rpc]
//
// The keys are new on each run and live in `target/e2e`. The cheatcodes fund them, so nothing here
// touches a real key or a real cluster.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const RPC = process.argv[2] ?? "http://127.0.0.1:8899";
const CLI = new URL("../target/debug/sdp-intents", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = new URL("../target/e2e/", import.meta.url).pathname;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const JUPITER_USDT_VAULT = "F7tLdeF2YZZex9MR8HgGggyFiz7UU2UgUube2tmfwNPE";
const JUPITER_SHARES = "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A";
const KAMINO_USDC_VAULT = "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E";

function base58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let text = "";
  for (; value > 0n; value /= 58n) text = ALPHABET[Number(value % 58n)] + text;

  const zeros = bytes.findIndex((byte) => byte !== 0);
  return "1".repeat(zeros === -1 ? bytes.length : zeros) + text;
}

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const { result, error } = await response.json();

  if (error) throw new Error(`${method}: ${JSON.stringify(error)}`);

  return result;
}

/// A new keypair in the Solana CLI's file format: the 32-byte secret, then the 32-byte public key.
function keypair(name) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const path = `${OUT}${name}.json`;
  writeFileSync(path, JSON.stringify([...secret, ...pub]));

  return { path, address: base58(pub) };
}

function cli(...args) {
  return execFileSync(CLI, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function tokenAmount(owner, mint) {
  const result = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);

  return result.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);

  console.log(`  ✓ ${message}`);
}

/// Prepares a plan request, verifies it as its signer, then signs and sends it.
function run(name, request, signers) {
  const requestPath = `${OUT}${name}.request.json`;
  const planPath = `${OUT}${name}.plan.json`;
  writeFileSync(requestPath, JSON.stringify(request, null, 2));
  writeFileSync(planPath, cli("prepare", requestPath, "--rpc", RPC));

  const verified = cli("verify", planPath, "--rpc", RPC);
  expect(verified.includes("The message matches the plan."), `${name}: the transaction proves the plan's message`);

  const sent = cli("send", planPath, "--rpc", RPC, ...signers.flatMap((signer) => ["--keypair", signer.path]));
  expect(sent.includes("sent "), `${name}: the transaction landed`);
}

const plan = (payer, intents) => ({ spec: "sdp-intents@1.0", kind: "plan", payers: { fee: payer.address }, intents });

mkdirSync(OUT, { recursive: true });

const authority = keypair("authority");
const payer = keypair("payer");
const sender = keypair("sender");
const receiver = keypair("receiver");

for (const { address } of [authority, payer, sender]) {
  await rpc("surfnet_setAccount", [address, { lamports: 100_000_000_000 }]);
}

await rpc("surfnet_setTokenAccount", [sender.address, USDC, { amount: 1_000_000_000 }, TOKEN_PROGRAM]);
await rpc("surfnet_setTokenAccount", [sender.address, USDT, { amount: 1_000_000_000 }, TOKEN_PROGRAM]);

console.log("publish the definitions");
cli("apply", "--rpc", RPC, "--keypair", authority.path);
expect(cli("plan", "--rpc", RPC, "--keypair", authority.path).includes("holds every definition"), "the registry holds every definition");

console.log("a USDC transfer and a SOL transfer in one transaction");
run(
  "transfers",
  plan(payer, [
    {
      interface: "solana.org/token.transfer@^1",
      implementation: "solana.org/spl-token-transfer@^1",
      inputs: { from: sender.address, to: receiver.address, mint: USDC, amount: "100000000", memo: null },
    },
    {
      interface: "solana.org/token.transfer@^1",
      implementation: "solana.org/system-transfer@^1",
      inputs: { from: sender.address, to: receiver.address, mint: SYSTEM, amount: "250000000" },
    },
  ]),
  [payer, sender],
);
expect((await tokenAmount(receiver.address, USDC)) === 100_000_000n, "the receiver holds 100 USDC");
expect((await rpc("getBalance", [receiver.address])).value === 250_000_000, "the receiver holds 0.25 SOL");

console.log("a Jupiter Lend deposit");
run(
  "jupiter-deposit",
  plan(payer, [
    {
      interface: "solana.org/vault.deposit@^1",
      implementation: "solana.org/jupiter-lend-deposit@^1",
      inputs: { owner: sender.address, vault: JUPITER_USDT_VAULT, asset: USDT, amount: "100000000", minShares: "90000000" },
    },
  ]),
  [payer, sender],
);
expect((await tokenAmount(sender.address, JUPITER_SHARES)) >= 90_000_000n, "the sender holds at least 90 jlUSDT");

console.log("a Kamino vault deposit");
const usdcBefore = await tokenAmount(sender.address, USDC);
run(
  "kamino-deposit",
  plan(payer, [
    {
      interface: "solana.org/vault.deposit@^1",
      implementation: "solana.org/kamino-deposit@^1",
      inputs: { owner: sender.address, vault: KAMINO_USDC_VAULT, asset: USDC, amount: "100000000", minShares: "1" },
    },
  ]),
  [payer, sender],
);
expect(usdcBefore - (await tokenAmount(sender.address, USDC)) === 100_000_000n, "the sender deposited 100 USDC");

console.log("every flow landed");
