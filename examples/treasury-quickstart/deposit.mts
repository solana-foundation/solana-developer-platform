import { randomUUID } from "node:crypto";

const api = `${process.env.SDP_API_URL ?? "https://api-beta.solana.com"}/v1`;
const headers = {
  Authorization: `Bearer ${process.env.SDP_API_KEY}`,
  "Content-Type": "application/json",
};

/** Returns the response's `data`, or throws the API's error. */
async function data(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.data;
}

// Find your custody wallet's ID by its address.
const { wallets }: { wallets: { id: string; publicKey: string }[] } = await fetch(
  `${api}/wallets`,
  { headers },
).then(data);
const wallet = wallets.find((w) => w.publicKey === process.env.WALLET);
if (!wallet) throw new Error("This API key cannot see that wallet");

type Strategy = {
  id: string;
  status: string;
  fundable: boolean;
  depositMints: string[];
  depositSlippage: object | null;
};

// Fetch the strategies your project can see.
const { strategies }: { strategies: Strategy[] } = await fetch(
  `${api}/earn/strategies?pageSize=100`,
  { headers },
).then(data);

// Take one that is open for deposits, takes devnet USDC, and needs no slippage floor.
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const strategy = strategies.find(
  (s) => s.fundable && s.status === "active" && s.depositSlippage === null
    && s.depositMints[0] === USDC,
);
if (!strategy) throw new Error("No devnet USDC strategy is open for deposits");

// Deposit 10 USDC. Each new deposit takes a new idempotency key.
const deposit = await fetch(`${api}/earn/vault-deposits`, {
  method: "POST",
  headers: { ...headers, "Idempotency-Key": randomUUID() },
  body: JSON.stringify({ strategyId: strategy.id, custodyWalletId: wallet.id, amount: "10" }),
}).then(data);

// Poll until the network confirms the deposit.
let record;
do {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  ({ deposit: record } = await fetch(`${api}/earn/vault-deposits/${deposit.movementId}`, {
    headers,
  }).then(data));
} while (record.status !== "confirmed" && record.status !== "failed");

// Read your project's custody positions.
const { positions } = await fetch(`${api}/earn/vault-positions`, { headers }).then(data);
console.log(record.status, positions);
