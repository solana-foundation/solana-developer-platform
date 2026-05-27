import type { ProjectEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";

const DEFAULT_ENVIRONMENTS: ProjectEnvironment[] = ["sandbox", "production"];

export async function ensureDefaultProjects(
  c: Context<{ Bindings: Env }>,
  organizationId: string,
  userId: string
): Promise<void> {
  const service = new ProjectService(getDb(c.env));

  await Promise.all(
    DEFAULT_ENVIRONMENTS.map((environment) =>
      service.findOrCreateDefault(organizationId, environment, userId)
    )
  );
}
