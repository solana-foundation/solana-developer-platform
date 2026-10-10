/** Internal dashboard contract; Fireblocks policy administration is not a public SDP API. */
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
  canConfigure: boolean;
}
export interface FireblocksPolicyForm {
  name: string;
  destination: "all_whitelisted" | "selected_whitelisted" | "one_time";
  approvalGroups: { users: string[]; groups: string[]; threshold: number }[];
  approvalOperator: "AND" | "OR";
  signerMode: "SINGLE" | "MULTIPLE";
  signerIds: string[];
}
export interface FireblocksPolicySetup {
  revision: string;
  sourceName: string;
  sourceVaultId: string;
  assetId: string;
  initiatorName: string;
  destinationWhitelisted: boolean;
  people: { id: string; name: string; role: string; canSign: boolean }[];
  groups: { id: string; name: string; memberIds: string[] }[];
  defaults: FireblocksPolicyForm;
  proposal?: FireblocksPolicyProposalResult;
}
export interface FireblocksPolicyProposalResult {
  proposalId: string;
  state: "draft" | "invalid" | "submitted" | "unknown" | "failed";
  draftId?: string;
}
