/** Internal dashboard contract; Fireblocks policy checks is not a public SDP API. */
export interface FireblocksPolicySelection {
  walletId: string;
  counterpartyId: string;
  accountId: string;
  token: string;
  address: string;
  amount: string;
}
export interface FireblocksPolicyCheck {
  state: "covered" | "missing" | "blocked" | "unknown" | "permission_required";
  ruleName?: string;
}
