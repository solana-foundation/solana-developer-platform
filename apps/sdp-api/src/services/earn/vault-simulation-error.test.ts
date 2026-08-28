import { describe, expect, it } from "vitest";
import { describeVaultSimulationError } from "./vault-simulation-error";

const walletPays = { kind: "wallet-pays" } as const;
const sponsored = { kind: "sponsored" } as const;

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
