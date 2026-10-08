import { createProjectBoundSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../../private-channels-access";
import { PrivateChannelsLoadError } from "../../private-channels-load-error";
import { loadWalletVerification } from "../../private-channels-page.data";
import { PrincipalCreatePage } from "./principal-create-page";

export default async function PrivateChannelsPrincipalCreateRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  await requirePrivateChannelsAccess();
  const { projectId } = await params;

  const client = await createProjectBoundSdpApiClient(projectId);
  const wallets = await loadWalletVerification(client);

  if (!wallets.ok) {
    return (
      <div className="mx-auto w-full max-w-xl">
        <PrivateChannelsLoadError message={wallets.error} />
      </div>
    );
  }

  return <PrincipalCreatePage wallets={wallets.data.custody} />;
}
