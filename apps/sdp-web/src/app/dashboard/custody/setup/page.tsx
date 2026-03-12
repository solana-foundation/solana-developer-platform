import {
  type KnownCustodyProvider,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { PageBody, PageHeader, PageLayout } from "@/components/layouts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { createCustodyWallet, initializeCustody } from "../actions";
import { CustodySetupForm } from "./setup-form";

interface WalletConfigsResponse {
  configs: Array<{
    provider: string;
    status: "active" | "inactive";
  }>;
}

async function getConnectedProviders(): Promise<KnownCustodyProvider[]> {
  try {
    const apiClient = await createSdpApiClient();
    const res = await apiClient.request("/v1/wallets/configs");
    if (!res.ok) {
      return [];
    }

    const parsed = (await res.json()) as { data?: WalletConfigsResponse };
    return (parsed.data?.configs ?? [])
      .filter((config) => config.status === "active")
      .map((config) => config.provider)
      .filter(isKnownCustodyProvider);
  } catch {
    return [];
  }
}

export default async function CustodySetupPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const connectedProviders = await getConnectedProviders();

  return (
    <PageLayout width="narrow">
      <PageHeader
        variant="narrow"
        title="Activate provider"
        backLink={{ href: "/dashboard/wallets", label: "Back to wallets" }}
      />
      <PageBody>
        <div className="w-full flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Activate provider</CardTitle>
              <CardDescription>
                Connect a custody provider and create its first wallet in one step.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <CustodySetupForm
                initializeAction={initializeCustody}
                createWalletAction={createCustodyWallet}
                connectedProviders={connectedProviders}
              />

              <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2 text-xs text-[rgba(28,28,29,0.64)]">
                This step provisions wallet signing for your organization. It does not automatically
                rotate on-chain authorities for existing assets.
              </div>
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </PageLayout>
  );
}
