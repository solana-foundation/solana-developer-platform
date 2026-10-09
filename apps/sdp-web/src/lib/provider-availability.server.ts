import "server-only";

import { type ProjectProviderAvailability, projectProviderAvailabilitySchema } from "@sdp/types";
import { requestProjectId, type SdpApiClient } from "@/lib/sdp-api";

/**
 * Reads which providers the request's project can use, and how, from
 * `GET /v1/projects/:projectId/provider-availability`.
 *
 * @param client - The client scoped to the request's project.
 * @returns The project's environment and every provider the deployment knows,
 *   with its availability for the project.
 */
export async function fetchProjectProviderAvailability(
  client: SdpApiClient
): Promise<ProjectProviderAvailability> {
  const projectId = await requestProjectId();
  const body = await client.fetch<unknown>(
    `/v1/projects/${encodeURIComponent(projectId)}/provider-availability`
  );
  return projectProviderAvailabilitySchema.parse(body);
}
