import { runInClusterScope } from "@sdp/rpc/scope";
import {
  address,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
} from "@solana/kit";
import { findSubscriptionAuthorityPda, SUBSCRIPTIONS_PROGRAM_ADDRESS } from "@solana/subscriptions";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { rootLogger } from "@/runtime/logger";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  epochInfoResult,
  installClusterRpcResponder,
  multipleAccountsRead,
  multipleAccountsResult,
  type StubEncodedAccount,
} from "@/test/helpers/cluster-rpc";
import { testSignature, unpulledDelegation } from "@/test/helpers/recurring-payments";
import { required } from "@/test/helpers/required";
import {
  planAccount,
  soleDestination,
  subscriptionAuthorityAccount,
  subscriptionDelegationAccount,
  tokenAccount,
  tokenMintAccount,
} from "@/test/helpers/subscription-accounts";
import {
  authorizationSetupEffect,
  collectionPulledEffect,
  delegationCanceledEffect,
  delegationCreatedEffect,
  planCreatedEffect,
  planMetadataUpdatedEffect,
  type RecurringPaymentStepEffect,
  type RecurringPaymentStepLogContext,
  readConfirmedAccounts,
  readRecurringPaymentStep,
} from "./shared";

const TIP_SLOT = 5_000;
const OWNER = address(TEST_SOLANA_ADDRESSES.wallet1);
const STRANGER = address(TEST_SOLANA_ADDRESSES.wallet2);
const STEP_ACCOUNT = address(TEST_SOLANA_ADDRESSES.wallet3);
const MINT = address(TEST_SOLANA_ADDRESSES.mint);
const [AUTHORITY] = await findSubscriptionAuthorityPda({ tokenMint: MINT, user: OWNER });
const [SOURCE_TOKEN_ACCOUNT] = await findAssociatedTokenPda({
  owner: OWNER,
  mint: MINT,
  tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
});
const LOG_CONTEXT = {
  recurring_payment_id: "prp_step_reader",
  attempt_id: "prpa_step_reader",
  step: "create_plan",
} as const satisfies RecurringPaymentStepLogContext;
const PLAN_CREATED_AT = 1_770_000_000n;
const PLAN_PARTIES = { owner: OWNER, destinations: soleDestination(STRANGER) };
const PRE_IMAGE_URI = "https://example.com/recurring/before.json";
const TARGET_URI = "https://example.com/recurring/after.json";
const logEventSchema = z.object({ event: z.string() });
const UNDECODABLE_ACCOUNT = {
  owner: SUBSCRIPTIONS_PROGRAM_ADDRESS,
  data: new Uint8Array(8),
} satisfies StubEncodedAccount;
const STEP_UNREADABLE_MESSAGE = "Recurring payment step could not be read on chain";

