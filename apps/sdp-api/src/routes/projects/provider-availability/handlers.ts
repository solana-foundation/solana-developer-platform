import type { ProjectProviderAvailability } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { success } from "@/lib/response";
import { EARN_PUBLIC_SURFACE_PUBLISHED } from "@/openapi/spec";
import { getProjectProviderAvailability } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Narrows a project's provider availability to the families the public API
 * document publishes: Earn entries are left out while
 * `EARN_PUBLIC_SURFACE_PUBLISHED` is false, so a client validating against the
 * published spec accepts the response.
 *
 * @param availability - The project's availability across every family.
 * @returns The availability restricted to the published families.
 */
function publishedProviderAvailability(
  availability: ProjectProviderAvailability
): ProjectProviderAvailability {
  if (EARN_PUBLIC_SURFACE_PUBLISHED) {
    return availability;
  }
  return {
    ...availability,
    providers: availability.providers.filter((entry) => entry.family !== "earn"),
  };
}

/**
 * Lists every provider the deployment knows with its availability for the
 * project in the path. A project outside the caller's organization is a 404.
 *
 * @param c - Request context; the projects router has authenticated the caller,
 *   bound API keys to their own project and admitted sessions by membership.
 * @returns The project's provider availability in the success envelope.
 */
export const getProjectProviderAvailabilityHandler = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const availability = await getProjectProviderAvailability(c.env, getDb(c.env), {
    organizationId: getAuth(c).organizationId,
    projectId,
  });
  return success(c, publishedProviderAvailability(availability));
};
