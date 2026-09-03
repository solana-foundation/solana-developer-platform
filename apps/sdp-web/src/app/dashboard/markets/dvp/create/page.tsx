import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchDvpCreateContext } from "./dvp-create.data";
import { DvpCreateWorkspace } from "./dvp-create-workspace";

/** Wallets and issued tokens are project-scoped and change; never cache them. */
export const dynamic = "force-dynamic";

export default async function DvpCreatePage() {
  return withDashboardPageTrace("dashboard.dvp.create.page", async ({ apiClient }) => {
    const context = await fetchDvpCreateContext(apiClient.request);
    return <DvpCreateWorkspace context={context} />;
  });
}
