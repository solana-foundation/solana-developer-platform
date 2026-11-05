import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { SWRConfig } from "swr";
import { z } from "zod";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import { useDashboardRead } from "@/lib/dashboard-swr";
import { EnglishI18n } from "./i18n";

/** A fresh dashboard read cache per render, as a new tab starts with; `renderHook`'s `wrapper`. */
export function DashboardReadsProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

/** {@link DashboardReadsProvider} with the English catalog: `render`'s `wrapper` for a screen. */
export function EnglishDashboardReads({ children }: { children: ReactNode }) {
  return (
    <DashboardReadsProvider>
      <EnglishI18n>{children}</EnglishI18n>
    </DashboardReadsProvider>
  );
}

/** Keeps `requestKey` read on screen, as a list stays up beside the form that writes to it. */
function MountedDashboardRead({ requestKey }: { requestKey: DashboardRequestKey }) {
  useDashboardRead(requestKey, z.unknown());
  return null;
}

/**
 * Renders `ui` beside mounted reads of `requestKeys`, under {@link EnglishDashboardReads}, so a
 * write's invalidation shows as those reads being sent again.
 */
export function renderBesideReads(ui: ReactElement, requestKeys: DashboardRequestKey[]) {
  return render(
    <>
      {ui}
      {requestKeys.map((requestKey) => (
        <MountedDashboardRead key={JSON.stringify(requestKey)} requestKey={requestKey} />
      ))}
    </>,
    { wrapper: EnglishDashboardReads }
  );
}
