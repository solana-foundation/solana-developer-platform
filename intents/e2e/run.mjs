// Runs the whole flow against a local surfnet that forks mainnet: publish the definitions to the
// registry through a Squads multisig, then plan, verify, sign, and send intents with every onchain
// check on. The service plans each intent from the registry, and the CLI plans it again from the
// definitions tree. Start the surfnet with `just surfnet`, then run `just e2e`, which places the
// programs and builds the service first.
//
//   node e2e/run.mjs [rpc]
//
// The keys are new on each run and live in `target/e2e/wallets`. The cheatcodes fund them, so
// nothing here touches a real key or a real cluster.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { Verifier } from "../../packages/sdp-intents-verifier/src/index.ts";

import {
  JUPITER_SHARES,
  JUPITER_USDT_VAULT,
  KAMINO_USDC_VAULT,
  ORGANIZATION,
  REGISTRY,
  SYSTEM,
  TOKEN_PROGRAM,
  USDC,
  USDT,
  base58,
  cli,
  keypair as keypairIn,
  rpcClient,
  setLookupTable,
} from "./surfnet.mjs";

const RPC = process.argv[2] ?? "http://127.0.0.1:8899";
const SERVICE_BINARY = new URL("../target/debug/sdp-intents-service", import.meta.url).pathname;
const ADAPTER = new URL("../adapters/jupiter.mjs", import.meta.url).pathname;
const PROVIDER_BINARY = new URL("../target/debug/sdp-intents-test-provider", import.meta.url).pathname;
const PROVIDER_WALLET = "ProviderWa11et11111111111111111111111111111";
const NOPAL = "GArhnnDj3GYhmQeApKVXaRv4TQFwhPcs3SNF6FXsTeXq";
const USDY = "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6";
const PRIME = "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7";
const WYLDS = "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih";
const SERVICE_LISTEN = "127.0.0.1:8788";
const SERVICE = `http://${SERVICE_LISTEN}`;
const OUT = new URL("../target/e2e/", import.meta.url).pathname;
const WALLETS = `${OUT}wallets/`;

const rpc = rpcClient(RPC);
const verifier = await Verifier.load(
  readFileSync(new URL("../../packages/sdp-intents-verifier/wasm/verifier.wasm", import.meta.url)),
);
const keypair = (name) => keypairIn(WALLETS, name);

async function service(path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body };
  const answer = await (await fetch(`${SERVICE}${path}`, init)).json();

  if (answer.error) throw new Error(`${path}: ${answer.error.message}\n${JSON.stringify(answer.error.details)}`);

  return answer;
}

/// Starts `command` and waits until `url` answers.
async function start(command, args, url) {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"] });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const up = await fetch(url).then((response) => response.status < 500, () => false);
    if (up) return child;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill();
  throw new Error(`${command} did not start`);
}

/// The service signs with the wallets in `WALLETS`, so it starts after they exist.
const startService = () =>
  start(SERVICE_BINARY, ["--rpc", RPC, "--listen", SERVICE_LISTEN, "--wallets", WALLETS], `${SERVICE}/health`);

/// The Jupiter swap wrapper that the Ondo implementations name.
const startAdapter = () => start(process.execPath, [ADAPTER], "http://127.0.0.1:8791/mode");

/// The stand-in provider that the tier 3 implementation names.
const startProvider = () => start(PROVIDER_BINARY, [RPC], "http://127.0.0.1:8792/deposit");

async function tokenAmount(owner, mint) {
  const result = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);

  return result.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);

  console.log(`  ✓ ${message}`);
}

/// Whether the TypeScript verifier, which reads only the RPC, proves the plan's message from the
/// base64 `message`.
async function typescriptProves(message, plan) {
  const bytes = Uint8Array.from(atob(message), (character) => character.charCodeAt(0));
  const verified = await verifier.verifyMessage(bytes, RPC);

  return verified.message === plan.message && verified.unverified.length === 0;
}

