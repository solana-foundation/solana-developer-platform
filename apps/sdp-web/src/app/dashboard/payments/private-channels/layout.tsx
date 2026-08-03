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

  return (
    <>
      <PrivateChannelsHeaderTabs isConnected={instance.data?.isActive === true} />
      {children}
    </>
  );
}
