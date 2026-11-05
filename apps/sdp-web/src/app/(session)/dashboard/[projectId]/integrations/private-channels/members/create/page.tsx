import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";
import { PrincipalCreateSection } from "./principal-create-section";

export default async function PrivateChannelsPrincipalCreateRoute() {
  await requirePrivateChannelsAccess();
  await redirectUnlessCanWrite("/dashboard/integrations/private-channels/members");
  return <PrincipalCreateSection />;
}
