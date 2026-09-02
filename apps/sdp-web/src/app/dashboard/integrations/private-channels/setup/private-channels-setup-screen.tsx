import type { PrivateChannelInstance } from "@sdp/types";
import { PrivateChannelsConnectForm } from "./private-channels-connect-form";

export function PrivateChannelsSetupScreen({
  instance,
}: {
  instance: PrivateChannelInstance | null;
}) {
  return (
    <div className="-mx-3 -mt-6 -mb-20 flex min-h-0 flex-1 md:-mx-6 xl:-mb-6">
      <PrivateChannelsConnectForm initialInstance={instance} pageLayout />
    </div>
  );
}
