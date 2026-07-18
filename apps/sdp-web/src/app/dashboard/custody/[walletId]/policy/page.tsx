import { auth } from "@clerk/nextjs/server";
import type {
  CustodyWalletByIdResponse,
  CustodyWalletTokenBalance,
  PaymentWalletPolicy,
} from "@sdp/types";
import { History, ListChecks } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient, getSelectedProjectId, type SdpApiClient } from "@/lib/sdp-api";
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
): Promise<CustodyWalletByIdResponse["wallet"]> {
  const response = await request(`/v1/wallets/${encodeURIComponent(walletId)}`);
  if (response.status === 404) {
    notFound();
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SDP API request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data?: CustodyWalletByIdResponse };
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
  const t = await getTranslations();
  const apiClient = await createSdpApiClient();
  const [wallet, policyResult, walletAssets] = await Promise.all([
    getWalletDetail(apiClient.request, resolvedWalletId),
    getWalletPolicy(apiClient.request, resolvedWalletId),
    getWalletAssets(apiClient.request, resolvedWalletId),
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-b border-border-default px-4 py-3 md:px-6">
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard/wallets/${encodeURIComponent(resolvedWalletId)}/policy/audit`}>
            <ListChecks className="size-4" />
            {t("DashboardCustody.policyAuditTitle")}
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link
            href={`/dashboard/wallets/${encodeURIComponent(resolvedWalletId)}/policy/revisions`}
          >
            <History className="size-4" />
            {t("DashboardCustody.policyAuditRevisionHistory")}
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1">
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
      </div>
    </div>
  );
}
