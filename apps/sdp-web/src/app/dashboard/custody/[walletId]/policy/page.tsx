import { auth } from "@clerk/nextjs/server";
import type { CustodyWalletByIdResponse, PaymentWalletPolicy } from "@sdp/types";
import { History, ListChecks } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { WalletPolicyStartingProfileFlow } from "./wallet-policy-starting-profile-flow";

interface WalletPolicyResult {
  policy: PaymentWalletPolicy;
  error: string | null;
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
  const t = await getTranslations();
  const apiClient = await createSdpApiClient();
  const [wallet, policyResult] = await Promise.all([
    getWalletDetail(apiClient.request, resolvedWalletId),
    getWalletPolicy(apiClient.request, resolvedWalletId),
  ]);

  return (
    <DashboardWorkspaceOverviewPanel className="p-0">
      <div className="flex flex-wrap justify-end gap-2 border-b border-border-default px-4 py-3 md:px-6">
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
      <WalletPolicyStartingProfileFlow
        wallet={{
          walletId: wallet.walletId,
          publicKey: wallet.publicKey,
          label: wallet.label,
          provider: wallet.provider ?? null,
        }}
        initialPolicy={policyResult.policy}
        policyError={policyResult.error}
      />
    </DashboardWorkspaceOverviewPanel>
  );
}
