// SDP project-member lookup: `users` joined with `project_members` to answer
// "is user X a member of project Y, and what's their SDP role?".

import type { RepositoryDbClient } from "./base";

/** SDP user projected with their project-role. */
export interface ProjectUserRow {
  /** users.id */
  id: string;
  email: string;
  name: string | null;
  /** project_members.role — 'admin' | 'developer' | … */
  role: string;
}

export interface ProjectUserRepositoryContext {
  db: RepositoryDbClient;
}

export interface ProjectUserRepository {
  /** Returns null when the user isn't a member of this project. */
  getByProjectAndUserId(projectId: string, userId: string): Promise<ProjectUserRow | null>;
}
