import { describe, expect, it } from "vitest";
import { APPROVED_WALLET_OPERATIONS_MONITOR } from "./approved-wallet-operations";
import { DVP_TRADES_MONITOR } from "./dvp-trades";
import { EARN_CATALOGUE_SYNC_MONITOR } from "./earn-catalogue-sync";
import { EARN_METRICS_REFRESH_MONITOR } from "./earn-metrics-refresh";
import { EARN_SPLIT_SWAPS_MONITOR } from "./earn-split-swaps";
import { EARN_VAULT_MOVEMENTS_MONITOR } from "./earn-vault-movements";
import { CRON_MONITOR_MONEY_EFFECTS } from "./money-effects";
import { PENDING_DEPOSITS_MONITOR } from "./pending-deposits";
import { PENDING_TRANSFERS_MONITOR } from "./pending-transfers";
import { PENDING_WITHDRAWALS_MONITOR } from "./pending-withdrawals";
import { PROVIDER_CREDENTIAL_SECRET_CLEANUP_MONITOR } from "./provider-credential-secret-cleanup";
import { RECURRING_PAYMENTS_COLLECTION_MONITOR } from "./recurring-payments";
import { REVOKED_API_KEY_CACHE_MONITOR } from "./revoked-api-key-cache";
import { RINGS_INDEXING_MONITOR } from "./rings-indexing";
import { SECRET_RETIREMENTS_MONITOR } from "./secret-retirements";

describe("cron money effects (HOO-1955)", () => {
  it("classifies exactly the monitors the cron modules declare", () => {
    expect(Object.keys(CRON_MONITOR_MONEY_EFFECTS).sort()).toEqual(
      [
        APPROVED_WALLET_OPERATIONS_MONITOR,
        DVP_TRADES_MONITOR,
        EARN_CATALOGUE_SYNC_MONITOR,
        EARN_METRICS_REFRESH_MONITOR,
        EARN_SPLIT_SWAPS_MONITOR,
        EARN_VAULT_MOVEMENTS_MONITOR,
        PENDING_DEPOSITS_MONITOR,
        PENDING_TRANSFERS_MONITOR,
        PENDING_WITHDRAWALS_MONITOR,
        PROVIDER_CREDENTIAL_SECRET_CLEANUP_MONITOR,
        RECURRING_PAYMENTS_COLLECTION_MONITOR,
        REVOKED_API_KEY_CACHE_MONITOR,
        RINGS_INDEXING_MONITOR,
        SECRET_RETIREMENTS_MONITOR,
      ].sort()
    );
  });

  it("pins the jobs that start money without admission, so the list only shrinks", () => {
    const gaps = Object.entries(CRON_MONITOR_MONEY_EFFECTS)
      .filter(([, entry]) => entry.effect === "starts" && "gap" in entry.admission)
      .map(([monitor]) => monitor)
      .sort();

    expect(gaps).toEqual(["sdp-api-poll-rings-indexing", "sdp-api-track-pending-transfers"]);
  });
});
