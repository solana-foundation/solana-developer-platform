import type { OrganizationStatus } from "@sdp/types/organizations";
import type { DatabaseClient } from "@/db/client";

export interface OrganizationCreator {
  id: string;
  email: string;
}

export interface SeededOrganization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  creator: OrganizationCreator;
  settings?: string | null;
  onConflict?: "do-nothing" | "update";
}

/** A creator of its own per organization: a user creates at most one live organization. */
export function organizationCreator(organizationId: string): OrganizationCreator {
  return { id: `usr_creator_${organizationId}`, email: `creator-${organizationId}@example.com` };
}

export async function seedOrganization(
  db: DatabaseClient,
  organization: SeededOrganization
): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (id) DO NOTHING")
      .bind(organization.creator.id, organization.creator.email),
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, status, settings, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ${onConflictClause(organization)}`
      )
      .bind(
        organization.id,
        organization.name,
        organization.slug,
        organization.status,
        organization.settings === undefined ? null : organization.settings,
        organization.creator.id
      ),
  ]);
}

function onConflictClause(organization: SeededOrganization): string {
  if (organization.onConflict === undefined) {
    return "";
  }
  if (organization.onConflict === "do-nothing") {
    return "ON CONFLICT (id) DO NOTHING";
  }
  const updatedColumns =
    organization.settings === undefined
      ? ["name", "slug", "status"]
      : ["name", "slug", "status", "settings"];
  return `ON CONFLICT (id) DO UPDATE SET ${updatedColumns
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(", ")}`;
}
