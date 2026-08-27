import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { privateChannels } from "@/flags";
import { createSdpApiClient } from "@/lib/sdp-api";
import { PrivateChannelsHeaderTabs } from "./private-channels-header-tabs";
import { loadInstance } from "./private-channels-page.data";

export default async function PrivateChannelsLayout({ children }: { children: ReactNode }) {
  // Gate before the instance lookup: every leaf page checks the flag too, so without
  // this a hand-typed URL spends an authenticated API round trip only to 404, and the
  // header tabs render around the child's notFound().
  if (!(await privateChannels())) {
    notFound();
  }

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);

  // The payments shell locks its viewport and clips overflow, so each segment owns
  // its own scrolling. Without this the tab strip stays put but anything below the
  // fold — long event feeds, member tables — is unreachable.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <PrivateChannelsHeaderTabs isConnected={instance.data?.isActive === true} />
      </div>
      {/* Gutters match the shell's header padding, which locked routes don't inherit.
          The gap under the tab strip lives here rather than on the strip so the first
          card's ring and shadow — drawn outside its box — aren't shaved off by this
          container's clip, and the deep bottom padding clears the fixed mobile bar
          that hides at xl. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-6 pb-20 md:px-6 xl:pb-6">
        {children}
      </div>
    </div>
  );
}
