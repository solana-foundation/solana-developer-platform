import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { heliusRings } from "@/flags";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createRequestScopedSdpApiClients } from "@/lib/sdp-api";
import { HeliusRingsWorkspace } from "./helius-rings-workspace";
import type { CustodyWalletOption } from "./private-wallets-card";

export const dynamic = "force-dynamic";

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
    const { projectClient } = await createRequestScopedSdpApiClients({});
    const response = await projectClient.request("/v1/wallets?view=summary", { method: "GET" });
    if (response.ok) {
      const body = z
        .object({
          data: z.object({
            wallets: z.array(
              z.object({ id: z.string(), label: z.string().nullish(), publicKey: z.string() })
            ),
          }),
        })
        .parse(await response.json());
      custodyWallets = body.data.wallets.map((wallet) => ({
        id: wallet.id,
        label: wallet.label ?? null,
        publicKey: wallet.publicKey,
      }));
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
