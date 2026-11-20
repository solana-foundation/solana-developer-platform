import { depositAndTrack, type SavedRequest } from "./earn.ts";

const connected = process.argv.includes("--connected-wallet");
const saved: SavedRequest[] = [];
const operation = {
  id: "operation_demo",
  actionId: "action_demo",
  version: 1,
  status: "prepared",
  nextAction: connected
    ? { type: "submit" }
    : {
        type: "sign_transaction",
        transaction: Buffer.from("demo unsigned transaction").toString("base64"),
      },
  terms: { estimate: { mint: "demo-usdc", value: "10" }, fees: [] },
};
let polls = 0;
console.log("DRY RUN: local fake responses and signature. No network calls or funds.");
const result = await depositAndTrack({
  apiUrl: "https://api-devnet.solana.com",
  apiKey: "dry-run-only",
  deposit: {
    strategyId: "strategy_demo",
    source: connected ? { walletId: "cwlt_demo" } : { ownerAddress: "owner_demo" },
    amount: { mint: "demo-usdc", value: "10" },
    slippageBps: 50,
  },
  keys: { prepare: "saved-prepare-key", submit: "saved-submit-key" },
  save: async (request) => {
    saved.push(request);
  },
  review: async (prepared) => {
    console.log("Review:", JSON.stringify(prepared.terms));
  },
  signTransaction: async () => {
    console.log("Your wallet signs outside SDP (fake signature in this dry run).");
    return Buffer.from("demo signed transaction").toString("base64");
  },
  observe: (current) => console.log(current.status, current.nextAction?.instructions ?? ""),
  wait: async () => {},
  fetchRequest: async (url, init) => {
    const path = new URL(String(url)).pathname;
    console.log(`${init?.method ?? "GET"} ${path}`);
    if (path === "/v1/earn/deposit") return Response.json({ data: { operation } }, { status: 202 });
    if (path.endsWith("/submit")) {
      return Response.json(
        { data: { operation: { ...operation, status: "queued", nextAction: { type: "wait" } } } },
        { status: 202 }
      );
    }
    polls += 1;
    return Response.json({
      data: {
        operation: {
          ...operation,
          status: connected && polls === 1 ? "awaiting_signature" : "completed",
          nextAction:
            connected && polls === 1
              ? { type: "sign_in_provider", instructions: "Sign in your connected wallet provider" }
              : null,
        },
      },
    });
  },
});
console.log(`Result: ${result.status}; ${saved.length} saved mutation requests.`);
