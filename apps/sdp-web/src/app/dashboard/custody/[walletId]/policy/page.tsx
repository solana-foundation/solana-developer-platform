import { auth } from "@clerk/nextjs/server";
import type {
  CustodyWalletMetadataResponse,
  CustodyWalletTokenBalance,
  PaymentWalletPolicy,
} from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient, getSelectedProjectId, type SdpApiClient } from "@/lib/sdp-api";
import { getWalletMetadataPath } from "@/lib/sdp-api-paths";
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

async function getWalletPolicy(
  request: SdpApiClient["request"],
  walletId: string
): Promise<WalletPolicyResult> {
  try {
    const response = await request(`/v1/payments/wallets/${encodeURIComponent(walletId)}/policies`);
    if (response.status === 404) {
      return {
        policy: {
          walletId,
          destinationAllowlist: [],
        },
        error: null,
      };
    }
    if (!response.ok) {
      return {
        policy: {
          walletId,
          destinationAllowlist: [],
        },
        error: "Wallet controls are unavailable right now.",
      };
    }

    const json = (await response.json()) as { data?: { policy?: PaymentWalletPolicy } };
    return {
      policy: json.data?.policy ?? {
        walletId,
        destinationAllowlist: [],
      },
      error: null,
    };
  } catch {
    return {
      policy: {
        walletId,
        destinationAllowlist: [],
      },
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

export default async function WalletPolicyPage({
  params,
}: {
  params: Promise<{ walletId: string }>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const { walletId } = await params;
  const resolvedWalletId = decodeURIComponent(walletId);
  const projectId = await getSelectedProjectId();
  if (!projectId) {
    redirect("/dashboard");
  }
  const apiClient = await createSdpApiClient();
  const [wallet, policyResult, walletAssets] = await Promise.all([
    getWalletDetail(apiClient.request, resolvedWalletId),
    getWalletPolicy(apiClient.request, resolvedWalletId),
    getWalletAssets(apiClient.request, resolvedWalletId),
  ]);

  return (
    <WalletPolicyStartingProfileFlow
      projectId={projectId}
      wallet={{
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
      initialPolicy={policyResult.policy}
      policyError={policyResult.error}
    />
  );
}