describe("readRecurringPaymentStep", () => {
  const rpc = installClusterRpcResponder();

  function answerChain(input: {
    blockHeight: number;
    accountsSlot: number;
    accounts: readonly (StubEncodedAccount | null)[];
  }) {
    rpc.respond("getEpochInfo", () => ({
      result: epochInfoResult({ absoluteSlot: TIP_SLOT, blockHeight: input.blockHeight }),
    }));
    rpc.respond("getMultipleAccounts", () => ({
      result: multipleAccountsResult(input.accountsSlot, input.accounts),
    }));
  }

  function readUnsavedStep(effect: RecurringPaymentStepEffect) {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      readRecurringPaymentStep({
        effect,
        savedSignature: null,
        lastValidBlockHeight: null,
        logContext: LOG_CONTEXT,
      })
    );
  }

  function readSavedStep(input: {
    effect: RecurringPaymentStepEffect;
    lastValidBlockHeight: string | null;
  }) {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      readRecurringPaymentStep({
        effect: input.effect,
        savedSignature: testSignature(7),
        lastValidBlockHeight: input.lastValidBlockHeight,
        logContext: LOG_CONTEXT,
      })
    );
  }

  function spyLogEvents(level: "warn" | "error") {
    const log = vi.spyOn(rootLogger, level).mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    return (event: string) =>
      log.mock.calls.filter(([payload]) => {
        const parsed = logEventSchema.safeParse(payload);
        return parsed.success && parsed.data.event === event;
      });
  }

  it("reads the effect at `confirmed` from a bank no older than the epoch read, in two calls", async () => {
    answerChain({
      blockHeight: 4_000,
      accountsSlot: TIP_SLOT,
      accounts: [planAccount({ ...PLAN_PARTIES, createdAt: PLAN_CREATED_AT, metadataUri: "" })],
    });

    const step = await readSavedStep({
      effect: planCreatedEffect(STEP_ACCOUNT),
      lastValidBlockHeight: "3990",
    });

    expect(step.state).toBe("landed");
    const reads = rpc.requests.filter(({ method }) => method !== "getGenesisHash");
    expect(reads.map(({ method }) => method)).toEqual(["getEpochInfo", "getMultipleAccounts"]);
    expect(required(reads[0]).params).toEqual([{ commitment: "confirmed" }]);
    expect(multipleAccountsRead(required(reads[1]))).toEqual({
      addresses: [STEP_ACCOUNT],
      commitment: "confirmed",
      minContextSlot: TIP_SLOT,
      encoding: "base64",
    });
  });

  // A lagging bank can miss a send that landed after its slot, so its "absent" never drops a step.
  it("keeps a step pending when the accounts come from a bank below the epoch read's slot", async () => {
    answerChain({ blockHeight: 4_000, accountsSlot: TIP_SLOT - 1, accounts: [null] });

    expect(
      await readSavedStep({ effect: planCreatedEffect(STEP_ACCOUNT), lastValidBlockHeight: "3990" })
    ).toEqual({ state: "pending" });
  });

  it.each([
    {
      failure: "every endpoint is behind the slot floor",
      answer: () => {
        answerChain({ blockHeight: 4_000, accountsSlot: TIP_SLOT, accounts: [] });
        rpc.respond("getMultipleAccounts", () => ({
          error: {
            code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
            message: "Minimum context slot has not been reached",
          },
        }));
      },
      effect: planCreatedEffect(STEP_ACCOUNT),
    },
    {
      failure: "the answer lists fewer accounts than were asked for",
      answer: () => answerChain({ blockHeight: 4_000, accountsSlot: TIP_SLOT, accounts: [] }),
      effect: planCreatedEffect(STEP_ACCOUNT),
    },
    {
      failure: "an effect account does not decode",
      answer: () =>
        answerChain({
          blockHeight: 4_000,
          accountsSlot: TIP_SLOT,
          accounts: [UNDECODABLE_ACCOUNT],
        }),
      effect: delegationCanceledEffect(STEP_ACCOUNT),
    },
    {
      failure: "an existing plan account does not decode",
      answer: () =>
        answerChain({
          blockHeight: 4_000,
          accountsSlot: TIP_SLOT,
          accounts: [UNDECODABLE_ACCOUNT],
        }),
      effect: planCreatedEffect(STEP_ACCOUNT),
    },
    {
      failure: "an existing delegation account does not decode",
      answer: () =>
        answerChain({
          blockHeight: 4_000,
          accountsSlot: TIP_SLOT,
          accounts: [UNDECODABLE_ACCOUNT],
        }),
      effect: delegationCreatedEffect(STEP_ACCOUNT),
    },
  ])("keeps an unsaved step pending, never unsent, when $failure", async ({ answer, effect }) => {
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    answer();

    expect(await readUnsavedStep(effect)).toEqual({ state: "pending" });
    expect(warn.mock.calls.filter(([, message]) => message === STEP_UNREADABLE_MESSAGE)).toEqual([
      [{ ...LOG_CONTEXT, err: expect.any(Error) }, STEP_UNREADABLE_MESSAGE],
    ]);
  });

  it("drops a saved send once the confirmed block height passes its stored expiry", async () => {
    answerChain({ blockHeight: 1_000, accountsSlot: TIP_SLOT, accounts: [null] });

    const step = await readSavedStep({
      effect: planCreatedEffect(STEP_ACCOUNT),
      lastValidBlockHeight: "999",
    });

    expect(step.state).toBe("dropped");
  });

  it("keeps a saved send with no stored expiry pending and logs it, since it may still land", async () => {
    const warnings = spyLogEvents("warn");
    answerChain({ blockHeight: 9_000_000, accountsSlot: TIP_SLOT, accounts: [null] });

    expect(
      await readSavedStep({ effect: planCreatedEffect(STEP_ACCOUNT), lastValidBlockHeight: null })
    ).toEqual({ state: "pending" });
    expect(warnings("sdp_api_recurring_payment_step_expiry_missing")).toEqual([
      [
        {
          event: "sdp_api_recurring_payment_step_expiry_missing",
          ...LOG_CONTEXT,
          signature: testSignature(7),
        },
        "sdp_api_recurring_payment_step_expiry_missing",
      ],
    ]);
  });

  // Only revoking a delegation after its cancel landed closes it (C8).
  it.each([
    { delegation: "closed", account: null, state: "landed" },
    {
      delegation: "still active",
      account: subscriptionDelegationAccount(unpulledDelegation(0n)),
      state: "unsent",
    },
  ] as const)(
    "reads a cancel as $state when the delegation is $delegation",
    async ({ account, state }) => {
      answerChain({ blockHeight: 4_000, accountsSlot: TIP_SLOT, accounts: [account] });

      expect((await readUnsavedStep(delegationCanceledEffect(STEP_ACCOUNT))).state).toBe(state);
    }
  );

  describe("authorization setup", () => {
    const authority = subscriptionAuthorityAccount({ user: OWNER, tokenMint: MINT });
    const delegatedSource = {
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      mint: MINT,
      owner: OWNER,
      delegate: AUTHORITY,
    };
    const effect = authorizationSetupEffect({
      subscriptionAuthorityAddress: AUTHORITY,
      sourceTokenAccount: SOURCE_TOKEN_ACCOUNT,
      owner: OWNER,
      mint: MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    it.each([
      {
        setup: "the authority exists and the source account delegates to it",
        accounts: [authority, tokenAccount(delegatedSource)],
        state: "landed",
      },
      {
        setup: "the authority does not exist",
        accounts: [null, tokenAccount(delegatedSource)],
        state: "unsent",
      },
      {
        setup: "the source account does not exist",
        accounts: [authority, null],
        state: "unsent",
      },
      {
        setup: "the source account approves no delegate",
        accounts: [authority, tokenAccount({ ...delegatedSource, delegate: null })],
        state: "unsent",
      },
      {
        setup: "the source account delegates to another address",
        accounts: [authority, tokenAccount({ ...delegatedSource, delegate: STRANGER })],
        state: "unsent",
      },
      {
        setup: "the source account belongs to another token program",
        accounts: [
          authority,
          tokenAccount({ ...delegatedSource, programAddress: TOKEN_PROGRAM_ADDRESS }),
        ],
        state: "unsent",
      },
      {
        setup: "the source account holds another mint",
        accounts: [authority, tokenAccount({ ...delegatedSource, mint: STRANGER })],
        state: "unsent",
      },
      {
        setup: "the source account has another owner",
        accounts: [authority, tokenAccount({ ...delegatedSource, owner: STRANGER })],
        state: "unsent",
      },
    ] as const)("is $state when $setup", async ({ accounts, state }) => {
      answerChain({ blockHeight: 4_000, accountsSlot: TIP_SLOT, accounts });

      expect((await readUnsavedStep(effect)).state).toBe(state);
      expect(
        multipleAccountsRead(
          required(rpc.requests.find(({ method }) => method === "getMultipleAccounts"))
        ).addresses
      ).toEqual([AUTHORITY, SOURCE_TOKEN_ACCOUNT]);
    });
  });

  describe("update plan", () => {
    const effect = planMetadataUpdatedEffect({
      planPda: STEP_ACCOUNT,
      preImage: { createdAt: PLAN_CREATED_AT.toString(), metadataUri: PRE_IMAGE_URI },
      targetMetadataUri: TARGET_URI,
      logContext: { ...LOG_CONTEXT, step: "update_plan" },
    });

    it.each([
      {
        plan: "holds the target URI",
        account: planAccount({
          ...PLAN_PARTIES,
          createdAt: PLAN_CREATED_AT,
          metadataUri: TARGET_URI,
        }),
        state: "landed",
        changedOutside: 0,
      },
      {
        plan: "still holds the pre-image URI",
        account: planAccount({
          ...PLAN_PARTIES,
          createdAt: PLAN_CREATED_AT,
          metadataUri: PRE_IMAGE_URI,
        }),
        state: "unsent",
        changedOutside: 0,
      },
      {
        plan: "holds a URI this attempt never wrote",
        account: planAccount({
          ...PLAN_PARTIES,
          createdAt: PLAN_CREATED_AT,
          metadataUri: "https://example.com/recurring/elsewhere.json",
        }),
        state: "unsent",
        changedOutside: 1,
      },
      {
        plan: "was recreated with the target URI",
        account: planAccount({
          ...PLAN_PARTIES,
          createdAt: PLAN_CREATED_AT + 1n,
          metadataUri: TARGET_URI,
        }),
        state: "unsent",
        changedOutside: 1,
      },
      {
        plan: "is gone",
        account: null,
        state: "unsent",
        changedOutside: 0,
      },
    ] as const)("is $state when the plan $plan", async ({ account, state, changedOutside }) => {
      const errors = spyLogEvents("error");
      answerChain({ blockHeight: 4_000, accountsSlot: TIP_SLOT, accounts: [account] });

      expect((await readUnsavedStep(effect)).state).toBe(state);
      expect(errors("sdp_api_recurring_payment_plan_changed_outside_attempt")).toHaveLength(
        changedOutside
      );
    });
  });

  describe("collection pull", () => {
    const COLLECT_LOG_CONTEXT = {
      recurring_payment_id: "prp_step_reader",
      attempt_id: "psca_step_reader",
      step: "collect",
    } as const satisfies RecurringPaymentStepLogContext;
    const PERIOD_START = 1_770_000_000n;
    const NEXT_PERIOD_START = PERIOD_START + 86_400n;
    const effect = collectionPulledEffect({
      subscriptionPda: STEP_ACCOUNT,
      mint: MINT,
      amount: "25",
      preImage: { periodStartTs: PERIOD_START, amountPulled: 25_000_000n },
      logContext: COLLECT_LOG_CONTEXT,
    });
    const mint = (decimals: number) =>
      tokenMintAccount({ programAddress: TOKEN_PROGRAM_ADDRESS, decimals });
    const delegation = (currentPeriodStartTs: bigint, amountPulledInPeriod: bigint) =>
      subscriptionDelegationAccount({
        expiresAtTs: 0n,
        currentPeriodStartTs,
        amountPulledInPeriod,
      });

    it.each([
      {
        chain: "opened a new period with the amount pulled in it",
        accounts: [delegation(NEXT_PERIOD_START, 25_000_000n), mint(6)],
        state: "landed",
      },
      {
        chain: "opened a new period with less than the amount pulled in it",
        accounts: [delegation(NEXT_PERIOD_START, 24_999_999n), mint(6)],
        state: "dropped",
      },
      {
        chain: "kept the period and grew the pulled amount by the amount",
        accounts: [delegation(PERIOD_START, 50_000_000n), mint(6)],
        state: "landed",
      },
      {
        chain: "kept the period and shows only the earlier pull",
        accounts: [delegation(PERIOD_START, 25_000_000n), mint(6)],
        state: "dropped",
      },
      {
        chain: "kept the period and grew the pulled amount by less than the amount",
        accounts: [delegation(PERIOD_START, 49_999_999n), mint(6)],
        state: "dropped",
      },
      {
        chain: "grew the pulled amount by the amount at six decimals, on a nine-decimal mint",
        accounts: [delegation(PERIOD_START, 50_000_000n), mint(9)],
        state: "dropped",
      },
    ] as const)(
      "reads a saved pull past its expiry as $state when the delegation $chain",
      async ({ accounts, state }) => {
        answerChain({ blockHeight: 4_000, accountsSlot: TIP_SLOT, accounts });

        expect((await readSavedStep({ effect, lastValidBlockHeight: "3990" })).state).toBe(state);
        const accountsRead = rpc.requests.filter(({ method }) => method === "getMultipleAccounts");
        expect(accountsRead.map((request) => multipleAccountsRead(request).addresses)).toEqual([
          [STEP_ACCOUNT, MINT],
        ]);
      }
    );

    it("keeps a saved pull past its expiry pending and logs an error when its delegation is absent", async () => {
      const errors = spyLogEvents("error");
      spyLogEvents("warn");
      answerChain({ blockHeight: 4_000, accountsSlot: TIP_SLOT, accounts: [null, mint(6)] });

      expect(await readSavedStep({ effect, lastValidBlockHeight: "3990" })).toEqual({
        state: "pending",
      });
      expect(errors("sdp_api_recurring_payment_collection_delegation_absent")).toEqual([
        [
          {
            event: "sdp_api_recurring_payment_collection_delegation_absent",
            ...COLLECT_LOG_CONTEXT,
            subscription_pda: STEP_ACCOUNT,
          },
          "sdp_api_recurring_payment_collection_delegation_absent",
        ],
      ]);
    });

    it("keeps a saved pull past its expiry pending when its mint is absent", async () => {
      spyLogEvents("warn");
      answerChain({
        blockHeight: 4_000,
        accountsSlot: TIP_SLOT,
        accounts: [delegation(PERIOD_START, 25_000_000n), null],
      });

      expect(await readSavedStep({ effect, lastValidBlockHeight: "3990" })).toEqual({
        state: "pending",
      });
    });
  });
});

