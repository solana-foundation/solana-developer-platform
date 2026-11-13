import { DEFAULT_SDP_SANDBOX_WEB_URL } from "@sdp/types/site";
import { Button } from "@sdp/ui/button";
import { ArrowUpRightIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { loadMainnetAccess } from "@/app/(session)/dashboard/[projectId]/settings/mainnet-access-load";
import { MainnetAccessSection } from "@/app/(session)/dashboard/[projectId]/settings/mainnet-access-section";
import { SdpProductLockup } from "@/components/auth-page-shell";
import { externalLinkProps } from "@/components/homepage/homepage-links";
import { sandboxOnBeta } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { MainnetAccessAccountActions } from "./mainnet-access-account-actions";

/**
 * Where an organization waits on a deployment that serves mainnet only until SDP turns mainnet
 * on: it can do nothing else here, so the page holds the request, the way to the hosted sandbox,
 * and the way out. Any other organization goes back to the dashboard.
 */
export default async function MainnetAccessPage() {
  const [t, loaded, linkSandbox] = await Promise.all([
    getTranslations(),
    loadMainnetAccess(),
    sandboxOnBeta(),
  ]);
  if (loaded.ok && (!loaded.access.mainnetOnly || loaded.access.state === "approved")) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-dvh flex-col bg-surface px-4 pb-10 sm:px-6">
      <div className="flex h-18 items-center justify-between gap-4">
        <SdpProductLockup productName={t("Shared.authShell.productName")} />
        <MainnetAccessAccountActions />
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 pt-12">
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-medium tracking-tight text-primary">
            {loaded.ok
              ? t("Shared.mainnetAccessLock.title", { organization: loaded.organizationName })
              : t("Shared.mainnetAccess.title")}
          </h1>
          <p className="text-body text-secondary">{t("Shared.mainnetAccessLock.body")}</p>
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
        <MainnetAccessSection />
      </div>
    </main>
  );
}
