import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { success } from "@/lib/response";
import { getProjectProviderAvailability } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

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
  return success(c, availability);
};
