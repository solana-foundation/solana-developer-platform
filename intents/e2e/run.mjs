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
const RING_SERVICES = new URL("../programs/tools/zolana-services.mjs", import.meta.url).pathname;
const RING_INDEXER = "http://127.0.0.1:8784";
const SOL_MINT = "11111111111111111111111111111111";
const PROVIDER_WALLET = "ProviderWa11et11111111111111111111111111111";
const NOPAL = "GArhnnDj3GYhmQeApKVXaRv4TQFwhPcs3SNF6FXsTeXq";
const USDY = "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6";
const PRIME = "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7";
const WYLDS = "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih";
const SERVICE_LISTEN = "127.0.0.1:8788";
const SERVICE = `http://${SERVICE_LISTEN}`;
const LOCAL_WALLET_BINARY = new URL("../target/debug/sdp-intents-local-wallet", import.meta.url).pathname;
const WALLET_LISTEN = "127.0.0.1:8795";
const WALLET = `http://${WALLET_LISTEN}`;
const OUT = new URL("../target/e2e/", import.meta.url).pathname;
const WALLETS = `${OUT}wallets/`;

const rpc = rpcClient(RPC);
const verifier = await Verifier.load(
  readFileSync(new URL("../../packages/sdp-intents-verifier/wasm/verifier.wasm", import.meta.url)),
);
const keypair = (name) => keypairIn(WALLETS, name);

async function call(base, path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body };
  const answer = await (await fetch(`${base}${path}`, init)).json();

  if (answer.error) throw new Error(`${path}: ${answer.error.message}\n${JSON.stringify(answer.error.details)}`);

  return answer;
}

const service = (path, body) => call(SERVICE, path, body);

/// The playground's wallet, which holds the keys in `WALLETS`.
const wallet = (path, body) => call(WALLET, path, body);

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

/// The service holds no key and calls no wallet: the caller's wallet builds each shielded spend. It
/// runs a prover for a wallet that asks the service to prove.
const startService = () =>
  start(
    SERVICE_BINARY,
    ["--rpc", RPC, "--listen", SERVICE_LISTEN, "--allow-tamper", "--prover", "http://127.0.0.1:3001"],
    `${SERVICE}/health`,
  );

/// The wallet holds the keys in `WALLETS`, so it starts after they exist. It registers them in
/// Privacy Rings, so it starts after the ring's services.
const startWallet = () =>
  start(
    LOCAL_WALLET_BINARY,
    ["--rpc", RPC, "--listen", WALLET_LISTEN, "--wallets", WALLETS, "--ring-indexer", RING_INDEXER, "--service", SERVICE],
    `${WALLET}/health`,
  );

/// Zolana's Photon indexer and prover, which a shielded spend reads.
async function startRing() {
  const ring = await start(process.execPath, [RING_SERVICES, RPC], "http://127.0.0.1:3001");
  await start("true", [], RING_INDEXER);

  return ring;
}

/// The wallet builds `spend`, the `spend` of a `build`, and proves it in the wallet or on the service.
const build = (spend, prover = "wallet") => wallet("/shielded/build", JSON.stringify({ spend, prover }));

/// Runs the loop of `DESIGN.md`, 4.1 from a `start` answer until done: signs each step with the
/// service's wallets, and waits out each `wait`. Returns the last answer and what each turn asked.
async function runFlow(first, resumed) {
  let answer = resumed ?? first;
  const kinds = resumed === undefined ? [] : [`build ${first.next.step}`];

  for (let turn = 0; turn < 20 && answer.next.kind !== "done"; turn += 1) {
    if (answer.next.kind === "sign") {
      kinds.push(`sign ${answer.next.steps.map((step) => step.name).join(" ")}`);
      const signatures = [];

      for (const step of answer.next.steps) {
        const sent = await wallet("/send", JSON.stringify({ message: step.transaction.messageBytes }));
        signatures.push(sent.signature);
      }

      answer = await service("/v1/intents/continue", JSON.stringify({ progress: answer.progress, signatures }));
    } else if (answer.next.kind === "build") {
      kinds.push(`build ${answer.next.step}`);
      const built = await build(answer.next.spend);
      answer = await service("/v1/intents/continue", JSON.stringify({ progress: answer.progress, built }));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      answer = await service("/v1/intents/continue", JSON.stringify({ progress: answer.progress }));
    }
  }

  return { answer, kinds };
}

