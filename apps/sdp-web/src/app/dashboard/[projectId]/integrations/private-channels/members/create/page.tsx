import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelsLoadError } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import { loadWalletVerification } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";
import { createSdpApiClient } from "@/lib/sdp-api";
import { PrincipalCreatePage } from "./principal-create-page";

export default async function PrivateChannelsPrincipalCreateRoute() {
  await requirePrivateChannelsAccess();
  await redirectUnlessCanWrite("/dashboard/integrations/private-channels/members");

  const client = await createSdpApiClient();
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