describe("readConfirmedAccounts", () => {
  const rpc = installClusterRpcResponder();

  function answerChain(input: {
    accountsSlot: number;
    accounts: readonly (StubEncodedAccount | null)[];
  }) {
    rpc.respond("getEpochInfo", () => ({
      result: epochInfoResult({ absoluteSlot: TIP_SLOT, blockHeight: 4_000 }),
    }));
    rpc.respond("getMultipleAccounts", () => ({
      result: multipleAccountsResult(input.accountsSlot, input.accounts),
    }));
  }

  function readStepAccount(minContextSlot: bigint | null) {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      readConfirmedAccounts({ addresses: [STEP_ACCOUNT], minContextSlot })
    );
  }

  it.each([
    { floor: "above", minContextSlot: BigInt(TIP_SLOT + 100), bankSlot: TIP_SLOT + 100 },
    { floor: "below", minContextSlot: BigInt(TIP_SLOT - 100), bankSlot: TIP_SLOT },
  ])(
    "asks for a bank at the higher of the epoch read's slot and a minimum $floor it, and reports the epoch read's block height",
    async ({ minContextSlot, bankSlot }) => {
      answerChain({ accountsSlot: bankSlot, accounts: [null] });

      expect(await readStepAccount(minContextSlot)).toEqual({
        blockHeight: 4_000n,
        accounts: [{ address: STEP_ACCOUNT, exists: false }],
      });
      const reads = rpc.requests.filter(({ method }) => method !== "getGenesisHash");
      expect(reads.map(({ method }) => method)).toEqual(["getEpochInfo", "getMultipleAccounts"]);
      expect(multipleAccountsRead(required(reads[1])).minContextSlot).toBe(bankSlot);
    }
  );

  it.each([
    {
      failure: "the bank is above the epoch read's slot but below the minimum",
      minContextSlot: BigInt(TIP_SLOT + 100),
      accountsSlot: TIP_SLOT + 50,
      accounts: [null],
    },
    {
      failure: "the answer lists fewer accounts than were asked for",
      minContextSlot: null,
      accountsSlot: TIP_SLOT,
      accounts: [],
    },
  ])(
    "throws SOLANA_RPC_ERROR when $failure",
    async ({ minContextSlot, accountsSlot, accounts }) => {
      answerChain({ accountsSlot, accounts });

      const read = readStepAccount(minContextSlot);

      await expect(read).rejects.toThrow(AppError);
      await expect(read).rejects.toMatchObject({ code: "SOLANA_RPC_ERROR" });
    }
  );
});
