import type { PrivateChannelInstance } from "@sdp/types";
import { newDesign } from "@/flags";
import { PrivateChannelsConnectForm as LegacyPrivateChannelsConnectForm } from "./_legacy/private-channels-connect-form";
import { PrivateChannelsConnectForm } from "./private-channels-connect-form";

export async function PrivateChannelsSetupScreen({
  instance,
}: {
  instance: PrivateChannelInstance | null;
}) {
  // NEW DESIGN picks the connect form; the previous design's is its _legacy copy.
  const ConnectForm = (await newDesign())
    ? PrivateChannelsConnectForm
    : LegacyPrivateChannelsConnectForm;
  return (
    <div className="-mx-3 -mt-6 -mb-20 flex min-h-0 flex-1 md:-mx-6 xl:-mb-6">
      <ConnectForm initialInstance={instance} pageLayout />
    </div>
  );
}