/// Prepares a plan request with the service and with the CLI, verifies it with each verifier, then
/// signs and sends it. The service signs with its wallets, and the CLI with `signers`.
async function run(name, request, signers) {
  const requestPath = `${OUT}${name}.request.json`;
  const planPath = `${OUT}${name}.plan.json`;
  writeFileSync(requestPath, JSON.stringify(request, null, 2));

  const plan = await service("/v1/prepare", JSON.stringify(request));
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log(`    the service's RPC calls: ${JSON.stringify(plan.rpcCalls)}`);

  const local = JSON.parse(cli("prepare", requestPath, "--rpc", RPC));
  expect(local.message === plan.message, `${name}: the CLI and the service plan the same message`);

  const verified = cli("verify", planPath, "--rpc", RPC);
  expect(verified.includes("The message matches the plan."), `${name}: the client's verifier proves the message`);

  const compiled = plan.transaction.messageBytes;
  // A provider's transaction is planned again from its request, with its signatures.
  const presigned = plan.transaction.presigned;
  const remote = await service(
    "/v1/verify",
    JSON.stringify({ message: compiled, expected: plan.message, presigned, request: plan.request }),
  );
  expect(remote.matches && remote.unverified.length === 0, `${name}: the service's verifier proves it too`);

  // No `verify_intent` proves a provider's transaction. Only a new plan of its request checks it.
  if (presigned.length === 0) {
    expect(await typescriptProves(compiled, plan), `${name}: the TypeScript verifier proves it too`);
  }

  if (signers === undefined) {
    const sent = await service("/v1/send", JSON.stringify({ message: compiled, presigned }));
    expect(sent.signature !== undefined, `${name}: the service signed it, and it landed`);
  } else {
    const sent = cli("send", planPath, "--rpc", RPC, ...signers.flatMap((signer) => ["--keypair", signer.path]));
    expect(sent.includes("sent "), `${name}: the CLI signed it, and it landed`);
  }

  return plan;
}

const plan = (payer, intents) => ({ spec: "sdp-intents@1.0", kind: "plan", payers: { fee: payer.address }, intents });

/// Prepares a plan of instructions alone, then has the CLI compile it to each version, verify it,
/// and send it. The service's verifier reads the same bytes that the CLI compiled.
async function runEachVersion(name, request, signers, lookupTable) {
  const planPath = `${OUT}${name}.plan.json`;
  const plan = await service("/v1/prepare", JSON.stringify({ ...request, options: { output: "instructions" } }));
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  expect(plan.transaction === undefined && plan.instructions.length > 0, `${name}: the plan holds instructions alone`);
  expect(plan.rpcCalls.getLatestBlockhash === 0, `${name}: the service read no blockhash`);

  const versions = [["legacy"], ["0", "--lookup-table", lookupTable], ["1"]];

  for (const [version, ...tables] of versions) {
    const compile = ["--rpc", RPC, "--version", version, ...tables];
    const verified = cli("verify", planPath, ...compile);
    expect(verified.includes("The message matches the plan."), `${name} as ${version}: the client's verifier proves it`);

    const message = verified.match(/^messageBytes (\S+)$/m)[1];
    const remote = await service("/v1/verify", JSON.stringify({ message, expected: plan.message }));
    expect(remote.matches && remote.unverified.length === 0, `${name} as ${version}: the service's verifier proves it too`);
    expect(await typescriptProves(message, plan), `${name} as ${version}: the TypeScript verifier proves it too`);

    const sent = cli("send", planPath, ...compile, ...signers.flatMap((signer) => ["--keypair", signer.path]));
    expect(sent.includes("sent "), `${name} as ${version}: the CLI compiled it, signed it, and it landed`);
  }
}

mkdirSync(WALLETS, { recursive: true });

const authority = keypair("authority");
const payer = keypair("payer");
const sender = keypair("sender");
const receiver = keypair("receiver");

