import { z } from "zod";

import {
  actionSuccessSchema,
  allowlistEntriesResponseSchema,
  allowlistEntrySchema,
  apiKeyDetailSchema,
  apiKeyResponseSchema,
  createOrganizationResponseSchema,
  currentUserResponseSchema,
  custodySignAsyncResponseSchema,
  custodySignSyncResponseSchema,
  executeBurnResponseSchema,
  executeMintResponseSchema,
  frozenAccountResponseSchema,
  getSigningStatusResponseSchema,
  inviteMemberResponseSchema,
  listApiKeysResponseSchema,
  listMembersResponseSchema,
  listProjectApiKeysResponseSchema,
  listProjectMembersResponseSchema,
  listProjectsResponseSchema,
  listSessionsResponseSchema,
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
  submitTransactionResponseSchema,
  successResponseSchema,
  tokenAllowlistEntrySchema,
  tokenAllowlistResponseSchema,
  tokenResponseSchema,
  tokenSchema,
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

const submitTransactionEnvelope = z.object({
  data: submitTransactionResponseSchema,
});
export const submitTransactionResponse = successResponseSchema(submitTransactionEnvelope);

const custodySignSyncEnvelope = z.object({ data: custodySignSyncResponseSchema });
const custodySignAsyncEnvelope = z.object({ data: custodySignAsyncResponseSchema });

export const custodySignSyncResponse = successResponseSchema(custodySignSyncEnvelope);
export const custodySignAsyncResponse = successResponseSchema(custodySignAsyncEnvelope);

const signingStatusEnvelope = z.object({ data: getSigningStatusResponseSchema });
export const signingStatusResponse = successResponseSchema(signingStatusEnvelope);

export const sendMagicLinkResponse = successResponseSchema(sendMagicLinkResponseSchema);
export const verifyMagicLinkResponse = successResponseSchema(verifyMagicLinkResponseSchema);
export const currentUserResponse = successResponseSchema(currentUserResponseSchema);
export const listSessionsResponse = successResponseSchema(listSessionsResponseSchema);

export const allowlistEntriesResponse = successResponseSchema(allowlistEntriesResponseSchema);
export const allowlistEntryResponse = successResponseSchema(
  z.object({ entry: allowlistEntrySchema })
);
