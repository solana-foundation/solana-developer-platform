import type { AppDb } from "@/db";
import type { ProjectUserRepository, ProjectUserRow } from "./project-user.repository";

function mapRow(row: Record<string, unknown>): ProjectUserRow {
  return {
    id: row.id as string,
    email: row.email as string,
    name: (row.name ?? null) as string | null,
    role: row.role as string,
  };
}

export function createPostgresProjectUserRepository(db: AppDb): ProjectUserRepository {
  return {
    async getByProjectAndUserId(projectId, userId) {
      const row = await db
        .prepare(
          `SELECT u.id AS id,
                  u.email AS email,
                  u.name AS name,
                  pm.role AS role
             FROM users u
             INNER JOIN project_members pm ON pm.user_id = u.id
            WHERE pm.project_id = ?
              AND u.id = ?`
        )
        .bind(projectId, userId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },
  };
}