for (const { address } of [authority, payer, sender]) {
  await rpc("surfnet_setAccount", [address, { lamports: 100_000_000_000 }]);
}

await rpc("surfnet_setTokenAccount", [sender.address, USDC, { amount: 1_000_000_000 }, TOKEN_PROGRAM]);
await rpc("surfnet_setTokenAccount", [sender.address, USDT, { amount: 1_000_000_000 }, TOKEN_PROGRAM]);

console.log("publish the definitions through a Squads multisig");
const created = cli("squads-create", "--rpc", RPC, "--keypair", authority.path);
const multisig = created.match(/multisig (\S+)/)[1];
const vault = created.match(/vault (\S+)/)[1];
await rpc("surfnet_setAccount", [vault, { lamports: 100_000_000_000 }]);

console.log("create the registry config, with the multisig as the admin that admits organizations");
await rpc("surfnet_setProgramAuthority", [REGISTRY, authority.address]);
cli("init-registry", "--rpc", RPC, "--keypair", authority.path, "--admin", vault);

const opened = (() => {
  try {
    cli("set-organizations-gated", "--rpc", RPC, "--keypair", payer.path, "off");
    return true;
  } catch {
    return false;
  }
})();
expect(!opened, "a key other than the admin cannot open organization creation");

const squads = ["--rpc", RPC, "--keypair", authority.path, "--squads", multisig];
cli("apply", ...squads, "--execute");
expect(cli("plan", ...squads).includes("holds every definition"), "the registry holds every definition");

const organization = await rpc("getAccountInfo", [ORGANIZATION, { encoding: "base64" }]);
const organizationAuthority = base58(Buffer.from(organization.value.data[0], "base64").subarray(8, 40));
expect(organizationAuthority === vault, "the vault is the authority of solana.org");

const child = await startService();
const adapter = await startAdapter();
const provider = await startProvider();

