import { DEFAULT_SDP_API_URL, type EarnStrategy } from "@sdp/types";

export function earnButtonIntegrationPath(publicToken: string): string {
  return `/earn/integrate/${encodeURIComponent(publicToken)}`;
}

/**
 * A server-only example by construction: the API key comes from process.env
 * and the browser/mobile button is expected to call this partner-owned backend.
 * Callers that know the deployment's real API base (the handoff page resolves
 * one for its own fetch) pass it so the snippet targets the same host.
 */
export function buildEarnServerIntegration(
  strategy: Pick<EarnStrategy, "id">,
  apiBaseUrl?: string
): string {
  return `const SDP_API_URL = ${JSON.stringify(apiBaseUrl ?? DEFAULT_SDP_API_URL)};

export async function depositIntoEarnVault({
  custodyWalletId,
  amount,
  idempotencyKey,
}: {
  custodyWalletId: string;
  amount: string;
  idempotencyKey: string;
}) {
  const apiKey = process.env.SDP_API_KEY;
  if (!apiKey) throw new Error("SDP_API_KEY is required");

  const response = await fetch(\`\${SDP_API_URL}/v1/earn/vault-deposits\`, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
      "Content-Type": "application/json",
      // Reuse this caller-owned key when retrying the same logical deposit.
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      strategyId: ${JSON.stringify(strategy.id)},
      custodyWalletId,
      amount,
    }),
  });

  const result = await response.json();
  if (response.status === 202) {
    return { kind: "approval_pending", result };
  }
  if (!response.ok) {
    throw new Error(result?.error?.message ?? "Vault deposit failed");
  }
  return { kind: "submitted", deposit: result.data };
}`;
}
