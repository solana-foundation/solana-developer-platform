import { getTranslations } from "@/i18n/server";
import {
  createProjectBoundSdpApiClient,
  getSelectedProjectId,
  type SdpApiClient,
} from "@/lib/sdp-api";

export type ProjectBoundClientResult =
  | { ok: true; client: SdpApiClient }
  | { ok: false; message: string };

/**
 * Builds the mutation client from the project the page rendered with instead of
 * re-resolving the mutable selection cookie at submit time: a sibling tab that
 * moves `sdp_selected_project_id` between render and submit must never redirect
 * a Private Channels mutation into another project's instance and principal.
 * The request's current selection is checked against the rendered project
 * first, so a stale page is told to reload rather than acting under a scope it
 * was never shown, and an unlisted project fails closed. The API still
 * authorizes membership on every request.
 */
export async function bindRenderedProjectClient(
  projectId: string
): Promise<ProjectBoundClientResult> {
  const t = await getTranslations();
  if (!projectId) {
    return { ok: false, message: t("DashboardPrivateChannels.common.projectRequired") };
  }
  const selectedProjectId = await getSelectedProjectId();
  if (selectedProjectId !== projectId) {
    return { ok: false, message: t("DashboardPrivateChannels.common.staleProject") };
  }
  return { ok: true, client: await createProjectBoundSdpApiClient(projectId) };
}
