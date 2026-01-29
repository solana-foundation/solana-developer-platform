import { z } from "zod";

import {
  actionSuccessSchema,
  allowlistEntriesResponseSchema,
  allowlistEntrySchema,
  apiKeyDetailSchema,
  apiKeyResponseSchema,
  createOrganizationResponseSchema,
  currentUserResponseSchema,
  executeBurnResponseSchema,
  executeMintResponseSchema,
  frozenAccountResponseSchema,
  inviteMemberResponseSchema,
  listApiKeysResponseSchema,
  listMembersResponseSchema,
  listProjectApiKeysResponseSchema,
  listProjectMembersResponseSchema,
  listProjectsResponseSchema,
  listSessionsResponseSchema,
  listTemplatesResponseSchema,
  organizationSchema,
  paginatedResponseSchema,
  prepareBurnResponseSchema,
  prepareDeployResponseSchema,
  prepareMintResponseSchema,
  projectMemberResponseSchema,
  projectResponseSchema,
  revokeApiKeyResponseSchema,
  rotateApiKeyResponseSchema,
  sendMagicLinkResponseSchema,
  successResponseSchema,
  tokenAllowlistEntrySchema,
  tokenAllowlistResponseSchema,
  tokenResponseSchema,
  tokenSchema,
  tokenTemplateResponseSchema,
  verifyMagicLinkResponseSchema,
} from "../schemas";

export const createOrganizationResponse = successResponseSchema(createOrganizationResponseSchema);
export const organizationResponse = successResponseSchema(organizationSchema);

export const listMembersResponse = successResponseSchema(listMembersResponseSchema);
export const inviteMemberResponse = successResponseSchema(inviteMemberResponseSchema);
export const actionSuccessResponse = successResponseSchema(actionSuccessSchema);

export const listApiKeysResponse = successResponseSchema(listApiKeysResponseSchema);
export const apiKeyDetailResponse = successResponseSchema(apiKeyDetailSchema);
export const apiKeyCreateResponse = successResponseSchema(apiKeyResponseSchema);
export const apiKeyRotateResponse = successResponseSchema(rotateApiKeyResponseSchema);
export const apiKeyRevokeResponse = successResponseSchema(revokeApiKeyResponseSchema);

export const projectResponse = successResponseSchema(projectResponseSchema);
export const listProjectsResponse = successResponseSchema(listProjectsResponseSchema);
export const listProjectMembersResponse = successResponseSchema(listProjectMembersResponseSchema);
export const projectMemberResponse = successResponseSchema(projectMemberResponseSchema);
export const listProjectApiKeysResponse = successResponseSchema(listProjectApiKeysResponseSchema);

export const tokenResponse = successResponseSchema(tokenResponseSchema);
export const tokenListResponse = paginatedResponseSchema(tokenSchema);
export const tokenAllowlistListResponse = paginatedResponseSchema(tokenAllowlistEntrySchema);
export const tokenAllowlistResponse = successResponseSchema(tokenAllowlistResponseSchema);
export const frozenAccountResponse = successResponseSchema(frozenAccountResponseSchema);

export const prepareDeployResponse = successResponseSchema(prepareDeployResponseSchema);
export const prepareMintResponse = successResponseSchema(prepareMintResponseSchema);
export const executeMintResponse = successResponseSchema(executeMintResponseSchema);
export const prepareBurnResponse = successResponseSchema(prepareBurnResponseSchema);
export const executeBurnResponse = successResponseSchema(executeBurnResponseSchema);

export const sendMagicLinkResponse = successResponseSchema(sendMagicLinkResponseSchema);
export const verifyMagicLinkResponse = successResponseSchema(verifyMagicLinkResponseSchema);
export const currentUserResponse = successResponseSchema(currentUserResponseSchema);
export const listSessionsResponse = successResponseSchema(listSessionsResponseSchema);

export const allowlistEntriesResponse = successResponseSchema(allowlistEntriesResponseSchema);
export const allowlistEntryResponse = successResponseSchema(
  z.object({ entry: allowlistEntrySchema })
);

export const tokenTemplateResponse = successResponseSchema(tokenTemplateResponseSchema);
export const listTemplatesResponse = successResponseSchema(listTemplatesResponseSchema);
