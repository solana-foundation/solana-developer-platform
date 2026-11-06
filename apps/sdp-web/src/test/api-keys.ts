import type { ApiKeyDetails } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-presentation";

/** A synthetic Sandbox key reading transfers on every wallet; the caller sets what decides its lifetime. */
export function testApiKey(
  lifetime: Pick<ApiKeyDetails, "status" | "expiresAt" | "rotationDeadline">
): ApiKeyDetails {
  return {
    id: "key_test_1",
    name: "Payouts worker",
    description: null,
    keyPrefix: "sf_0123456789abcdef",
    grants: ["transfers.read"],
    environment: "sandbox",
    walletScope: "all",
    walletIds: [],
    lastUsedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    allowedIps: null,
    rotatedFrom: null,
    ...lifetime,
  };
}
