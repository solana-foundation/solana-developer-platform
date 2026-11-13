import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createKeyPairFromBytes,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";

const api = `${process.env.SDP_API_URL ?? "https://api-beta.solana.com"}/v1/earn`;
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

// Sandbox only: a local keypair stands in for your customer's wallet.
const keyPair = await createKeyPairFromBytes(
  new Uint8Array(JSON.parse(await readFile("test-wallet.json", "utf8"))),
);
const ownerAddress = await getAddressFromPublicKey(keyPair.publicKey);

type Strategy = {
  id: string;
  status: string;
  fundable: boolean;
  depositMints: string[];
  depositSlippage: object | null;
};

// Fetch the strategies your project can see.
const { strategies }: { strategies: Strategy[] } = await fetch(
  `${api}/strategies?pageSize=100`,
  { headers },
).then(data);

// Take one that is open for deposits, takes devnet USDC, and needs no slippage floor.
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const strategy = strategies.find(
  (s) => s.fundable && s.status === "active" && s.depositSlippage === null
    && s.depositMints[0] === USDC,
);
if (!strategy) throw new Error("No devnet USDC strategy is open for deposits");

// Build an unsigned deposit of 10 USDC from the wallet.
const { transaction: built } = await fetch(`${api}/external-wallet/deposit-transactions`, {
  method: "POST",
  headers,
  body: JSON.stringify({ strategyId: strategy.id, ownerAddress, amount: "10" }),
}).then(data);

// Sign the exact bytes SDP built.
const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(built.transaction));
const signedTransaction = getBase64EncodedWireTransaction(
  await partiallySignTransaction([keyPair], unsigned),
);

// Submit it. Each new deposit takes a new idempotency key.
const { deposit } = await fetch(`${api}/external-wallet/deposits`, {
  method: "POST",
  headers: { ...headers, "Idempotency-Key": randomUUID() },
  body: JSON.stringify({ transactionId: built.transactionId, signedTransaction }),
}).then(data);

// Poll until the deposit is final.
let movement;
do {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  ({ movement } = await fetch(`${api}/external-wallet/movements/${deposit.movementId}`, {
    headers,
  }).then(data));
} while (movement.status !== "finalized" && movement.status !== "failed");

// Read the wallet's positions.
const { positions } = await fetch(
  `${api}/external-wallet/positions?ownerAddress=${ownerAddress}`,
  { headers },
).then(data);
console.log(movement.status, positions);
