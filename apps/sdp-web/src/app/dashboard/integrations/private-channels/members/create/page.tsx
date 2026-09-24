import { createSdpApiClient, getSelectedProjectId } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../../private-channels-access";
import { PrivateChannelsLoadError } from "../../private-channels-load-error";
import { loadWalletVerification } from "../../private-channels-page.data";
import { PrincipalCreatePage } from "./principal-create-page";

export default async function PrivateChannelsPrincipalCreateRoute() {
  await requirePrivateChannelsAccess();

  // The scope this page's wallet list was loaded under; the wallet verification
  // submitted by the wizard re-binds to it instead of the mutable cookie.
  const [client, projectId] = await Promise.all([createSdpApiClient(), getSelectedProjectId()]);
  if (!projectId) {
    throw new Error("Selected project required");
  }
  const wallets = await loadWalletVerification(client);

  if (!wallets.ok) {
    return (
      <div className="mx-auto w-full max-w-xl">
        <PrivateChannelsLoadError message={wallets.error} />
      </div>
    );
  }

  return <PrincipalCreatePage projectId={projectId} wallets={wallets.data.custody} />;
}
