/**
 * E2E driver for the external-wallet vault flow (PRO-1722) against a local
 * API + Surfpool devnet fork. Prints one PASS/FAIL line per check.
 */
import {
  generateKeyPair,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";

const API = "http://127.0.0.1:8787";
const KEY = "sk_test_abcdefghijklmnopqrstuvwxyz123456";
const RPC = "http://127.0.0.1:8899";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} :: ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as any;
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function api(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function decodeTx(b64: string) {
  return getTransactionDecoder().decode(Uint8Array.from(Buffer.from(b64, "base64")));
}
function encodeTx(tx: any): string {
  return Buffer.from(getTransactionEncoder().encode(tx)).toString("base64");
}
async function sign(b64: string, kp: CryptoKeyPair): Promise<string> {
  return encodeTx(await partiallySignTransaction([kp], decodeTx(b64)));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForSignature(signature: string, label: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const statuses = await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const s = statuses.value?.[0];
    if (s?.err) throw new Error(`${label} failed on chain: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "finalized" || s?.confirmationStatus === "confirmed") return;
    await sleep(1000);
  }
  throw new Error(`${label} never landed`);
}

// ── Setup: owner wallet funded on the fork ─────────────────────────────────
const kp = await generateKeyPair();
const owner = await getAddressFromPublicKey(kp.publicKey);
console.log(`owner: ${owner}`);
await rpc("requestAirdrop", [owner, 2_000_000_000]);
await rpc("surfnet_setTokenAccount", [owner, USDC, { amount: 100_000_000 }]);
const usdcBefore = await rpc("getTokenAccountsByOwner", [owner, { mint: USDC }, { encoding: "jsonParsed" }]);
check("setup: owner holds 100 devnet USDC on the fork",
  usdcBefore.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString === "100");

// ── Resolve the strategy ───────────────────────────────────────────────────
const strategies = await api("/v1/earn/strategies?pageSize=100");
const allez = strategies.body?.data?.strategies?.find((s: any) => s.name === "Allez USDC");
const paused = strategies.body?.data?.strategies?.find((s: any) => s.name === "Steakhouse USDC");
check("setup: Allez USDC strategy resolvable", Boolean(allez), strategies.status);
check("setup: paused strategy hidden from catalogue reads", paused === undefined);

// ── Deposit: build ─────────────────────────────────────────────────────────
const build1 = await api("/v1/earn/external-wallet/deposit-transactions", {
  method: "POST",
  body: { strategyId: allez.id, ownerAddress: owner, amount: "5" },
});
check("deposit build: 200 with unsigned transaction", build1.status === 200 && Boolean(build1.body?.data?.transaction?.transaction), build1);
const b1 = build1.body.data.transaction;
check("deposit build: names the owner and instrument", b1.ownerAddress === owner && b1.providerReference === allez.providerReference && b1.tokenMint === USDC && b1.amount === "5");
const unsigned1 = decodeTx(b1.transaction);
check("deposit build: owner is the only (unfilled) signer",
  Object.keys(unsigned1.signatures).length === 1 && unsigned1.signatures[owner as keyof typeof unsigned1.signatures] === null);

// ── Deposit: submit ────────────────────────────────────────────────────────
const signed1 = await sign(b1.transaction, kp);
const k1 = crypto.randomUUID();
const submit1 = await api("/v1/earn/external-wallet/deposits", {
  method: "POST",
  headers: { "Idempotency-Key": k1 },
  body: { transactionId: b1.transactionId, signedTransaction: signed1 },
});
check("deposit submit: 200", submit1.status === 200, submit1);
const dep = submit1.body?.data?.deposit;
check("deposit submit: movement recorded and attributed to the owner",
  dep?.ownerAddress === owner && dep?.direction === "deposit" && dep?.denomination === USDC && dep?.amount === "5" && dep?.replayed === false && Boolean(dep?.positionId) && Boolean(dep?.signature),
  dep);
check("deposit submit: ledger vocabulary status", ["requested", "submitted"].includes(dep?.status), dep?.status);
await waitForSignature(dep.signature, "deposit");
check("deposit: transaction landed on the fork", true);

// ── Deposit: replay ────────────────────────────────────────────────────────
const replay1 = await api("/v1/earn/external-wallet/deposits", {
  method: "POST",
  headers: { "Idempotency-Key": k1 },
  body: { transactionId: b1.transactionId, signedTransaction: signed1 },
});
check("replay: same key resolves the ORIGINAL movement, replayed:true",
  replay1.status === 200 && replay1.body?.data?.deposit?.replayed === true && replay1.body?.data?.deposit?.movementId === dep.movementId,
  replay1);

// ── Rejection matrix ───────────────────────────────────────────────────────
const rejections: Array<[string, () => Promise<{ status: number; body: any }>, number]> = [
  ["missing Idempotency-Key", () => api("/v1/earn/external-wallet/deposits", { method: "POST", body: { transactionId: b1.transactionId, signedTransaction: signed1 } }), 400],
  ["body requestId rejected", () => api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: { transactionId: b1.transactionId, signedTransaction: signed1, requestId: crypto.randomUUID() } }), 400],
  ["Dry-Run refused on submit", () => api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID(), "Dry-Run": "true" }, body: { transactionId: b1.transactionId, signedTransaction: signed1 } }), 400],
  ["new key against consumed build", () => api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: { transactionId: b1.transactionId, signedTransaction: signed1 } }), 409],
  ["unknown transactionId", () => api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: { transactionId: "earn_external_wallet_transaction_00000000-0000-4000-8000-000000000000", signedTransaction: signed1 } }), 404],
  ["non-base64 signedTransaction", () => api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: { transactionId: b1.transactionId, signedTransaction: "not base64!!" } }), 400],
  ["unknown strategy build", () => api("/v1/earn/external-wallet/deposit-transactions", { method: "POST", body: { strategyId: "strat_missing", ownerAddress: owner, amount: "5" } }), 404],
  ["paused strategy build refused", () => api("/v1/earn/external-wallet/deposit-transactions", { method: "POST", body: { strategyId: "PAUSED_ID", ownerAddress: owner, amount: "5" } }), 400],
  ["invalid ownerAddress", () => api("/v1/earn/external-wallet/deposit-transactions", { method: "POST", body: { strategyId: allez.id, ownerAddress: "nope", amount: "5" } }), 400],
  ["unknown position withdrawal build", () => api("/v1/earn/external-wallet/withdrawal-transactions", { method: "POST", body: { positionId: "earn_position_missing", shares: "1" } }), 404],
];
// The paused strategy is invisible to the catalogue read, so its id comes from
// the environment (set below by the shell wrapper).
const PAUSED_ID = process.env.PAUSED_STRATEGY_ID ?? "";
for (const [name, run, expected] of rejections) {
  const fixed = name === "paused strategy build refused"
    ? () => api("/v1/earn/external-wallet/deposit-transactions", { method: "POST", body: { strategyId: PAUSED_ID, ownerAddress: owner, amount: "5" } })
    : run;
  const res = await fixed();
  check(`reject: ${name} -> ${expected}`, res.status === expected, { got: res.status, body: res.body?.error });
}

// Message-integrity rejections need fresh, unconsumed builds.
const buildC = await api("/v1/earn/external-wallet/deposit-transactions", { method: "POST", body: { strategyId: allez.id, ownerAddress: owner, amount: "5" } });
const buildD = await api("/v1/earn/external-wallet/deposit-transactions", { method: "POST", body: { strategyId: allez.id, ownerAddress: owner, amount: "5" } });
const c = buildC.body.data.transaction;
const d = buildD.body.data.transaction;

const crossSigned = await sign(d.transaction, kp);
const cross = await api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: { transactionId: c.transactionId, signedTransaction: crossSigned } });
check("reject: signed bytes of a DIFFERENT build -> 400", cross.status === 400, cross.body?.error);

const unsignedSubmit = await api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: { transactionId: c.transactionId, signedTransaction: c.transaction } });
check("reject: unsigned bytes -> 400 missing owner signature", unsignedSubmit.status === 400, unsignedSubmit.body?.error);

const signedC = await sign(c.transaction, kp);
const forgedTx = decodeTx(signedC) as any;
const forgedSig = new Uint8Array(forgedTx.signatures[owner]);
forgedSig[0] ^= 0xff;
const forged = { ...forgedTx, signatures: { ...forgedTx.signatures, [owner]: forgedSig } };
const forgedSubmit = await api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: { transactionId: c.transactionId, signedTransaction: encodeTx(forged) } });
check("reject: forged owner signature -> 400", forgedSubmit.status === 400, forgedSubmit.body?.error);

const k2 = crypto.randomUUID();
const submitC = await api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": k2 }, body: { transactionId: c.transactionId, signedTransaction: signedC } });
check("second deposit submit: 200 (same owner, adds to the position)", submitC.status === 200, submitC);
const dep2 = submitC.body?.data?.deposit;
check("second deposit: same position, new movement", dep2?.positionId === dep.positionId && dep2?.movementId !== dep.movementId);
await waitForSignature(dep2.signature, "second deposit");

const keyReuse = await api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": k2 }, body: { transactionId: d.transactionId, signedTransaction: crossSigned } });
check("reject: key reused for a different build -> 409", keyReuse.status === 409, keyReuse.body?.error);

// ── Exit ───────────────────────────────────────────────────────────────────
let shares = "0";
for (let i = 0; i < 30; i++) {
  const shareAccounts = await rpc("getTokenAccountsByOwner", [owner, { mint: allez.shareMint }, { encoding: "jsonParsed" }]);
  shares = shareAccounts.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? "0";
  if (shares !== "0") break;
  await sleep(1000);
}
check("deposit: owner holds vault shares on chain", shares !== "0", shares);
console.log(`shares held: ${shares}`);

const wbuild = await api("/v1/earn/external-wallet/withdrawal-transactions", { method: "POST", body: { positionId: dep.positionId, shares } });
check("exit build: 200 with unsigned transaction", wbuild.status === 200 && Boolean(wbuild.body?.data?.transaction?.transaction), wbuild);
const w = wbuild.body.data.transaction;
check("exit build: names the position and shares", w.positionId === dep.positionId && w.shares === shares && w.ownerAddress === owner);

const signedW = await sign(w.transaction, kp);
const k3 = crypto.randomUUID();
const wsubmit = await api("/v1/earn/external-wallet/withdrawals", { method: "POST", headers: { "Idempotency-Key": k3 }, body: { transactionId: w.transactionId, signedTransaction: signedW } });
check("exit submit: 200", wsubmit.status === 200, wsubmit);
const wd = wsubmit.body?.data?.withdrawal;
check("exit submit: withdrawal movement attributed to the owner",
  wd?.ownerAddress === owner && wd?.direction === "withdrawal" && wd?.denomination === allez.shareMint && wd?.amount === shares && wd?.positionId === dep.positionId,
  wd);
await waitForSignature(wd.signature, "withdrawal");
check("exit: transaction landed on the fork", true);

const wreplay = await api("/v1/earn/external-wallet/withdrawals", { method: "POST", headers: { "Idempotency-Key": k3 }, body: { transactionId: w.transactionId, signedTransaction: signedW } });
check("exit replay: same key resolves the original", wreplay.status === 200 && wreplay.body?.data?.withdrawal?.replayed === true && wreplay.body?.data?.withdrawal?.movementId === wd.movementId, wreplay);

// cross-direction: submit the (already consumed) withdrawal build to the DEPOSIT route
const crossDirection = await api("/v1/earn/external-wallet/deposits", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: { transactionId: w.transactionId, signedTransaction: signedW } });
check("reject: withdrawal build on the deposit route -> 404", crossDirection.status === 404, crossDirection.body?.error);

// funds actually moved back
const usdcAfter = await rpc("getTokenAccountsByOwner", [owner, { mint: USDC }, { encoding: "jsonParsed" }]);
const usdcFinal = usdcAfter.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
console.log(`USDC after round trip: ${usdcFinal}`);
check("round trip: USDC returned to the owner (net of any vault rounding)", Number(usdcFinal) > 99.9, usdcFinal);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
console.log(JSON.stringify({ owner, positionId: dep.positionId, movements: [dep.movementId, dep2.movementId, wd.movementId], builds: [b1.transactionId, c.transactionId, d.transactionId, w.transactionId] }));
process.exit(fail === 0 ? 0 : 1);
