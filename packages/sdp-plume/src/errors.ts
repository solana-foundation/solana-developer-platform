export type PlumeErrorCode =
  | "INVALID_AMOUNT"
  | "DEPLOYMENT_NOT_CONFIGURED"
  | "DEPOSIT_REFUSED"
  | "WITHDRAW_REFUSED"
  | "COMPLIANCE_APPROVAL_REQUIRED"
  | "VAULT_UNREADABLE";
export class SdpPlumeError extends Error {
  constructor(
    readonly code: PlumeErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SdpPlumeError";
  }
}
