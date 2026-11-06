/** Pass the saved permission selections to the direct deployment API. */
export function buildDraftDeployRequest(
  signingCustodyWalletId: string,
  assignments?: Record<string, string>
) {
  return {
    feePayment: "sponsored" as const,
    signingCustodyWalletId,
    authorityCustodyWalletIds: {
      ...(assignments?.["metadata-authority"]
        ? { metadata: assignments["metadata-authority"] }
        : {}),
      ...(assignments?.["freeze-authority"] ? { freeze: assignments["freeze-authority"] } : {}),
      ...(assignments?.["permanent-delegate"]
        ? { permanentDelegate: assignments["permanent-delegate"] }
        : {}),
    },
  };
}
