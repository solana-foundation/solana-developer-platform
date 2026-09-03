import { describe, expect, it } from "vitest";
import { describeVaultSimulationError } from "./vault-simulation-error";

const walletPays = { kind: "wallet-pays" } as const;
const sponsored = { kind: "sponsored" } as const;
const partnerFeePayer = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const callerProvided = { kind: "caller-provided", feePayer: partnerFeePayer } as const;

describe("describeVaultSimulationError", () => {
  it("tells a wallet-pays customer their wallet has no SOL on AccountNotFound", () => {
    const { message, fault } = describeVaultSimulationError("AccountNotFound", walletPays);
    expect(message).toContain("the wallet holds no SOL");
    expect(message).toContain("network fee");
    // Raw variant keeps the old quoted-JSON form so saved log greps still hit.
    expect(message).toContain('("AccountNotFound")');
    expect(fault).toBe("caller");
  });

  it("blames the sponsor, not the wallet, and marks the fault as SDP's", () => {
    const { message, fault } = describeVaultSimulationError("AccountNotFound", sponsored);
    expect(message).toContain("SDP's fee sponsor holds no SOL");
    expect(message).toContain("not with the wallet");
    expect(message).not.toContain("Send SOL to the wallet");
    expect(fault).toBe("sponsor");
  });

  it("uses neutral fee-payer wording when the fee mode is unknown", () => {
    const { message, fault } = describeVaultSimulationError("AccountNotFound");
    expect(message).toContain("the fee payer holds no SOL");
    expect(fault).toBe("caller");
  });

  it("names the caller-provided fee payer and keeps the fault with the caller", () => {
    const { message, fault } = describeVaultSimulationError("AccountNotFound", callerProvided);
    // The partner's wallet is short, and the prose must say WHICH wallet:
    // "send SOL to the wallet" would misdirect the end user.
    expect(message).toContain(`the provided fee payer (${partnerFeePayer}) holds no SOL`);
    expect(message).toContain("Fund the fee payer and retry.");
    expect(message).not.toContain("Send SOL to the wallet");
    expect(fault).toBe("caller");
  });

  it("maps InsufficientFundsForFee per fee mode", () => {
    const wallet = describeVaultSimulationError("InsufficientFundsForFee", walletPays);
    expect(wallet.message).toContain("the wallet does not hold enough SOL");
    expect(wallet.fault).toBe("caller");
    const sponsor = describeVaultSimulationError("InsufficientFundsForFee", sponsored);
    expect(sponsor.message).toContain("SDP's fee sponsor does not hold enough SOL");
    expect(sponsor.fault).toBe("sponsor");
  });

  it("describes an InstructionError with a custom program code", () => {
    const { message, fault } = describeVaultSimulationError(
      { InstructionError: [1, { Custom: 6001 }] },
      walletPays
    );
    expect(message).toContain("instruction at index 1 was rejected");
    expect(message).toContain("error code 6001");
    expect(message).toContain('{"InstructionError":[1,{"Custom":6001}]}');
    expect(fault).toBe("caller");
  });

  it("describes known InstructionError string variants in plain words", () => {
    const { message } = describeVaultSimulationError(
      { InstructionError: [0, "InsufficientFunds"] },
      walletPays
    );
    expect(message).toContain("an account did not hold enough funds");
  });

  it("does not resolve prototype keys as InstructionError details", () => {
    const { message } = describeVaultSimulationError(
      { InstructionError: [0, "constructor"] },
      walletPays
    );
    expect(message).toContain("it failed with constructor");
  });

  it("phrases unknown string variants as a failure, noun or verb alike", () => {
    const noun = describeVaultSimulationError("AccountInUse", walletPays);
    expect(noun.message).toContain('the transaction failed with "account in use"');
    expect(noun.message).toContain('("AccountInUse")');
    const verb = describeVaultSimulationError("WouldExceedMaxAccountCostLimit", walletPays);
    expect(verb.message).toContain(
      'the transaction failed with "would exceed max account cost limit"'
    );
  });

  it("describes InsufficientFundsForRent with the account index", () => {
    const { message } = describeVaultSimulationError(
      { InsufficientFundsForRent: { account_index: 3 } },
      walletPays
    );
    expect(message).toContain("the account at index 3");
    expect(message).toContain("rent-exempt minimum");
  });

  it("falls back to raw JSON when InsufficientFundsForRent has no usable index", () => {
    expect(describeVaultSimulationError({ InsufficientFundsForRent: {} }, walletPays).message).toBe(
      '{"InsufficientFundsForRent":{}}'
    );
    expect(
      describeVaultSimulationError({ InsufficientFundsForRent: [3] }, walletPays).message
    ).toBe('{"InsufficientFundsForRent":[3]}');
  });

  it("falls back to raw JSON for unrecognized shapes", () => {
    expect(describeVaultSimulationError({ SomethingNew: [1, 2] }, walletPays).message).toBe(
      '{"SomethingNew":[1,2]}'
    );
  });

  it("survives bigints and non-JSON values in the raw variant", () => {
    const { message } = describeVaultSimulationError(
      { InstructionError: [0n, { Custom: 42n }] },
      walletPays
    );
    expect(message).toContain("instruction at index 0 was rejected");
    expect(message).toContain("error code 42");
    expect(describeVaultSimulationError(undefined, walletPays).message).toBe("undefined");
  });

  it("caps the raw payload", () => {
    const { message } = describeVaultSimulationError({ Huge: "x".repeat(5000) }, walletPays);
    expect(message.length).toBeLessThanOrEqual(2000);
  });
});

