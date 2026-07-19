import type {
  CustodyWalletByIdResponse,
  WalletControlProfileRevisionHistory,
  WalletPolicyEvaluationDetail,
} from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { PolicyTranslate } from "./policy-audit.shared";
import { PolicyAuditDetail } from "./policy-audit-detail";
import { PolicyAuditList } from "./policy-audit-list";

const LONG_ACTOR_ID = "usr_sdp_design_review_clerk_test_example_com_local";
const t: PolicyTranslate = (key, values) => translate(getMessages("en"), key, values);

const evaluation: WalletPolicyEvaluationDetail = {
  id: "evaluation-long-actor",
  walletOperation: {
    id: "operation-long-actor",
    operationFamily: "payment",
    operationType: "payment_transfer_execute",
    asset: "SOL",
    amount: "0.42",
    destination: "7VbT5HkP2yWm8Qx4Nc3Jf9Rs6La1De7Ug4Zp8Mv2Ko6A",
    status: "pending_approval",
    createdAt: "2026-07-18T15:04:12.000Z",
    updatedAt: "2026-07-18T15:04:13.000Z",
  },
  policyRevisions: {
    wallet: {
      evaluatedRevisionId: "revision-1",
      activeRevisionId: "revision-1",
    },
    apiKey: { evaluatedRevisionId: null, activeRevisionId: null },
  },
  decision: "approval_required",
  reasonCode: "wallet_policy_match",
  reason: "Direct payments are blocked by the active wallet policy.",
  matchedRules: [],
  evaluationContext: {
    operation: {
      id: "operation-long-actor",
      organizationId: "organization-1",
      projectId: "project-1",
      custodyWalletId: "custody-wallet-1",
      walletId: "wallet-1",
      apiKeyId: null,
      actor: { type: "user", id: LONG_ACTOR_ID },
      source: "payments",
      operationFamily: "payment",
      operationType: "payment_transfer_execute",
      asset: "SOL",
      amount: "0.42",
      destination: "7VbT5HkP2yWm8Qx4Nc3Jf9Rs6La1De7Ug4Zp8Mv2Ko6A",
      context: { requestId: "request-long-actor" },
      idempotencyKey: null,
      createdAt: "2026-07-18T15:04:12.000Z",
    },
    walletPolicy: {
      source: "customer_profile",
      profileId: "profile-1",
      revisionId: "revision-1",
      defaultAction: "allow",
      decision: "approval_required",
      requiresApproval: true,
    },
    apiKeyPolicy: null,
  },
  requiresApproval: true,
  approvalRequestId: null,
  evaluatedAt: "2026-07-18T15:04:12.120Z",
};

const revisionHistory: WalletControlProfileRevisionHistory = {
  profile: null,
  revisions: [
    {
      id: "revision-1",
      profileId: "profile-1",
      revisionNumber: 1,
      rules: [],
      defaultAction: "allow",
      createdBy: null,
      createdAt: "2026-07-18T13:30:00.000Z",
      activatedAt: "2026-07-18T13:35:00.000Z",
      isActive: true,
    },
  ],
};

const wallet: CustodyWalletByIdResponse["wallet"] = {
  id: "custody-wallet-1",
  custodyConfigId: "custody-config-1",
  provider: "dfns",
  walletId: "wallet-1",
  publicKey: "wallet-public-key",
  label: "Mobile overflow proof signer",
  purpose: null,
  status: "active",
  createdAt: "2026-07-18T13:00:00.000Z",
  balance: {
    token: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    amount: "0",
    uiAmount: "0",
    decimals: 9,
  },
};

describe("policy audit presentation", () => {
  it("contains a long actor and the longest decision inside fixed desktop columns", () => {
    const html = renderToStaticMarkup(
      <PolicyAuditList
        walletId="wallet-1"
        walletLabel="Mobile overflow proof signer"
        result={{ evaluations: [evaluation], total: 1, page: 1, pageSize: 25 }}
        filters={{ page: 1 }}
        revisionHistory={revisionHistory}
        apiKeyNames={{}}
        locale="en-US"
        t={t}
      />
    );

    expect(html).toContain('data-policy-audit-actor="true"');
    expect(html).toContain('class="min-w-0 truncate"');
    expect(html).toContain(`title="User · ${LONG_ACTOR_ID}"`);
    expect(html).toContain("Approval required");
    expect(html).toContain("w-[160px]");
    expect(html).toContain("w-[195px]");
  });

  it("truncates a long actor in the mobile detail metadata row", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PolicyAuditDetail
          wallet={wallet}
          evaluation={evaluation}
          revisionHistory={revisionHistory}
          apiKeyNames={{}}
          neighbors={{ previous: null, next: null }}
          filters={{ page: 1 }}
          tab="decision"
          locale="en-US"
          t={t}
        />
      </I18nProvider>
    );

    expect(html).toContain('data-policy-audit-detail-actor="true"');
    expect(html).toContain('data-policy-audit-detail-rail-actor="true"');
    expect(html).toContain('class="min-w-0 flex-1 truncate"');
    expect(html).toContain(`title="User · ${LONG_ACTOR_ID}"`);
    expect(html).toContain("inline-flex min-w-0 max-w-full items-center gap-2");
  });
});
