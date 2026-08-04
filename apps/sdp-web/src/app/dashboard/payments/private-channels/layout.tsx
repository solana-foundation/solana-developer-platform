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

  // The dashboard shell hands us a `flex flex-1 flex-col min-h-0 overflow-hidden`
  // region for /dashboard/payments/*. Wrapping tabs + child in a flex-col here
  // lets the API Playground page use `flex-1 min-h-0` to fill the space below
  // the tab bar without spilling past it — a Fragment made the child size to
  // the whole region and get clipped by the parent's overflow.
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PrivateChannelsHeaderTabs isConnected={instance.data?.isActive === true} />
      {children}
    </div>
  );
}
