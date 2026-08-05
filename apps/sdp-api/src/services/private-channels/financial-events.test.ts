import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateChannelDepositRow, PrivateChannelWithdrawalRow } from "@/db/repositories";
import * as eventService from "@/services/private-channels/event.service";
import type { Env } from "@/types/env";
import { emitDepositEvent } from "./deposit-events";
import { emitWithdrawalEvent } from "./withdraw-events";

const ENV = {} as Env;
const NOW = "2026-07-30T12:00:00.000Z";

const DEPOSIT: PrivateChannelDepositRow = {
  id: "dep_event_test",
  organization_id: "org_event_test",
  project_id: "prj_event_test",
  instance_id: "pci_event_test",
  wallet_id: "wallet_depositor",
  depositor: "wallet-a",
  recipient: "wallet-b",
  mint: "mint",
  amount: "1.5",
  status: "submitted",
  signature: "deposit-signature",
  settlement_ref: null,
  failure_reason: null,
  context: { actingUserId: "usr_depositor" },
  created_at: NOW,
  updated_at: NOW,
};

const WITHDRAWAL: PrivateChannelWithdrawalRow = {
  id: "wd_event_test",
  organization_id: "org_event_test",
  project_id: "prj_event_test",
  instance_id: "pci_event_test",
  wallet_id: "wallet_owner",
  owner: "wallet-c",
  destination: "wallet-d",
  mint: "mint",
  amount: "2.5",
  status: "confirmed",
  signature: "withdrawal-signature",
  settlement_ref: null,
  failure_reason: null,
  context: { actingUserId: "usr_owner" },
  created_at: NOW,
  updated_at: NOW,
};

let emit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  emit = vi.fn(async () => undefined);
  vi.spyOn(eventService, "createPrivateChannelEventService").mockReturnValue({
    emit,
  } as unknown as eventService.PrivateChannelEventService);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("financial event emitters", () => {
  it("attributes deposit events and keeps wallet context in the payload", async () => {
    await emitDepositEvent(ENV, DEPOSIT, "transfer.deposit.submitted", "pending");

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        sdpUserId: "usr_depositor",
        payload: expect.objectContaining({
          senderWalletId: DEPOSIT.wallet_id,
          sender: DEPOSIT.depositor,
          recipient: DEPOSIT.recipient,
        }),
      })
    );
  });

  it("attributes withdrawal events and names each address once", async () => {
    await emitWithdrawalEvent(ENV, WITHDRAWAL, "transfer.withdrawal.confirmed", "confirmed");

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        sdpUserId: "usr_owner",
        payload: {
          withdrawalId: WITHDRAWAL.id,
          senderWalletId: WITHDRAWAL.wallet_id,
          sender: WITHDRAWAL.owner,
          recipient: WITHDRAWAL.destination,
          amount: WITHDRAWAL.amount,
          mint: WITHDRAWAL.mint,
        },
      })
    );
  });
});
