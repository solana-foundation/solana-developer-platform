import {
  createSystemCustodyProposalsRepository,
  createSystemPaymentsRepository,
  createSystemTransactionalCustodyProposalsRepository,
  createSystemTransactionalPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { createSystemAuditService } from "@/services/audit.service";
import type { ProposalLedger } from "@/services/payments/custody-proposal-ledger";
import type { Env } from "@/types/env";

/** Proposal state, payment projection and audit effects share one system transaction. */
export function systemProposalLedger(env: Env): ProposalLedger {
  return {
    repo: createSystemPaymentsRepository(env),
    proposals: createSystemCustodyProposalsRepository(env),
    audited: (work) =>
      createSystemAuditService(env).logSystemWithin((tx) =>
        work(
          createSystemTransactionalPaymentsRepository(tx),
          createSystemTransactionalCustodyProposalsRepository(tx)
        )
      ),
  };
}