/// Whether the wallet refuses to send the first step of `answer`, with a message that holds `reason`.
async function sendRefusal(answer, reason) {
  const message = answer.next?.steps?.[0]?.transaction?.messageBytes;
  if (message === undefined) throw new Error(`no step to sign: ${JSON.stringify(answer).slice(0, 400)}`);

  const refused = await wallet("/send", JSON.stringify({ message })).then(
    () => undefined,
    (error) => error.message,
  );

  return refused?.includes(reason) === true;
}

/// The private SOL of the local wallet `address`, once it reaches `lamports`.
async function ringBalanceReaches(address, lamports) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { wallets } = await wallet("/ring");
    if (wallets.find((wallet) => wallet.address === address)?.lamports === lamports) return true;

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

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
    const sent = await wallet("/send", JSON.stringify({ message: compiled, presigned }));
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

const ring = await startRing();
const localWallet = await startWallet();
const child = await startService();
const adapter = await startAdapter();
const provider = await startProvider();

try {
  console.log("the service reads the registry");
  const listing = await service("/v1/registry");
  expect(
    listing.interfaces.length === 9 && listing.implementations.length === 18 && listing.circuits.length === 1,
    "it lists 9 interfaces, 18 implementations, and 1 circuit",
  );

  const transfer = await service("/v1/interfaces/solana.org/token.transfer");
  expect(transfer.head === "1.0.0", "the interface's head is 1.0.0");

  const published = await service("/v1/interfaces/solana.org/token.transfer/versions/1.0.0");
  expect(published.document.id === "solana.org/token.transfer", "the service decompiles the interface's document");

  const recipe = (await service("/v1/implementations/solana.org/token-2022-transfer/versions/1.0.0")).document.recipe;
  expect(recipe.kind === "program" && recipe.data.some((segment) => segment.value === "{builder.bumps}"), "and an implementation's, with its builder call");

  const candidates = await service(
    "/v1/interfaces/solana.org/token.transfer/versions/1.0.0/matches",
    JSON.stringify({
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

  console.log("a private transfer through the privacy ring");
  await wallet("/ring/shield", JSON.stringify({ address: sender.address, lamports: 1_000_000_000 }));
  expect(await ringBalanceReaches(sender.address, 1_000_000_000), "the sender shields 1 SOL");

  const privateTransfer = plan(sender, [
    {
      interface: "solana.org/private.transfer@^1",
      implementation: "solana.org/privacy-rings-transfer@^1",
      inputs: { from: sender.address, to: payer.address, mint: SOL_MINT, amount: "250000000" },
    },
  ]);
  const transferStarted = await service("/v1/intents/start", JSON.stringify(privateTransfer));
  expect(
    transferStarted.next.kind === "build" && transferStarted.next.spend.notes[0].owner === payer.address,
    "the service asks the caller's wallet to build the spend, and builds nothing itself",
  );
  expect(
    transferStarted.next.spend.circuit.name === "privacy-rings" && transferStarted.next.spend.circuit.version === "1.0.0",
    "the spend names the circuit that the registry holds",
  );

  const built = await build(transferStarted.next.spend, "service");
  const signing = await service("/v1/intents/continue", JSON.stringify({ progress: transferStarted.progress, built }));
  const shielded = signing.next.steps[0];
  expect(
    shielded.message.includes("| shielded | tier 2 | onchain checks: verify_intent, assertions"),
    "the shielded spend runs with verify_intent and the assertions",
  );
  expect(await typescriptProves(shielded.transaction.messageBytes, shielded), "the verifier proves the spend's message");

  const unasserted = await service(
    "/v1/intents/start",
    JSON.stringify(plan(sender, [{ ...privateTransfer.intents[0], options: { assertions: false } }])),
  ).then(
    () => undefined,
    (error) => error.message,
  );
  expect(unasserted?.includes("needs `assertions`") === true, "a shielded spend with verify_intent needs the assertions");

  const transferred = await runFlow(signing);
  expect(transferred.answer.next.kind === "done", `the transfer is done: ${transferred.answer.next.message}`);
  expect(await ringBalanceReaches(payer.address, 250_000_000), "the payer holds 0.25 SOL privately");
  expect(await ringBalanceReaches(sender.address, 750_000_000), "the sender keeps 0.75 SOL privately");

  console.log("a service that changes the spend after the wallet built it");
  const tamperStart = await service("/v1/intents/start", JSON.stringify(privateTransfer));
  const tamperBuilt = await build(tamperStart.next.spend);
  const tampered = await fetch(`${SERVICE}/v1/intents/continue`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sdp-tamper": "1" },
    body: JSON.stringify({ progress: tamperStart.progress, built: tamperBuilt }),
  }).then((response) => response.json());
  expect(await sendRefusal(tampered, "did not build the spend"), "the wallet refuses a spend that it did not build");

  console.log("a service that asks the wallet to build other notes than the intent's");
  const forgeStart = await service("/v1/intents/start", JSON.stringify(privateTransfer));
  const forgedSpend = {
    ...forgeStart.next.spend,
    notes: forgeStart.next.spend.notes.map((note) => ({ ...note, owner: authority.address })),
  };
  const forgedBuilt = await build(forgedSpend);
  const forged = await service("/v1/intents/continue", JSON.stringify({ progress: forgeStart.progress, built: forgedBuilt }));
  expect(
    await sendRefusal(forged, "does not do what its intent requires"),
    "the wallet refuses to sign a statement that the intent does not require",
  );

  console.log("a service that names proving keys that the wallet does not hold");
  const otherKeys = { ...forgeStart.next.spend, circuit: { ...forgeStart.next.spend.circuit, provingKeys: "00".repeat(32) } };
  const unknownKeys = await build(otherKeys).then(
    () => undefined,
    (error) => error.message,
  );
  expect(unknownKeys?.includes("does not hold") === true, "the wallet refuses to build with an unknown key set");

  console.log("a flow of two steps: shield public SOL, then send it privately");
  const send = plan(payer, [
    {
      interface: "solana.org/private.transfer@^1",
      implementation: "solana.org/privacy-rings-shield-and-transfer@^1",
      inputs: { from: payer.address, to: sender.address, mint: SOL_MINT, amount: "500000000" },
    },
  ]);
  const started = await service("/v1/intents/start", JSON.stringify(send));
  const shieldBuilt = await build(started.next.spend);
  const shieldSigning = await service("/v1/intents/continue", JSON.stringify({ progress: started.progress, built: shieldBuilt }));
  const again = await service("/v1/intents/continue", JSON.stringify({ progress: shieldSigning.progress }));
  expect(
    again.next.steps?.[0].transaction.messageBytes === shieldSigning.next.steps?.[0].transaction.messageBytes,
    "continue without a signature returns the same transaction",
  );

  const { answer, kinds } = await runFlow(started, shieldSigning);
  expect(
    kinds.join(", ") === "build shield, sign shield, build transfer, sign transfer",
    `the flow asks the wallet to build and sign the shield, then the transfer (${kinds.join(", ")})`,
  );
  expect(answer.next.kind === "done", `the flow is done: ${answer.next.message}`);
  expect(await ringBalanceReaches(sender.address, 1_250_000_000), "the sender holds 1.25 SOL privately");
  expect(await ringBalanceReaches(payer.address, 250_000_000), "the payer keeps 0.25 SOL privately");

  console.log("an unshield: private SOL out of the ring to a public address");
  const unshield = plan(payer, [
    {
      interface: "solana.org/private.unshield@^1",
      implementation: "solana.org/privacy-rings-unshield@^1",
      inputs: { owner: sender.address, to: authority.address, mint: SOL_MINT, amount: "250000000" },
    },
  ]);
  const unshieldStarted = await service("/v1/intents/start", JSON.stringify(unshield));
  const withdrawal = unshieldStarted.next.spend?.withdrawals?.[0];
  expect(
    withdrawal?.account === authority.address && unshieldStarted.next.spend.notes.length === 0,
    "the statement creates no note and withdraws to the recipient",
  );

  const before = (await rpc("getBalance", [authority.address])).value;
  const unshielded = await runFlow(unshieldStarted);
  expect(unshielded.answer.next.kind === "done", `the unshield is done: ${unshielded.answer.next.message}`);
  expect((await rpc("getBalance", [authority.address])).value - before === 250_000_000, "the recipient receives 0.25 SOL");
  expect(await ringBalanceReaches(sender.address, 1_000_000_000), "the sender keeps 1 SOL privately");

  console.log("every flow landed");
} finally {
  child.kill();
  adapter.kill();
  provider.kill();
  localWallet.kill();
  ring.kill();
}
