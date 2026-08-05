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

  // Payments routes are viewport-locked: the shell renders this segment inside an
  // `overflow-hidden` box of bounded height. Lay the tabs + page out as a flex column
  // (tabs fixed, page fills the rest) so a full-height page like the overview can size
  // to the remaining space instead of overshooting past the tabs and clipping its
  // bottom. Natural-height sibling pages are unaffected — they sit at the top of the
  // flex-1 area at their own height.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PrivateChannelsHeaderTabs isConnected={instance.data?.isActive === true} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
