import { deposit, type Operation } from "./earn.ts";

const prepared: Operation = {
  id: "op_demo",
  status: "prepared",
  actionId: "opa_demo",
  version: 1,
  terms: { estimate: { mint: "demo-share-mint", value: "9.84" }, fees: null },
  nextAction: { type: "sign_transaction", transaction: btoa("demo unsigned transaction") },
};
const states = ["queued", "submitted", "completed"];

/** Local fake responses: no network calls, keys or funds. */
const fakeFetch: typeof fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  console.log(`${init?.method ?? "GET"} ${path}`);
  const status = path === "/v1/earn/deposit" ? "prepared" : (states.shift() ?? "completed");
  const operation = status === "prepared" ? prepared : { ...prepared, status, nextAction: null };
  return Response.json({ data: { operation } }, { status: init?.method === "POST" ? 202 : 200 });
};

console.log("DRY RUN: fake responses and a fake signature.");
const result = await deposit({
  apiUrl: "https://api-devnet.solana.com",
  apiKey: "dry-run",
  deposit: {
    strategyId: "earn_strategy_demo",
    source: { ownerAddress: "DemoOwner1111111111111111111111111111111111" },
    amount: { mint: "demo-usdc-mint", value: "10" },
    slippageBps: 50,
  },
  idempotencyKey: crypto.randomUUID(),
  sign: async (_transaction, operation) => {
    console.log("Review terms:", JSON.stringify(operation.terms));
    console.log("Sign in the owner's wallet (faked here).");
    return btoa("demo signed transaction");
  },
  fetch: fakeFetch,
  pollIntervalMs: 0,
});
console.log(`Result: ${result.status}`);
