import { COMPLIANCE_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CUSTODY_PROVIDER_CATALOG } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import { resolvePageLoadingComponent } from "@/components/dashboard-page-loading";
import type { DashboardFlags } from "@/flags/dashboard";
import IntegrationDetailLoading from "./[provider]/loading";
import { integrationsSkeletonLayout } from "./integration-feature-gates";
import { INTEGRATION_FAMILIES } from "./integrations-filter";
import {
  IntegrationDetailSkeleton,
  IntegrationsFlagsSkeleton,
  IntegrationsSkeleton,
} from "./integrations-skeleton";
import IntegrationsLoading from "./loading";

const EVERY_FAMILY = integrationsSkeletonLayout({
  releaseChannel: "experimental",
  custody: true,
  ramps: true,
  compliance: true,
  privateChannels: true,
});

// What `stable` serves today: Custody, no ramp provider, Compliance or Private Channels.
const STABLE = integrationsSkeletonLayout({
  releaseChannel: "stable",
  custody: true,
  ramps: false,
  compliance: false,
  privateChannels: false,
});

const SECTION = /space-y-4/g;
const CARD = /h-\[120px\]/g;

/**
 * A dashboard route has two loading paths: the server `loading.tsx` on a hard
 * navigation, and the shell's skeleton switch on a client one. They used to be
 * hand-duplicated markup, so the Connection section reached only one of them
 * and a client navigation flashed a skeleton one block short of the page.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("integration detail skeleton", () => {
  it("renders the same markup down both loading paths", () => {
    expect(renderToStaticMarkup(<IntegrationDetailLoading />)).toBe(
      renderToStaticMarkup(<IntegrationDetailSkeleton />)
    );
  });

  it("carries a block for every section the detail page renders", () => {
    const markup = renderToStaticMarkup(<IntegrationDetailSkeleton />);
    expect(markup.match(/rounded-2xl/g)).toHaveLength(5);
  });

  it("lets the header wrap the way the loaded one does", () => {
    // The loaded header is `flex flex-wrap` with no fixed height, so on a
    // narrow viewport it wraps and grows. A skeleton pinned to one row held
    // 104px while the page it handed over to came in at 150px, which is a jump
    // from the element whose whole job is to stop the page jumping.
    const markup = renderToStaticMarkup(<IntegrationDetailSkeleton />);
    const header = markup.slice(markup.indexOf("<div", markup.indexOf("data-loading-layout")));

    expect(header).toContain("flex-wrap");
    // A floor, not a fixed height: it still reserves the desktop row.
    expect(header).toContain("min-h-[104px]");
    expect(header).not.toContain("h-[104px] items-center");
  });

  it("reserves one catalog section per family the page renders", () => {
    // A fixed count drifted to half the page once already.
    const markup = renderToStaticMarkup(<IntegrationsSkeleton layout={EVERY_FAMILY} />);
    expect(markup.match(SECTION)).toHaveLength(INTEGRATION_FAMILIES.length);
  });

  it("draws no section for a family the release channel hides", () => {
    // Drawing every family on `stable` showed Ramps and Privacy placeholders that
    // vanished once the page loaded (HOO-1978).
    expect(STABLE.families).toEqual(["custody"]);
    const markup = renderToStaticMarkup(<IntegrationsSkeleton layout={STABLE} />);
    expect(markup.match(SECTION)).toHaveLength(1);
    expect(markup.match(CARD)).toHaveLength(
      CUSTODY_PROVIDER_CATALOG.filter((entry) => entry.visible).length
    );
  });

  it("draws custody alone on the client path before flags arrive", () => {
    const markup = renderToStaticMarkup(<IntegrationsFlagsSkeleton />);
    expect(markup.match(SECTION)).toHaveLength(1);
  });

  it.each(["experimental", "stable"] as const)(
    "renders the same catalog markup down both loading paths on %s",
    (releaseChannel) => {
      // The server path follows the release channel; the client path, flags capped at it.
      vi.stubEnv("SDP_RELEASE_CHANNEL", releaseChannel);
      const layout = releaseChannel === "stable" ? STABLE : EVERY_FAMILY;
      expect(renderToStaticMarkup(<IntegrationsLoading />)).toContain(
        renderToStaticMarkup(<IntegrationsSkeleton layout={layout} />)
      );
    }
  );

  it("reserves a card per provider the catalog actually lists", () => {
    // Four per section left the placeholder 22% shorter than the page: custody
    // alone renders ten. Measured at 1832px page against 1820px skeleton.
    const privacyCards = 1;
    const expected =
      CUSTODY_PROVIDER_CATALOG.filter((entry) => entry.visible).length +
      RAMP_PROVIDERS.length +
      COMPLIANCE_PROVIDERS.length +
      privacyCards;

    const markup = renderToStaticMarkup(<IntegrationsSkeleton layout={EVERY_FAMILY} />);
    expect(markup.match(CARD)).toHaveLength(expected);
  });

  describe("client loading path", () => {
    // The shell's flag snapshot on `stable`: every non-stable module capped off.
    const STABLE_FLAGS: DashboardFlags = {
      assetProfiles: false,
      compliance: false,
      custody: true,
      dvp: false,
      earn: false,
      heliusRings: false,
      issuance: false,
      markets: false,
      payments: true,
      privateChannels: false,
      ramps: false,
      releaseChannel: "stable",
    };

    function renderClientPath(flags: DashboardFlags): string {
      const PageLoading = resolvePageLoadingComponent("integrations");
      return renderToStaticMarkup(<PageLoading flags={flags} />);
    }

    it("draws the stable families through the shell's loading switch", () => {
      expect(renderClientPath(STABLE_FLAGS)).toBe(
        renderToStaticMarkup(<IntegrationsSkeleton layout={STABLE} />)
      );
    });

    it("drops a family its flag hides inside the release channel", () => {
      const markup = renderClientPath({ ...STABLE_FLAGS, compliance: false });
      expect(markup.match(SECTION)).toHaveLength(1);
    });
  });
});
