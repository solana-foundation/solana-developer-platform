/** Deployment currently initializes all authorities with the token's signer.
 * Never silently deploy a draft whose requested wallets would be ignored.
 */
export function getDraftDeploymentBlocker(
  assignments: Record<string, string> | undefined,
  signingWalletId: string | null | undefined
): string | null {
  if (Object.values(assignments ?? {}).some((id) => id && id !== signingWalletId)) {
    return "Deployment currently requires the same wallet for every permission. You can transfer permissions after deployment.";
  }
  return null;
}
