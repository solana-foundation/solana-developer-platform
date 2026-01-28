import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  addProjectMemberRequestSchema,
  createApiKeyRequestSchema,
  createProjectRequestSchema,
  errorResponseSchema,
  includeArchivedQuerySchema,
  memberIdParamSchema,
  projectIdParamSchema,
  updateProjectMemberRequestSchema,
  updateProjectRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import {
  apiKeyCreateResponse,
  listProjectApiKeysResponse,
  listProjectMembersResponse,
  listProjectsResponse,
  projectMemberResponse,
  projectResponse,
} from "./responses";

export function registerProjectPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/projects",
    tags: ["Projects"],
    summary: "Create project",
    operationId: "createProject",
    description: "Creates a project within the organization.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createProjectRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Project created",
        content: jsonContent(projectResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/projects",
    tags: ["Projects"],
    summary: "List projects",
    operationId: "listProjects",
    description: "Lists projects in the organization.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        includeArchived: includeArchivedQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Projects list",
        content: jsonContent(listProjectsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/projects/{projectId}",
    tags: ["Projects"],
    summary: "Get project",
    operationId: "getProject",
    description: "Gets project details.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        projectId: projectIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Project",
        content: jsonContent(projectResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/projects/{projectId}",
    tags: ["Projects"],
    summary: "Update project",
    operationId: "updateProject",
    description: "Updates project attributes.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        projectId: projectIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(updateProjectRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Project updated",
        content: jsonContent(projectResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/projects/{projectId}",
    tags: ["Projects"],
    summary: "Archive project",
    operationId: "archiveProject",
    description: "Archives a project and prevents future writes.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        projectId: projectIdParamSchema,
      }),
    },
    responses: {
      204: {
        description: "Project archived",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/projects/{projectId}/members",
    tags: ["Projects"],
    summary: "List project members",
    operationId: "listProjectMembers",
    description: "Lists members assigned to the project.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        projectId: projectIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Project members",
        content: jsonContent(listProjectMembersResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/projects/{projectId}/members",
    tags: ["Projects"],
    summary: "Add project member",
    operationId: "addProjectMember",
    description: "Adds an organization member to the project.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        projectId: projectIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(addProjectMemberRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Project member added",
        content: jsonContent(projectMemberResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/projects/{projectId}/members/{memberId}",
    tags: ["Projects"],
    summary: "Update project member",
    operationId: "updateProjectMember",
    description: "Updates a project member role.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        projectId: projectIdParamSchema,
        memberId: memberIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(updateProjectMemberRequestSchema),
      },
    },
    responses: {
      204: {
        description: "Project member updated",
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/projects/{projectId}/members/{memberId}",
    tags: ["Projects"],
    summary: "Remove project member",
    operationId: "removeProjectMember",
    description: "Removes a member from the project.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        projectId: projectIdParamSchema,
        memberId: memberIdParamSchema,
      }),
    },
    responses: {
      204: {
        description: "Project member removed",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/projects/{projectId}/api-keys",
    tags: ["Projects"],
    summary: "List project API keys",
    operationId: "listProjectApiKeys",
    description: "Lists API keys scoped to the project.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        projectId: projectIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Project API keys",
        content: jsonContent(listProjectApiKeysResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/projects/{projectId}/api-keys",
    tags: ["Projects"],
    summary: "Create project API key",
    operationId: "createProjectApiKey",
    description: "Creates an API key scoped to the project. The full key is returned once.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        projectId: projectIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(createApiKeyRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Project API key created",
        content: jsonContent(apiKeyCreateResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });
}
