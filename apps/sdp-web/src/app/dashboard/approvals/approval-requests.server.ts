import type {
  ListApiKeysResponse,
  WalletApprovalRequestSummary,
  WalletPolicyEvaluationDetail,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export async function fetchApprovalRequests(
  apiClient: SdpApiClient
): Promise<WalletApprovalRequestSummary[]> {
  const [pending, recent] = await Promise.all([
    apiClient.fetch<{ approvalRequests: WalletApprovalRequestSummary[] }>(
      "/v1/wallets/approval-requests?status=pending&limit=100"
    ),
    apiClient.fetch<{ approvalRequests: WalletApprovalRequestSummary[] }>(
      "/v1/wallets/approval-requests?limit=100"
    ),
  ]);

  return [
    ...new Map(
      [...pending.approvalRequests, ...recent.approvalRequests].map((request) => [
        request.id,
        request,
      ])
    ).values(),
  ];
}

export async function fetchApprovalRequest(
  apiClient: SdpApiClient,
  approvalRequestId: string
): Promise<WalletApprovalRequestSummary> {
  const response = await apiClient.fetch<{ approvalRequest: WalletApprovalRequestSummary }>(
    `/v1/wallets/approval-requests/${encodeURIComponent(approvalRequestId)}`
  );
  return response.approvalRequest;
}

export async function fetchApprovalApiKeyNames(
  apiClient: SdpApiClient
): Promise<Record<string, string>> {
  try {
    const response = await apiClient.fetch<ListApiKeysResponse>("/v1/api-keys");
    return Object.fromEntries(response.apiKeys.map((apiKey) => [apiKey.id, apiKey.name]));
  } catch {
    return {};
  }
}

export async function fetchApprovalPolicyEvaluation(
  apiClient: SdpApiClient,
  approvalRequest: WalletApprovalRequestSummary
): Promise<WalletPolicyEvaluationDetail | null> {
  const evaluationId = approvalRequest.policyEvaluation?.id;
  if (!evaluationId) return null;

  try {
    const response = await apiClient.fetch<{
      policyEvaluation: WalletPolicyEvaluationDetail;
    }>(
      `/v1/payments/wallets/${encodeURIComponent(approvalRequest.operation.walletId)}/policies/evaluations/${encodeURIComponent(evaluationId)}`
    );
    return response.policyEvaluation;
  } catch {
    return null;
  }
}
