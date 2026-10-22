/**
 * Project Types
 *
 * Projects group API keys by team or environment within an organization.
 */

export type ProjectEnvironment = "sandbox" | "production";

export const PROJECT_STATUSES = ["active", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Project statuses whose API keys may authenticate: an archived project's keys stop working. */
export const PROJECT_STATUSES_THAT_MAY_AUTHENTICATE = [
  "active",
] as const satisfies readonly ProjectStatus[];

/** Takes the raw column: an unknown status may not authenticate. */
export function projectStatusMayAuthenticate(status: string): boolean {
  return PROJECT_STATUSES_THAT_MAY_AUTHENTICATE.some((allowed) => allowed === status);
}

export interface ProjectSettings {
  webhookUrl?: string;
  metadata?: Record<string, string>;
}

export interface Project {
  id: string; // prj_xxxxxxxxxxxx
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  environment: ProjectEnvironment;
  settings: ProjectSettings | null;
  status: ProjectStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  id: string; // pm_xxxxxxxxxxxx
  projectId: string;
  userId: string;
  createdAt: string;
}

// API Request/Response types
export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  settings?: ProjectSettings;
}

export interface ProjectResponse {
  project: Project;
}

export interface ListProjectsResponse {
  projects: Project[];
}

export interface ListProjectMembersResponse {
  members: Array<
    ProjectMember & {
      user: {
        id: string;
        email: string;
        name: string | null;
      };
    }
  >;
}
