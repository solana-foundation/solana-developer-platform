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
  executeForceBurnResponseSchema,
  executeMintResponseSchema,
  executePauseResponseSchema,
  executeSeizeResponseSchema,
  executeUnpauseResponseSchema,
  executeUpdateAuthorityResponseSchema,
  feeQuoteResponseSchema,
  frozenAccountResponseSchema,
  frozenAccountSchema,
  inviteMemberResponseSchema,
  linkOrganizationResponseSchema,
  listApiKeysResponseSchema,
  listMembersResponseSchema,
  listProjectApiKeysResponseSchema,
  listProjectMembersResponseSchema,
  listProjectsResponseSchema,
  listSessionsResponseSchema,
  listTemplatesResponseSchema,
  onboardingStatusResponseSchema,
  offrampExecutionResponseSchema,
  offrampQuoteResponseSchema,
  onrampExecutionResponseSchema,
  onrampQuoteResponseSchema,
  organizationSchema,
  paginatedResponseSchema,
  prepareBurnResponseSchema,
  prepareDeployResponseSchema,
  prepareForceBurnResponseSchema,
  prepareMintResponseSchema,
  prepareSeizeResponseSchema,
  prepareTransferResponseSchema,
  prepareUpdateAuthorityResponseSchema,
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
  transferResponseSchema,
  transferSchema,
  verifyMagicLinkResponseSchema,
  walletBalancesResponseSchema,
  walletPolicyResponseSchema,
  walletResponseSchema,
  walletSchema,
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
export const frozenAccountListResponse = paginatedResponseSchema(frozenAccountSchema);

export const prepareDeployResponse = successResponseSchema(prepareDeployResponseSchema);
export const prepareMintResponse = successResponseSchema(prepareMintResponseSchema);
export const executeMintResponse = successResponseSchema(executeMintResponseSchema);
export const prepareBurnResponse = successResponseSchema(prepareBurnResponseSchema);
export const executeBurnResponse = successResponseSchema(executeBurnResponseSchema);
export const prepareSeizeResponse = successResponseSchema(prepareSeizeResponseSchema);
export const executeSeizeResponse = successResponseSchema(executeSeizeResponseSchema);
export const prepareForceBurnResponse = successResponseSchema(prepareForceBurnResponseSchema);
export const executeForceBurnResponse = successResponseSchema(executeForceBurnResponseSchema);
export const prepareUpdateAuthorityResponse = successResponseSchema(
  prepareUpdateAuthorityResponseSchema
);
export const executeUpdateAuthorityResponse = successResponseSchema(
  executeUpdateAuthorityResponseSchema
);
export const executePauseResponse = successResponseSchema(executePauseResponseSchema);
export const executeUnpauseResponse = successResponseSchema(executeUnpauseResponseSchema);

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

export const onboardingStatusResponse = successResponseSchema(onboardingStatusResponseSchema);
export const linkOrganizationResponse = successResponseSchema(linkOrganizationResponseSchema);
export const walletResponse = successResponseSchema(walletResponseSchema);
export const walletListResponse = paginatedResponseSchema(walletSchema);
export const walletBalancesResponse = successResponseSchema(walletBalancesResponseSchema);
export const walletPolicyResponse = successResponseSchema(walletPolicyResponseSchema);
export const prepareTransferResponse = successResponseSchema(prepareTransferResponseSchema);
export const transferResponse = successResponseSchema(transferResponseSchema);
export const transferListResponse = paginatedResponseSchema(transferSchema);
export const feeQuoteResponse = successResponseSchema(feeQuoteResponseSchema);
export const onrampQuoteResponse = successResponseSchema(onrampQuoteResponseSchema);
export const offrampQuoteResponse = successResponseSchema(offrampQuoteResponseSchema);
export const onrampExecutionResponse = successResponseSchema(onrampExecutionResponseSchema);
export const offrampExecutionResponse = successResponseSchema(offrampExecutionResponseSchema);