describe("log-refined instruction failures", () => {
  const custom1 = { InstructionError: [0, { Custom: 1 }] };
  // The exact simulation tail smoky produced for the SOL-less Veda deposit
  // (2026-09-02): the variant alone says only `Custom: 1`.
  const rentLogs = [
    "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1]",
    "Program 11111111111111111111111111111111 invoke [2]",
    "Transfer: insufficient lamports 0, need 1918899",
    "Program 11111111111111111111111111111111 failed: custom program error: 0x1",
    "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL failed: custom program error: 0x1",
  ];

  it("names the rent shortfall and the fix for a wallet-pays caller", () => {
    const { message, fault } = describeVaultSimulationError(custom1, walletPays, rentLogs);
    expect(message).toContain("does not hold enough SOL to create a token account");
    expect(message).toContain("0.001918899 more SOL");
    expect(message).toContain("Send SOL to the wallet and retry.");
    // Raw variant retained so saved log greps still hit.
    expect(message).toContain('{"InstructionError":[0,{"Custom":1}]}');
    expect(fault).toBe("caller");
  });

  it("blames the sponsor for an ATA-create rent shortfall under sponsorship", () => {
    const { message, fault, sponsorCause } = describeVaultSimulationError(
      custom1,
      sponsored,
      rentLogs
    );
    expect(message).toContain("SDP's fee sponsor could not fund the rent");
    expect(message).toContain("not with the wallet");
    expect(message).not.toContain("Send SOL to the wallet");
    expect(fault).toBe("sponsor");
    expect(sponsorCause).toBe("balance");
  });

  // The tail smoky produced AFTER the ATA swap shipped (2026-09-02): the
  // vault program itself creating the depositor's AllowedUser record and
  // charging the zero-SOL SIGNER for it. The sponsor's balance is fine here;
  // the plan failed to pre-fund the wallet. The two must not share a
  // verdict, because "sponsor balance" sends operators refilling a healthy
  // wallet while "retry shortly" promises customers a fix that never comes.
  const programRentLogs = [
    "Program ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J invoke [1]",
    "Program log: Instruction: Deposit",
    "Program 11111111111111111111111111111111 invoke [2]",
    "Transfer: insufficient lamports 0, need 1171605",
    "Program 11111111111111111111111111111111 failed: custom program error: 0x1",
    "Program ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J failed: custom program error: 0x1",
  ];

  it("calls an in-program rent shortfall under sponsorship a missing prefund, not sponsor balance", () => {
    const { message, fault, sponsorCause } = describeVaultSimulationError(
      custom1,
      sponsored,
      programRentLogs
    );
    expect(message).toContain("did not pre-fund the wallet");
    expect(message).toContain("0.001171605 SOL short");
    expect(message).toContain("not the sponsor's balance");
    expect(message).not.toContain("fee sponsor could not fund");
    expect(fault).toBe("sponsor");
    expect(sponsorCause).toBe("prefund");
  });

  // The prefund transfer itself is a TOP-LEVEL System instruction whose
  // source is the SPONSOR. A short sponsor there is a refillable balance
  // problem: labelling it a plan defect would tell operators the plan is
  // broken while the actual fix is the same refill as any broke fee payer.
  it("treats a shortfall in the plan's own prefund transfer as sponsor balance", () => {
    const prefundLogs = [
      "Program 11111111111111111111111111111111 invoke [1]",
      "Transfer: insufficient lamports 500000, need 1287600",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x1",
    ];
    const { message, fault, sponsorCause } = describeVaultSimulationError(
      custom1,
      sponsored,
      prefundLogs
    );
    expect(message).toContain("SDP's fee sponsor could not fund the rent");
    expect(message).not.toContain("did not pre-fund");
    expect(fault).toBe("sponsor");
    expect(sponsorCause).toBe("balance");
  });

  it("tells a wallet-pays caller about the program-created account in its own terms", () => {
    const { message, fault } = describeVaultSimulationError(custom1, walletPays, programRentLogs);
    expect(message).toContain(
      "does not hold enough SOL to fund an account the vault program creates on first use"
    );
    expect(message).toContain("Send SOL to the wallet and retry.");
    expect(fault).toBe("caller");
  });

  it("stays neutral about the created account when no top-level frame is in the logs", () => {
    const truncated = ["Transfer: insufficient lamports 0, need 1171605"];
    const sponsor = describeVaultSimulationError(custom1, sponsored, truncated);
    expect(sponsor.message).toContain("an account this transaction creates");
    expect(sponsor.fault).toBe("sponsor");
    expect(sponsor.sponsorCause).toBe("balance");
    const wallet = describeVaultSimulationError(custom1, walletPays, truncated);
    expect(wallet.message).toContain("an account this transaction");
    expect(wallet.fault).toBe("caller");
  });

  it("tags a sponsored fee-payer failure as a balance cause", () => {
    const { sponsorCause } = describeVaultSimulationError("AccountNotFound", sponsored);
    expect(sponsorCause).toBe("balance");
    const wallet = describeVaultSimulationError("AccountNotFound", walletPays);
    expect(wallet.sponsorCause).toBeUndefined();
  });

  it("uses neutral rent-payer wording when the fee mode is unknown", () => {
    const { message, fault } = describeVaultSimulationError(custom1, undefined, rentLogs);
    expect(message).toContain("the rent payer does not hold enough SOL");
    expect(fault).toBe("caller");
  });

  it("names the caller-provided fee payer for a rent shortfall it funds", () => {
    const { message, fault } = describeVaultSimulationError(custom1, callerProvided, rentLogs);
    expect(message).toContain(`the provided fee payer (${partnerFeePayer})`);
    expect(message).toContain("0.001918899 more");
    expect(message).toContain("Fund the fee payer and retry.");
    expect(fault).toBe("caller");
  });

  it("names a token balance shortfall from the token program's log", () => {
    const { message, fault } = describeVaultSimulationError(custom1, walletPays, [
      "Program log: Error: insufficient funds",
    ]);
    expect(message).toContain("does not hold enough tokens");
    expect(message).toContain("token balance");
    expect(fault).toBe("caller");
  });

  it("falls back to the variant wording when no log signature matches", () => {
    const { message } = describeVaultSimulationError(custom1, walletPays, [
      "Program log: something unrelated",
    ]);
    expect(message).toContain("instruction at index 0 was rejected");
    expect(message).toContain("error code 1");
  });

  it("never refines a transaction-level error from logs", () => {
    const { message } = describeVaultSimulationError("AccountNotFound", walletPays, rentLogs);
    expect(message).toContain("the wallet holds no SOL");
  });

  it("ignores a log claiming a shortfall of zero", () => {
    const { message } = describeVaultSimulationError(custom1, walletPays, [
      "Transfer: insufficient lamports 5, need 5",
    ]);
    expect(message).toContain("instruction at index 0 was rejected");
  });
});
