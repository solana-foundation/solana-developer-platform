import { COMPLIANCE_PROVIDERS, ORGANIZATION_RPC_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CUSTODY_PROVIDER_CATALOG } from "@/app/dashboard/custody/provider-catalog";
import IntegrationDetailLoading from "./[provider]/loading";
import { INTEGRATION_FAMILIES } from "./integrations-filter";
import { IntegrationDetailSkeleton, IntegrationsSkeleton } from "./integrations-skeleton";
import IntegrationsLoading from "./loading";

/**
 * A dashboard route has two loading paths: the server `loading.tsx` on a hard
 * navigation, and the shell's skeleton switch on a client one. They used to be
 * hand-duplicated markup, so the Connection section reached only one of them
 * and a client navigation flashed a skeleton one block short of the page.
 */
describe("integration detail skeleton", () => {
  it("renders the same markup down both loading paths", () => {
    expect(renderToStaticMarkup(<IntegrationDetailLoading />)).toBe(
      renderToStaticMarkup(<IntegrationDetailSkeleton />)
    );
  });

  it("carries a block for every section the detail page renders", () => {
    const markup = renderToStaticMarkup(<IntegrationDetailSkeleton />);
    // Header, Connection, credentials, About, How it connects, Resources —
    // the RPC family renders the most sections, and the skeleton is sized
    // close to it.
    expect(markup.match(/rounded-2xl/g)).toHaveLength(5);
  });

  it("reserves one catalog section per family the page renders", () => {
    const markup = renderToStaticMarkup(<IntegrationsSkeleton />);
    // A fixed count drifted to half the page once already.
    expect(markup.match(/space-y-4/g)).toHaveLength(INTEGRATION_FAMILIES.length);
  });

  it("renders the same catalog markup down both loading paths", () => {
    // The catalog already shares one component; this keeps it that way.
    expect(renderToStaticMarkup(<IntegrationsLoading />)).toContain(
      renderToStaticMarkup(<IntegrationsSkeleton />)
    );
  });

  it("reserves a card per provider the catalog actually lists", () => {
    // Four per section left the placeholder 22% shorter than the page: custody
    // alone renders ten. Measured at 1832px page against 1820px skeleton.
    const expected =
      CUSTODY_PROVIDER_CATALOG.filter((entry) => entry.visible).length +
      (ORGANIZATION_RPC_PROVIDERS.length - 1) +
      RAMP_PROVIDERS.length +
      COMPLIANCE_PROVIDERS.length;

    const markup = renderToStaticMarkup(<IntegrationsSkeleton />);
    expect(markup.match(/h-\[120px\]/g)).toHaveLength(expected);
  });
});
