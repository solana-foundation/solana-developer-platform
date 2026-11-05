import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { resolvePlaygroundApiBaseUrl } from "@/app/(session)/dashboard/[projectId]/playground-api-data";
import { requestOnboardingStatus, requestProjectHref } from "@/lib/sdp-api";
import { WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";
import { WalletsWorkspace } from "./wallets-workspace";

export default async function WalletsPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const onboarding = await requestOnboardingStatus();
  if (!onboarding.linked) {
    redirect(
      `${WORKSPACE_LOADING_PATH}?return_to=${encodeURIComponent(await requestProjectHref("/dashboard/wallets"))}`
    );
  }

  return <WalletsWorkspace apiBaseUrl={resolvePlaygroundApiBaseUrl()} />;
}
