"use server";

import { z } from "zod";
import { listSdpProjectsForToken, SdpApiResponseError } from "@/lib/sdp-api";

const projectOrganizationRequestSchema = z.object({
  projectId: z.string().min(1),
  // One session token per other organization the user belongs to.
  organizationTokens: z.array(z.string().min(1)).max(100),
});

/**
 * Which of the user's other organizations lists a Project, so a URL naming that
 * Project can make its organization active instead of redirecting away (HOO-2622).
 * Each token is one the browser minted for one of its own organizations; sdp-api
 * verifies it and lists only what its holder may already list, so this answers
 * nothing the caller could not ask sdp-api directly. An organization SDP does not
 * admit the user to (401, 403) does not list the Project.
 *
 * @param projectId - The Project the URL names.
 * @param organizationTokens - Session tokens, one per candidate organization.
 * @returns The index of the token whose organization lists the Project, or null.
 */
export async function findProjectOrganization(
  projectId: string,
  organizationTokens: readonly string[]
): Promise<number | null> {
  const request = projectOrganizationRequestSchema.parse({ projectId, organizationTokens });
  const listed = await Promise.all(
    request.organizationTokens.map(async (token) => {
      try {
        const projects = await listSdpProjectsForToken(token);
        return projects.some((project) => project.id === request.projectId);
      } catch (error) {
        if (error instanceof SdpApiResponseError && [401, 403].includes(error.status)) {
          return false;
        }
        throw error;
      }
    })
  );
  const index = listed.indexOf(true);
  return index === -1 ? null : index;
}
