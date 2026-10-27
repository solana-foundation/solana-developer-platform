import type { PrivateChannelInstance } from "@sdp/types/private-channels";
import { PrivateChannelsConnectForm } from "./private-channels-connect-form";

export function PrivateChannelsSetupScreen({
  instance,
}: {
  instance: PrivateChannelInstance | null;
}) {
  // Cancels the layout's padding (`pb-20`, then `md:pb-6`) exactly, so the wizard fills the
  // clipped viewport: its form scrolls and its footer stays on screen. `xl:-mb-6` would leave
  // the wizard 56px taller than that box between md and xl.
  return (
    <div className="-mx-3 -mt-6 -mb-20 flex min-h-0 flex-1 md:-mx-6 md:-mb-6">
      <PrivateChannelsConnectForm initialInstance={instance} pageLayout />
    </div>
  );
}
