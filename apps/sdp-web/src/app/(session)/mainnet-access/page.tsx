import { DEFAULT_SDP_SANDBOX_WEB_URL } from "@sdp/types/site";
import { Button } from "@sdp/ui/button";
import { ArrowUpRightIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { loadMainnetAccess } from "@/app/(session)/dashboard/[projectId]/settings/mainnet-access-load";
import { MainnetAccessSection } from "@/app/(session)/dashboard/[projectId]/settings/mainnet-access-section";
import { SdpProductLockup } from "@/components/auth-page-shell";
import { externalLinkProps } from "@/components/homepage/homepage-links";
import { betaLabel, sandboxOnBeta } from "@/flags";
import type { MessageKey } from "@/i18n/messages";
import { getTranslations } from "@/i18n/server";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { requestMemberRole } from "@/lib/sdp-api";
import { MainnetAccessAccountActions } from "./mainnet-access-account-actions";

/**
 * Where an organization waits on a deployment that serves mainnet only until SDP turns mainnet
 * on: it can do nothing else here, so the page holds the request (an admin's to send), the way
 * to the hosted sandbox, and the way out. Any other organization goes back to the dashboard.
 */
export default async function MainnetAccessPage() {
  const [t, loaded, linkSandbox, beta, role] = await Promise.all([
    getTranslations(),
    loadMainnetAccess(),
    sandboxOnBeta(),
    betaLabel(),
    requestMemberRole(),
  ]);
  const canRequest = resolveDashboardAccess(role).capabilities.canManageOrgSettings;
  if (loaded.ok && (!loaded.access.mainnetOnly || loaded.access.state === "approved")) {
    redirect("/dashboard");
  }
  // Awaited here, not placed as an async element, so the page renders as one resolved tree.
  const section = await MainnetAccessSection({ canRequestAccess: canRequest });

  return (
    <main className="flex min-h-dvh flex-col bg-surface px-4 pb-10 sm:px-6">
      <div className="flex h-18 items-center justify-between gap-4">
        <SdpProductLockup
          productName={t("Shared.authShell.productName")}
          betaLabel={beta ? t("Shared.authShell.beta") : null}
        />
        <MainnetAccessAccountActions />
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 pt-12">
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-medium tracking-tight text-primary">
            {loaded.ok
              ? t("Shared.mainnetAccessLock.title", { organization: loaded.organizationName })
              : t("Shared.mainnetAccess.title")}
          </h1>
          <p className="text-body text-secondary">
            {t(lockBodyKey(lockStateOf(loaded, canRequest), linkSandbox), {
              organization: loaded.ok ? loaded.organizationName : "",
            })}
          </p>
          {linkSandbox ? (
            <div>
              <Button asChild variant="outline" size="sm">
                <a href={DEFAULT_SDP_SANDBOX_WEB_URL} {...externalLinkProps(true)}>
                  {t("Shared.mainnetAccessLock.trySandbox")}
                  <ArrowUpRightIcon aria-hidden="true" />
                </a>
              </Button>
            </div>
          ) : null}
        </div>
        {section}
      </div>
    </main>
  );
}

type LockState = "request" | "askAdmin" | "pending" | "unavailable";

/**
 * What the organization can do next: an admin requests mainnet, anyone else asks an admin, the
 * request waits on SDP, or the deployment takes no request yet.
 */
function lockStateOf(
  loaded: Awaited<ReturnType<typeof loadMainnetAccess>>,
  canRequest: boolean
): LockState {
  if (!loaded.ok || !loaded.access.available) return "unavailable";
  if (loaded.access.state === "pending") return "pending";
  return canRequest ? "request" : "askAdmin";
}

/** The line under the title, naming the sandbox only where the page links it. */
function lockBodyKey(state: LockState, linkSandbox: boolean): MessageKey {
  switch (state) {
    case "request":
      return linkSandbox
        ? "Shared.mainnetAccessLock.bodyRequest"
        : "Shared.mainnetAccessLock.bodyRequestNoSandbox";
    case "askAdmin":
      return linkSandbox
        ? "Shared.mainnetAccessLock.bodyAskAdmin"
        : "Shared.mainnetAccessLock.bodyAskAdminNoSandbox";
    case "pending":
      return linkSandbox
        ? "Shared.mainnetAccessLock.bodyPending"
        : "Shared.mainnetAccessLock.bodyPendingNoSandbox";
    case "unavailable":
      return linkSandbox
        ? "Shared.mainnetAccessLock.bodyUnavailable"
        : "Shared.mainnetAccessLock.bodyUnavailableNoSandbox";
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled mainnet lock state: ${String(exhaustive)}`);
    }
  }
}
