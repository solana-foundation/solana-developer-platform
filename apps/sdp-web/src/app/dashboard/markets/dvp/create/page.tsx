import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { getSelectedProjectId } from "@/lib/sdp-api";
import { fetchDvpCreateContext } from "./dvp-create.data";
import { DvpCreateClient } from "./dvp-create-client";

/** Wallets and issued tokens are project-scoped and change; never cache them. */
export const dynamic = "force-dynamic";

export default async function DvpCreatePage() {
  return withDashboardPageTrace("dashboard.dvp.create.page", async ({ apiClient }) => {
    // The project this form is reviewed under, captured at render time. The
    // submit must present it and is refused when the shared selection has since
    // moved (APE-693). `getSelectedProjectId` is request-cached and resolves
    // through the same chain `createSdpApiClient` just pinned, so it IS the
    // project every context fetch above ran against; absent means the client
    // construction already threw.
    const [context, reviewedProjectId] = await Promise.all([
      fetchDvpCreateContext(apiClient.request),
      getSelectedProjectId(),
    ]);
    if (!reviewedProjectId) {
      throw new Error("Selected project required");
    }
    return <DvpCreateClient context={context} reviewedProjectId={reviewedProjectId} />;
  });
}
