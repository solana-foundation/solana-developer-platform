/**
 * Project Types
 *
 * Projects group API keys by team or environment within an organization.
 */

import { ORGANIZATION_RPC_PROVIDERS } from "./organizations";
import type { ProjectRole } from "./permissions";

export type ProjectEnvironment = "sandbox" | "beta" | "production";

export type ProjectStatus = "active" | "archived";

export const PROJECT_RPC_PROVIDERS = [...ORGANIZATION_RPC_PROVIDERS, "custom"] as const;
export type ProjectRpcProvider = (typeof PROJECT_RPC_PROVIDERS)[number];

// Re-export ProjectRole for convenience
export type { ProjectRole } from "./permissions";

export interface ProjectSettings {
  rpcProvider?: ProjectRpcProvider;
  rpcEndpoint?: string;
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
  role: ProjectRole;
  createdAt: string;
}

// API Request/Response types
export interface CreateProjectRequest {
  name: string;
  slug?: string; // Auto-generated from name if not provided
  description?: string;
  environment?: ProjectEnvironment;
  settings?: ProjectSettings;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  environment?: ProjectEnvironment;
  settings?: ProjectSettings;
}

export interface ProjectResponse {
  project: Project;
}

export interface ListProjectsResponse {
  projects: Project[];
}

export interface AddProjectMemberRequest {
  userId: string;
  role?: ProjectRole;
}

export interface UpdateProjectMemberRequest {
  role: ProjectRole;
}

export interface ProjectMemberResponse {
  member: ProjectMember & {
    user: {
      id: string;
      email: string;
      name: string | null;
    };
  };
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
