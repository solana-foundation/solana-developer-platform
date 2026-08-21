import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { heliusRings } from "@/flags";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createRequestScopedSdpApiClients } from "@/lib/sdp-api";
import { HeliusRingsWorkspace } from "./helius-rings-workspace";

export const dynamic = "force-dynamic";

interface CustodyWalletOption {
  walletId: string;
  label: string | null;
  publicKey: string;
}

/**
 * Helius Rings overview — devnet-only shielded wallet workspace. Live data
 * flows through the /api/dashboard/helius-rings BFF proxies; the custody
 * wallet options for the create form are resolved server-side. Degraded
 * upstreams render honestly: red health, pending wallets, failed operations.
 */
export default async function HeliusRingsPage() {
  if (!(await heliusRings())) {
    notFound();
  }
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  // Best-effort: losing the wallet list costs the reader the create form,
  // never the health card or the activity table beside it.
  let custodyWallets: CustodyWalletOption[] = [];
  try {
    const { projectClient } = await createRequestScopedSdpApiClients();
    if (projectClient) {
      const response = await projectClient.request("/v1/wallets?view=summary", { method: "GET" });
      if (response.ok) {
        const body = (await response.json()) as {
          data?: {
            wallets?: Array<{ walletId: string; label?: string | null; publicKey: string }>;
          };
        };
        custodyWallets = (body.data?.wallets ?? []).map((wallet) => ({
          walletId: wallet.walletId,
          label: wallet.label ?? null,
          publicKey: wallet.publicKey,
        }));
      }
    }
  } catch {
    // The workspace renders its own empty-state copy.
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <HeliusRingsWorkspace custodyWallets={custodyWallets} />
    </div>
  );
}
