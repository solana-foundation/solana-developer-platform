import type { PrivateChannelInstance } from "@sdp/types";
import { newDesign } from "@/flags";
import { PrivateChannelsConnectForm as LegacyPrivateChannelsConnectForm } from "./private-channels-connect-form";
import { PrivateChannelsConnectForm } from "./private-channels-connect-form.redesign";

export async function PrivateChannelsSetupScreen({
  instance,
}: {
  instance: PrivateChannelInstance | null;
}) {
  // NEW DESIGN picks the connect form; the previous design keeps the original file.
  const newDesignEnabled = await newDesign();
  const ConnectForm = newDesignEnabled
    ? PrivateChannelsConnectForm
    : LegacyPrivateChannelsConnectForm;
  return (
    <div
      className={
        // The new design cancels the layout's padding (`pb-20`, then `md:pb-6`) exactly, so the
        // wizard fills the clipped viewport: its form scrolls and its footer stays on screen.
        // `xl:-mb-6` would leave the wizard 56px taller than that box between md and xl.
        newDesignEnabled
          ? "-mx-3 -mt-6 -mb-20 flex min-h-0 flex-1 md:-mx-6 md:-mb-6"
          : "-mx-3 -mt-6 -mb-20 flex min-h-0 flex-1 md:-mx-6 xl:-mb-6"
      }
    >
      <ConnectForm initialInstance={instance} pageLayout />
    </div>
  );
}