try {
  console.log("the service reads the registry");
  const listing = await service("/v1/registry");
  expect(listing.interfaces.length === 6 && listing.implementations.length === 14, "it lists 6 interfaces and 14 implementations");

  const candidates = await service(
    "/v1/implementations",
    JSON.stringify({
      interface: "solana.org/token.transfer@^1",
      inputs: { from: sender.address, to: receiver.address, mint: USDC, amount: "1", memo: null },
      payers: { fee: payer.address },
    }),
  );
  const fitting = candidates.implementations.filter((candidate) => candidate.status === "applies").map((candidate) => candidate.id);
  expect(fitting.join() === "solana.org/spl-token-transfer", "implementationsFor picks spl-token-transfer for USDC");

  console.log("a USDC transfer and a SOL transfer in one transaction");
  await run(
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
  );
  expect((await tokenAmount(receiver.address, USDC)) === 100_000_000n, "the receiver holds 100 USDC");
  expect((await rpc("getBalance", [receiver.address])).value === 250_000_000, "the receiver holds 0.25 SOL");

  console.log("a USDC transfer as instructions alone, compiled to legacy, v0 with a lookup table, and v1");
  const senderUsdc = (await rpc("getTokenAccountsByOwner", [sender.address, { mint: USDC }, { encoding: "base64" }])).value[0].pubkey;
  const receiverUsdc = (await rpc("getTokenAccountsByOwner", [receiver.address, { mint: USDC }, { encoding: "base64" }])).value[0].pubkey;
  const lookupTable = keypair("lookup-table").address;
  await setLookupTable(rpc, lookupTable, [senderUsdc, receiverUsdc, USDC, "Sysvar1nstructions1111111111111111111111111"]);
  const receivedBefore = await tokenAmount(receiver.address, USDC);
  const transferRequest = plan(payer, [
    {
      interface: "solana.org/token.transfer@^1",
      implementation: "solana.org/spl-token-transfer@^1",
      inputs: { from: sender.address, to: receiver.address, mint: USDC, amount: "1000000", memo: null },
    },
  ]);
  await runEachVersion("transfer-instructions", transferRequest, [payer, sender], lookupTable);
  expect((await tokenAmount(receiver.address, USDC)) - receivedBefore === 3_000_000n, "the receiver holds 1 USDC more for each version");

  console.log("a Jupiter Lend deposit");
  await run(
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
  await run(
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

  console.log("an Ondo USDY deposit and withdrawal by a Jupiter route, from a remote recipe");
  const usdyBefore = await tokenAmount(sender.address, USDY);
  const deposit = await run(
    "ondo-deposit",
    plan(payer, [
      {
        interface: "solana.org/vault.deposit@^1",
        implementation: "solana.org/ondo-usdy-deposit@^1",
        inputs: { owner: sender.address, vault: USDY, asset: USDC, amount: "100000000", minShares: "80000000" },
      },
    ]),
    [payer, sender],
  );
  expect(deposit.message.includes("| endpoint: http://127.0.0.1:8791/jupiter | tier 2 |"), "the message names the endpoint and tier 2");
  const usdyGained = (await tokenAmount(sender.address, USDY)) - usdyBefore;
  expect(usdyGained >= 80_000_000n, `the sender holds ${usdyGained} more USDY, at least 80 USDY`);

  const usdcBefore2 = await tokenAmount(sender.address, USDC);
  await run(
    "ondo-withdraw",
    plan(payer, [
      {
        interface: "solana.org/vault.withdraw@^1",
        implementation: "solana.org/ondo-usdy-withdraw@^1",
        inputs: { owner: sender.address, vault: USDY, asset: USDC, shares: "50000000", minAmount: "50000000" },
      },
    ]),
  );
  expect((await tokenAmount(sender.address, USDC)) - usdcBefore2 >= 50_000_000n, "the withdrawal paid at least 50 USDC");

  console.log("a Hastra PRIME deposit, then a par redemption request and its cancellation");
  const primeBefore = await tokenAmount(sender.address, PRIME);
  await run(
    "hastra-deposit",
    plan(payer, [
      {
        interface: "solana.org/vault.deposit@^1",
        implementation: "solana.org/hastra-prime-deposit@^1",
        inputs: { owner: sender.address, vault: PRIME, asset: USDC, amount: "100000000", minShares: "80000000" },
      },
    ]),
    [payer, sender],
  );
  expect((await tokenAmount(sender.address, PRIME)) - primeBefore >= 80_000_000n, "the sender holds at least 80 more PRIME");

  // request_redeem makes the owner pay the request account's rent, so the owner is the rent payer.
  const asRentPayer = (request) => ({ ...request, payers: { fee: payer.address, rent: sender.address } });
  const requested = await run(
    "hastra-request",
    asRentPayer(
      plan(payer, [
        {
          interface: "solana.org/vault.withdraw@^1",
          implementation: "solana.org/hastra-prime-unstake@^1",
          inputs: { owner: sender.address, vault: PRIME, asset: WYLDS, shares: "50000000", minAmount: "50000000" },
        },
        {
          interface: "solana.org/vault.requestWithdrawal@^1",
          implementation: "solana.org/hastra-wylds-request@^1",
          inputs: { owner: sender.address, vault: WYLDS, asset: USDC, amount: "50000000" },
        },
      ]),
    ),
    [payer, sender],
  );
  expect(requested.message.includes("| settles later, outside this transaction |"), "the message says the request settles later");
  const wylds = await rpc("getTokenAccountsByOwner", [sender.address, { mint: WYLDS }, { encoding: "jsonParsed" }]);
  const delegated = wylds.value[0].account.data.parsed.info;
  expect(delegated.delegatedAmount?.amount === "50000000", `Hastra may take 50 wYLDS (${delegated.delegate})`);

  await run(
    "hastra-cancel",
    asRentPayer(
      plan(payer, [
        {
          interface: "solana.org/vault.cancelRequest@^1",
          implementation: "solana.org/hastra-wylds-cancel@^1",
          inputs: { owner: sender.address, vault: WYLDS },
        },
      ]),
    ),
    [payer, sender],
  );
  const cancelled = await rpc("getTokenAccountsByOwner", [sender.address, { mint: WYLDS }, { encoding: "jsonParsed" }]);
  expect(cancelled.value[0].account.data.parsed.info.delegate === undefined, "the cancellation revokes the delegate");

  console.log("a deposit request through a provider that signs its own transaction, at tier 3");
  await rpc("surfnet_setTokenAccount", [PROVIDER_WALLET, USDC, { amount: 0 }, TOKEN_PROGRAM]);
  const walletBefore = await tokenAmount(PROVIDER_WALLET, USDC);
  const provided = await run(
    "provider-deposit",
    plan(payer, [
      {
        interface: "solana.org/vault.requestDeposit@^1",
        implementation: "solana.org/test-provider-deposit@^1",
        inputs: { owner: sender.address, vault: NOPAL, asset: USDC, amount: "10000000" },
        options: { verifyIntent: false, assertions: false },
      },
    ]),
    [payer, sender],
  );
  expect(provided.message.includes("tier 3, checked by simulation only | onchain checks: none"), "the message names tier 3");
  expect(provided.transaction.presigned.length === 1, "the provider signed for its order account");
  expect((await tokenAmount(PROVIDER_WALLET, USDC)) - walletBefore === 10_000_000n, "the provider's wallet received 10 USDC");

  const instructionsRefused = await service(
    "/v1/prepare",
    JSON.stringify({ ...provided.request, options: { output: "instructions" } }),
  ).then(
    () => undefined,
    (error) => error.message,
  );
  expect(instructionsRefused?.includes("no instructions to give") === true, "a provider's transaction has no instructions to give");

  const providerUsdc = (await rpc("getTokenAccountsByOwner", [PROVIDER_WALLET, { mint: USDC }, { encoding: "base64" }])).value[0].pubkey;
  await setLookupTable(rpc, lookupTable, [senderUsdc, providerUsdc, USDC]);

  for (const [version, table] of [["legacy", null], ["0", lookupTable]]) {
    await fetch("http://127.0.0.1:8792/format", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version, lookupTable: table }) });
    const before = await tokenAmount(PROVIDER_WALLET, USDC);
    const signed = await run(`provider-deposit-${version}`, provided.request, [payer, sender]);
    expect(signed.transaction.version === (version === "legacy" ? "legacy" : 0), `the provider's ${version} transaction stays ${version}`);
    expect((await tokenAmount(PROVIDER_WALLET, USDC)) - before === 10_000_000n, `the provider's ${version} transaction landed`);
  }

  await fetch("http://127.0.0.1:8792/format", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "1" }) });

  console.log("an endpoint that adds an approval to an attacker");
  await fetch("http://127.0.0.1:8791/mode", { method: "POST", body: JSON.stringify({ malicious: true }) });
  const refused = await service(
    "/v1/prepare",
    JSON.stringify(
      plan(payer, [
        {
          interface: "solana.org/vault.deposit@^1",
          implementation: "solana.org/ondo-usdy-deposit@^1",
          inputs: { owner: sender.address, vault: USDY, asset: USDC, amount: "10000000", minShares: "8000000" },
        },
      ]),
    ),
  ).then(
    () => undefined,
    (error) => error.message,
  );
  await fetch("http://127.0.0.1:8791/mode", { method: "POST", body: JSON.stringify({ malicious: false }) });
  // The segment's Lighthouse assertions fail in the planner's simulation, as they would onchain.
  const assertionFailed = refused?.includes("Program L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 failed") === true;
  expect(assertionFailed || refused?.includes("breaks a guarantee") === true, "the service refuses it: the assertions fail");

  console.log("every flow landed");
} finally {
  child.kill();
  adapter.kill();
  provider.kill();
}
