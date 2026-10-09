import { auth } from "@clerk/nextjs/server";
import type {
  CustodyWalletMetadataResponse,
  CustodyWalletTokenBalance,
  PaymentWalletPolicy,
} from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import type { OnboardingStatusResponse } from "@/app/dashboard/[projectId]/onboarding-status";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import {
  createOrgSdpApiClient,
  createSdpApiClient,
  requestProjectHref,
  requestProjectId,
  type SdpApiClient,
} from "@/lib/sdp-api";
import { getWalletMetadataPath } from "@/lib/sdp-api-paths";
import { getIssuedPolicyTokens } from "./policy-assets.data";
import { firstSearchParam } from "./policy-audit.data";
import { WalletPolicyStartingProfileFlow } from "./wallet-policy-starting-profile-flow";

interface WalletPolicyResult {
  policy: PaymentWalletPolicy;
  error: string | null;
}

interface WalletBalancesResponse {
  walletBalances?: {
    balances?: CustodyWalletTokenBalance[];
  };
}

async function getWalletDetail(
  request: SdpApiClient["request"],
  walletId: string
): Promise<CustodyWalletMetadataResponse["wallet"]> {
  const response = await request(getWalletMetadataPath(walletId));
  if (response.status === 404) {
    notFound();
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SDP API request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data?: CustodyWalletMetadataResponse };
  const wallet = json.data?.wallet;
  if (!wallet) {
    notFound();
  }

  return wallet;
}

/** Form placeholder only; policyError prevents activation after an unavailable read. */
function unavailablePolicyPlaceholder(
  custodyWalletId: string,
  providerWalletId: string
): PaymentWalletPolicy {
  return {
    custodyWalletId,
    walletId: providerWalletId,
    defaultAction: "allow",
    rules: [],
    controlProfile: null,
  };
}

async function getWalletPolicy(
  request: SdpApiClient["request"],
  walletId: string,
  providerWalletId: string
): Promise<WalletPolicyResult> {
  try {
    const response = await request(`/v1/payments/wallets/${encodeURIComponent(walletId)}/policies`);
    if (!response.ok) {
      return {
        policy: unavailablePolicyPlaceholder(walletId, providerWalletId),
        error: "Wallet controls are unavailable right now.",
      };
    }

    const json = (await response.json()) as { data?: { policy?: PaymentWalletPolicy } };
    const policy = json.data?.policy;
    if (
      !policy ||
      policy.custodyWalletId !== walletId ||
      !Array.isArray(policy.rules) ||
      typeof policy.defaultAction !== "string"
    ) {
      return {
        policy: unavailablePolicyPlaceholder(walletId, providerWalletId),
        error: "Wallet controls are unavailable right now.",
      };
    }
    return { policy, error: null };
  } catch {
    return {
      policy: unavailablePolicyPlaceholder(walletId, providerWalletId),
      error: "Wallet controls are unavailable right now.",
    };
  }
}

async function getWalletAssets(
  request: SdpApiClient["request"],
  walletId: string
): Promise<CustodyWalletTokenBalance[]> {
  try {
    const response = await request(`/v1/payments/wallets/${encodeURIComponent(walletId)}/balances`);
    if (!response.ok) return [];
    const json = (await response.json()) as { data?: WalletBalancesResponse };
    return json.data?.walletBalances?.balances ?? [];
  } catch {
    return [];
  }
}

/**
 * Whether the organization has any enabled compliance provider, so the
 * destination editor knows to run address screening at all.
 *
 * @returns True when at least one compliance provider is enabled; false when
 * the organization is unlinked or the availability fetch fails.
 */
async function getComplianceScreeningEnabled(): Promise<boolean> {
  try {
    const orgClient = await createOrgSdpApiClient();
    const onboardingStatus =
      await orgClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
    if (!onboardingStatus.organization) return false;
    const providerAccess = await fetchProviderAvailability(
      orgClient.request,
      onboardingStatus.organization.id
    );
    return providerAccess.enabledComplianceProviders.length > 0;
  } catch {
    return false;
  }
}

export default async function WalletPolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ walletId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const [{ walletId }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  const resolvedWalletId = decodeURIComponent(walletId);
  const initialRevisionId = firstSearchParam(resolvedSearchParams.revision);
  const [projectId, apiClient] = await Promise.all([requestProjectId(), createSdpApiClient()]);
  const wallet = await getWalletDetail(apiClient.request, resolvedWalletId);
  if (wallet.id !== resolvedWalletId) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(resolvedSearchParams)) {
      for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
        query.append(key, entry);
      }
    }
    redirect(
      await requestProjectHref(
        `/dashboard/wallets/${encodeURIComponent(wallet.id)}/policy${query.size ? `?${query}` : ""}`
      )
    );
  }
  const [policyResult, walletAssets, issuedTokens, complianceScreeningEnabled] = await Promise.all([
    getWalletPolicy(apiClient.request, wallet.id, wallet.walletId),
    getWalletAssets(apiClient.request, wallet.id),
    getIssuedPolicyTokens(apiClient.request),
    getComplianceScreeningEnabled(),
  ]);

  return (
    <WalletPolicyStartingProfileFlow
      key={`${projectId}:${wallet.id}`}
      projectId={projectId}
      wallet={{
        id: wallet.id,
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        label: wallet.label,
        provider: wallet.provider ?? null,
      }}
      walletAssets={walletAssets.map((asset) => ({
        token: asset.token,
        mint: asset.mint,
        uiAmount: asset.uiAmount,
      }))}
      issuedTokens={issuedTokens}
      initialPolicy={policyResult.policy}
      policyError={policyResult.error}
      complianceScreeningEnabled={complianceScreeningEnabled}
      initialRevisionId={initialRevisionId}
    />
  );
}
