import { DEFAULT_SDP_API_URL, type EarnStrategy } from "@sdp/types";

export function earnButtonIntegrationPath(publicToken: string): string {
  return `/earn/integrate/${encodeURIComponent(publicToken)}`;
}

/**
 * The B2B2C money path, exactly as shipped (PRO-1722): the partner's backend
 * BUILDS an unsigned transaction for the customer's own wallet, the wallet
 * signs it in the browser, and the backend SUBMITS the signed bytes — SDP
 * verifies the signature, records the deposit, then broadcasts.
 *
 * A server-only example by construction: the API key comes from process.env
 * and the browser/mobile button is expected to call this partner-owned
 * backend. The customer's key never leaves their wallet, and the partner's
 * key never reaches the browser. Callers that know the deployment's real API
 * base (the handoff page resolves one for its own fetch) pass it so the
 * snippet targets the same host.
 */
export function buildEarnServerIntegration(
  strategy: Pick<EarnStrategy, "id">,
  apiBaseUrl?: string
): string {
  return `const SDP_API_URL = ${JSON.stringify(apiBaseUrl ?? DEFAULT_SDP_API_URL)};

function sdpHeaders(extra: Record<string, string> = {}) {
  const apiKey = process.env.SDP_API_KEY;
  if (!apiKey) throw new Error("SDP_API_KEY is required");
  return {
    Authorization: \`Bearer \${apiKey}\`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/**
 * Step 1 — build. SDP returns an UNSIGNED transaction for your customer's
 * wallet: it is the fee payer and the only required signer. Hand the base64
 * \`transaction\` to the wallet in the browser, e.g. with wallet-adapter:
 *
 *   const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
 *   const signed = await wallet.signTransaction(tx);
 *   const signedTransaction = Buffer.from(signed.serialize()).toString("base64");
 *
 * A built transaction expires with its blockhash (about a minute); build a
 * fresh one if the customer walks away before signing.
 */
export async function buildEarnDepositTransaction({
  ownerAddress,
  amount,
  minSharesOut,
}: {
  /** The customer's Solana wallet address. */
  ownerAddress: string;
  /** Deposit amount in the vault token's units, as a decimal string. */
  amount: string;
  /** Minimum acceptable shares, derived from your quote and slippage tolerance. */
  minSharesOut: string;
}) {
  const response = await fetch(\`\${SDP_API_URL}/v1/earn/external-wallet/deposit-transactions\`, {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({
      strategyId: ${JSON.stringify(strategy.id)},
      ownerAddress,
      amount,
      minSharesOut,
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.error?.message ?? "Building the deposit transaction failed");
  }
  // { transactionId, transaction, lastValidBlockHeight, ... }
  return result.data.transaction;
}

/**
 * Step 2 — submit the signed bytes. SDP verifies they are exactly the
 * transaction it built and that your customer's signature is genuine, records
 * the deposit, then broadcasts it. Reuse the SAME idempotency key when
 * retrying this call: a retry returns the original deposit with
 * \`replayed: true\` instead of moving money twice.
 */
export async function submitEarnDeposit({
  transactionId,
  signedTransaction,
  idempotencyKey,
}: {
  transactionId: string;
  /** Base64 of the signed transaction bytes from the customer's wallet. */
  signedTransaction: string;
  idempotencyKey: string;
}) {
  const response = await fetch(\`\${SDP_API_URL}/v1/earn/external-wallet/deposits\`, {
    method: "POST",
    headers: sdpHeaders({ "Idempotency-Key": idempotencyKey }),
    body: JSON.stringify({ transactionId, signedTransaction }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.error?.message ?? "Submitting the deposit failed");
  }
  // { movementId, positionId, status, signature, replayed, ... }
  return result.data.deposit;
}`;
}
