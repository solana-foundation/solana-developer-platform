import { z } from "zod";

import {
  actionSuccessSchema,
  addressScreeningResponseSchema,
  allowlistEntriesResponseSchema,
  allowlistEntrySchema,
  apiKeyDetailSchema,
  apiKeyResponseSchema,
  counterpartyResponseSchema,
  currentUserResponseSchema,
  custodyConfigResponseSchema,
  custodyConfigsResponseSchema,
  custodyWalletAggregateResponseSchema,
  custodyWalletByIdResponseSchema,
  custodyWalletResponseSchema,
  custodyWalletsResponseSchema,
  deleteWalletResponseSchema,
  executeBurnResponseSchema,
  executeForceBurnResponseSchema,
  executeMintResponseSchema,
  executePauseResponseSchema,
  executeSeizeResponseSchema,
  executeUnpauseResponseSchema,
  executeUpdateAuthorityResponseSchema,
  frozenAccountResponseSchema,
  frozenAccountSchema,
  inviteMemberResponseSchema,
  listApiKeysResponseSchema,
  listCounterpartiesResponseSchema,
  listMembersResponseSchema,
  listProjectApiKeysResponseSchema,
  listProjectMembersResponseSchema,
  listProjectsResponseSchema,
  listSessionsResponseSchema,
  listTemplatesResponseSchema,
  offrampCurrenciesResponseSchema,
  offrampExecutionResponseSchema,
  onboardingStatusResponseSchema,
  onrampCurrenciesResponseSchema,
  onrampExecutionResponseSchema,
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
  rpcProvidersResponseSchema,
  rpcRelayResponseSchema,
  sandboxTransferSimulationResponseSchema,
  signerCheckResponseSchema,
  successResponseSchema,
  switchProviderOptionsResponseSchema,
  tokenAllowlistEntrySchema,
  tokenAllowlistResponseSchema,
  tokenResponseSchema,
  tokenSchema,
  tokenTemplateResponseSchema,
  tokenTransactionListItemSchema,
  tokenTransactionSchema,
  transferResponseSchema,
  transferSchema,
  walletBalancesResponseSchema,
  walletPolicyResponseSchema,
} from "../schemas";

export const organizationResponse = successResponseSchema(organizationSchema);

export const listMembersResponse = successResponseSchema(listMembersResponseSchema);
export const inviteMemberResponse = successResponseSchema(inviteMemberResponseSchema);
export const actionSuccessResponse = successResponseSchema(actionSuccessSchema);

export const listApiKeysResponse = successResponseSchema(listApiKeysResponseSchema);
export const apiKeyDetailResponse = successResponseSchema(apiKeyDetailSchema);
export const apiKeyCreateResponse = successResponseSchema(apiKeyResponseSchema);
export const apiKeyRotateResponse = successResponseSchema(rotateApiKeyResponseSchema);
export const apiKeyRevokeResponse = successResponseSchema(revokeApiKeyResponseSchema);

export const counterpartyResponse = successResponseSchema(counterpartyResponseSchema);
export const listCounterpartiesResponse = successResponseSchema(listCounterpartiesResponseSchema);

export const projectResponse = successResponseSchema(projectResponseSchema);
export const listProjectsResponse = successResponseSchema(listProjectsResponseSchema);
export const listProjectMembersResponse = successResponseSchema(listProjectMembersResponseSchema);
export const projectMemberResponse = successResponseSchema(projectMemberResponseSchema);
export const listProjectApiKeysResponse = successResponseSchema(listProjectApiKeysResponseSchema);
export const rpcProvidersResponse = successResponseSchema(rpcProvidersResponseSchema);
export const rpcRelayResponse = successResponseSchema(rpcRelayResponseSchema);

export const tokenResponse = successResponseSchema(tokenResponseSchema);
export const tokenListResponse = paginatedResponseSchema(tokenSchema);
export const tokenTransactionsResponse = paginatedResponseSchema(tokenTransactionSchema);
export const issuanceTransactionsResponse = paginatedResponseSchema(tokenTransactionListItemSchema);
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

export const currentUserResponse = successResponseSchema(currentUserResponseSchema);
export const listSessionsResponse = successResponseSchema(listSessionsResponseSchema);
export const custodyConfigResponse = successResponseSchema(custodyConfigResponseSchema);
export const custodyConfigsResponse = successResponseSchema(custodyConfigsResponseSchema);
export const custodyWalletResponse = successResponseSchema(custodyWalletResponseSchema);
export const custodyWalletsResponse = successResponseSchema(custodyWalletsResponseSchema);
export const custodyWalletAggregateResponse = successResponseSchema(
  custodyWalletAggregateResponseSchema
);
export const custodyWalletByIdResponse = successResponseSchema(custodyWalletByIdResponseSchema);
export const custodyDeleteWalletResponse = successResponseSchema(deleteWalletResponseSchema);
export const custodySignerCheckResponse = successResponseSchema(signerCheckResponseSchema);
export const custodySwitchOptionsResponse = successResponseSchema(
  switchProviderOptionsResponseSchema
);
export const addressScreeningResponse = successResponseSchema(addressScreeningResponseSchema);

export const allowlistEntriesResponse = successResponseSchema(allowlistEntriesResponseSchema);
export const allowlistEntryResponse = successResponseSchema(
  z.object({ entry: allowlistEntrySchema })
);

export const tokenTemplateResponse = successResponseSchema(tokenTemplateResponseSchema);
export const listTemplatesResponse = successResponseSchema(listTemplatesResponseSchema);

export const onboardingStatusResponse = successResponseSchema(onboardingStatusResponseSchema);
export const walletBalancesResponse = successResponseSchema(walletBalancesResponseSchema);
export const walletPolicyResponse = successResponseSchema(walletPolicyResponseSchema);
export const prepareTransferResponse = successResponseSchema(prepareTransferResponseSchema);
export const transferResponse = successResponseSchema(transferResponseSchema);
export const transferListResponse = paginatedResponseSchema(transferSchema);
export const onrampCurrenciesResponse = successResponseSchema(onrampCurrenciesResponseSchema);
export const offrampCurrenciesResponse = successResponseSchema(offrampCurrenciesResponseSchema);
export const onrampExecutionResponse = successResponseSchema(onrampExecutionResponseSchema);
export const offrampExecutionResponse = successResponseSchema(offrampExecutionResponseSchema);
export const sandboxTransferSimulationResponse = successResponseSchema(
  sandboxTransferSimulationResponseSchema
);
