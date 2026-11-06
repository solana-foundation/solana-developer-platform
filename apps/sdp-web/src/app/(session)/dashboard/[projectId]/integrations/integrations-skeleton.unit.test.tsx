import { COMPLIANCE_PROVIDERS } from "@sdp/types/provider-access";
import { MANAGED_RPC_PROVIDERS } from "@sdp/types/rpc";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CUSTODY_PROVIDER_CATALOG } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { resolvePageLoadingComponent } from "@/components/dashboard-page-loading";
import { rampProvidersInReleaseChannel } from "@/flags/release-channel";
import { dashboardFlagsAt } from "@/test/release-channel-flags";
import IntegrationsLoading from "./(catalog)/loading";
import IntegrationDetailLoading from "./[provider]/(detail)/loading";
import {
  IntegrationDetailSkeleton,
  IntegrationsFlagsSkeleton,
  IntegrationsSkeleton,
  integrationsSkeletonSections,
} from "./integrations-skeleton";

const SECTION = /class="space-y-2"/g;
const ROW = /<li\b/g;
const VISIBLE_CUSTODY_PROVIDERS = CUSTODY_PROVIDER_CATALOG.filter((entry) => entry.visible).length;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("integration detail skeleton", () => {
  it("renders the same markup down both loading paths", () => {
    expect(renderToStaticMarkup(<IntegrationDetailLoading />)).toBe(
      renderToStaticMarkup(<IntegrationDetailSkeleton />)
    );
  });
});

describe("integrations catalog skeleton", () => {
  it("reserves a row for every provider each family can list, in the catalog's family order", () => {
    expect(integrationsSkeletonSections(dashboardFlagsAt("experimental"))).toEqual([
      { family: "custody", rows: VISIBLE_CUSTODY_PROVIDERS },
      {
        family: "rpc",
        rows: MANAGED_RPC_PROVIDERS.filter((provider) => provider !== "default").length,
      },
      { family: "ramps", rows: rampProvidersInReleaseChannel("experimental").length },
      { family: "compliance", rows: COMPLIANCE_PROVIDERS.length },
      { family: "private_channels", rows: 1 },
    ]);
  });

  it("draws no section for a family the flags hide", () => {
    const sections = integrationsSkeletonSections({
      ...dashboardFlagsAt("experimental"),
      ramps: false,
      privateChannels: false,
    });

    expect(sections.map((section) => section.family)).toEqual(["custody", "rpc", "compliance"]);
  });

  it("draws custody alone on the client path before flags arrive", () => {
    const markup = renderToStaticMarkup(<IntegrationsFlagsSkeleton />);

    expect(markup.match(SECTION)).toHaveLength(1);
    expect(markup.match(ROW)).toHaveLength(VISIBLE_CUSTODY_PROVIDERS);
  });

  it.each(["experimental", "stable"] as const)(
    "renders the same markup down both loading paths on %s",
    (releaseChannel) => {
      vi.stubEnv("SDP_RELEASE_CHANNEL", releaseChannel);
      const flags = dashboardFlagsAt(releaseChannel);
      const PageLoading = resolvePageLoadingComponent("integrations");
      const expected = renderToStaticMarkup(
        <IntegrationsSkeleton sections={integrationsSkeletonSections(flags)} />
      );

      expect(renderToStaticMarkup(<IntegrationsLoading />)).toContain(expected);
      expect(renderToStaticMarkup(<PageLoading flags={flags} />)).toBe(expected);
    }
  );
});
