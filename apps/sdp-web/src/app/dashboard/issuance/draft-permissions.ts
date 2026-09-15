/** Deployment currently initializes all authorities with the token's signer.
 * Never silently deploy a draft whose requested wallets would be ignored.
 */
export function getDraftDeploymentBlocker(
  assignments: Record<string, string> | undefined,
  signingWalletId: string | null | undefined
): "DashboardIssuance.draftForm.singleSignerRequired" | null {
  if (Object.values(assignments ?? {}).some((id) => id && id !== signingWalletId)) {
    return "DashboardIssuance.draftForm.singleSignerRequired";
  }
  return null;
}
