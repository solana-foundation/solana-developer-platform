import type { SdpEnvironment } from "@sdp/types";
import { expect } from "vitest";
import type { DatabaseClient } from "@/db";

export const DEFAULT_PROJECT_SLUG = {
  sandbox: "default-sandbox",
  production: "default-production",
} as const satisfies Record<SdpEnvironment, string>;

export const DEFAULT_PROJECT_NAME = {
  sandbox: "Default Sandbox Project",
  production: "Default Production Project",
} as const satisfies Record<SdpEnvironment, string>;

export interface SeededProject {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  environment: SdpEnvironment;
}

export interface SeedDefaultProjectsInput {
  organizationId: string;
  /** User recorded as `created_by` on both rows. */
  createdBy: string;
  /** Users enrolled as `admin` members of both projects. */
  members: readonly string[];
  /** Row ids; derived from the organization id when omitted. */
  ids?: Record<SdpEnvironment, string>;
}

export interface SeededDefaultProjects {
  sandbox: SeededProject;
  production: SeededProject;
}

/**
 * Seed an organization's two default projects — the only project shape the product allows —
 * and enroll the given users in both. Idempotent per row id, so fixtures that upsert their
 * organization across tests without truncating can call it in every `beforeEach`.
 *
 * @param db - Test database client.
 * @param input - Organization, creator, members and optional row ids.
 * @param input.organizationId - Organization that owns both projects.
 * @param input.createdBy - User recorded as the creator of both rows.
 * @param input.members - Users enrolled as admin members of both projects.
 * @param input.ids - Explicit row ids per environment.
 * @returns The seeded sandbox and production projects.
 */
export async function seedDefaultProjects(
  db: DatabaseClient,
  input: SeedDefaultProjectsInput
): Promise<SeededDefaultProjects> {
  const ids =
    input.ids === undefined
      ? {
          sandbox: `prj_${input.organizationId}_sandbox`,
          production: `prj_${input.organizationId}_production`,
        }
      : input.ids;
  const environments: readonly SdpEnvironment[] = ["sandbox", "production"];

  await db.batch([
    ...environments.map((environment) =>
      db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, 'active', ?)
           ON CONFLICT (id) DO NOTHING`
        )
        .bind(
          ids[environment],
          input.organizationId,
          DEFAULT_PROJECT_NAME[environment],
          DEFAULT_PROJECT_SLUG[environment],
          environment,
          input.createdBy
        )
    ),
    ...environments.flatMap((environment) =>
      input.members.map((userId) =>
        db
          .prepare(
            `INSERT INTO project_members (id, project_id, user_id, role)
             VALUES (?, ?, ?, 'admin')
             ON CONFLICT (project_id, user_id) DO NOTHING`
          )
          .bind(`pm_${ids[environment]}_${userId}`, ids[environment], userId)
      )
    ),
  ]);

  const seeded = (environment: SdpEnvironment): SeededProject => ({
    id: ids[environment],
    organizationId: input.organizationId,
    slug: DEFAULT_PROJECT_SLUG[environment],
    name: DEFAULT_PROJECT_NAME[environment],
    environment,
  });
  return { sandbox: seeded("sandbox"), production: seeded("production") };
}

/**
 * Assert a read is scoped to its project: visible through the project that owns the row,
 * hidden through the organization's other project.
 *
 * @param read - Performs the read as the given project.
 * @param projects - The organization's two default projects; `own` owns the row.
 * @param projects.own - Project the row belongs to.
 * @param projects.other - The organization's other project.
 * @param isHidden - Whether a read result reveals nothing (null, empty list, 404 …).
 * @returns Resolves once both reads are asserted.
 */
export async function expectProjectScoped<T>(
  read: (projectId: string) => Promise<T>,
  projects: { own: SeededProject; other: SeededProject },
  isHidden: (result: T) => boolean
): Promise<void> {
  expect(isHidden(await read(projects.own.id))).toBe(false);
  expect(isHidden(await read(projects.other.id))).toBe(true);
}
