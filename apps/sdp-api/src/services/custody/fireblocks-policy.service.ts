import { readFireblocksAddressBook } from "@sdp/custody/provisioning/fireblocks-address-book";
import { FireblocksApiError } from "@sdp/custody/provisioning/fireblocks-http";
import { readFireblocksPolicy } from "@sdp/custody/provisioning/fireblocks-policy";
import { evaluateFireblocksTransferPolicy } from "@sdp/custody/provisioning/fireblocks-policy-match";
import type {
  FireblocksPolicyCheck,
  FireblocksPolicySelection,
} from "@sdp/types/fireblocks-policy";
import { AppError, serviceUnavailable } from "@/lib/errors";
import type { AppContext } from "@/routes/payments/context";
import {
  resolveFireblocksDestinationContext,
  fireblocksRuntime as runtime,
} from "./fireblocks-address-book.service";

async function policyContext(c: AppContext, input: FireblocksPolicySelection) {
  const ctx = await resolveFireblocksDestinationContext(c, input);
  // Read the policy first: an unauthorized connection does not incur directory/book calls.
  const policy = await readFireblocksPolicy(runtime, ctx.access);
  if (!policy.valid) throw serviceUnavailable("Fireblocks policy validation is unavailable");
  const entries = await readFireblocksAddressBook(runtime, ctx.access);
  const matches = entries.filter(
    (entry) =>
      entry.assetId === ctx.assetId &&
      entry.address === ctx.address &&
      entry.status === "APPROVED" &&
      (!entry.activationTime || Date.parse(entry.activationTime) <= Date.now())
  );
  // Ambiguous whitelist ownership must be resolved in Fireblocks, never guessed.
  if (matches.length > 1)
    throw serviceUnavailable("This address has multiple Fireblocks whitelist entries");
  const destination = matches[0] ?? null;
  const match = evaluateFireblocksTransferPolicy(policy.rules, {
    initiatorId: ctx.access.apiKey,
    vaultId: ctx.access.vaultAccountId,
    assetId: ctx.assetId,
    amount: input.amount,
    destination,
  });
  return match;
}
export async function checkFireblocksPolicy(
  c: AppContext,
  input: FireblocksPolicySelection
): Promise<FireblocksPolicyCheck> {
  try {
    const match = await policyContext(c, input);
    return { state: match.state, ruleName: match.ruleName };
  } catch (error) {
    if (error instanceof FireblocksApiError && error.status === 403)
      return { state: "permission_required" };
    // Retain authorization/tenant/address errors; provider outages are not absence.
    if (error instanceof AppError && error.statusCode < 500) throw error;
    return { state: "unknown" };
  }
}
