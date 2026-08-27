import { describe, expect, it } from "vitest";
import { describeVaultSimulationError } from "./vault-simulation-error";

const walletPays = { kind: "wallet-pays" } as const;
const sponsored = { kind: "sponsored" } as const;

describe("describeVaultSimulationError", () => {
  it("tells a wallet-pays customer their wallet has no SOL on AccountNotFound", () => {
    const described = describeVaultSimulationError("AccountNotFound", walletPays);
    expect(described).toContain("the wallet holds no SOL");
    expect(described).toContain("network fee");
    expect(described).toContain("AccountNotFound");
  });

  it("blames the sponsor, not the wallet, when sponsorship is on", () => {
    const described = describeVaultSimulationError("AccountNotFound", sponsored);
    expect(described).toContain("SDP's fee sponsor");
    expect(described).toContain("not a problem with the wallet");
    expect(described).not.toContain("Send SOL to the wallet");
  });

  it("maps InsufficientFundsForFee per fee mode", () => {
    expect(describeVaultSimulationError("InsufficientFundsForFee", walletPays)).toContain(
      "the wallet does not hold enough SOL"
    );
    expect(describeVaultSimulationError("InsufficientFundsForFee", sponsored)).toContain(
      "SDP's fee sponsor does not hold enough SOL"
    );
  });

  it("describes an InstructionError with a custom program code", () => {
    const described = describeVaultSimulationError(
      { InstructionError: [1, { Custom: 6001 }] },
      walletPays
    );
    expect(described).toContain("instruction 1 was rejected");
    expect(described).toContain("error code 6001");
    expect(described).toContain('{"InstructionError":[1,{"Custom":6001}]}');
  });

  it("describes known InstructionError string variants in plain words", () => {
    const described = describeVaultSimulationError(
      { InstructionError: [0, "InsufficientFunds"] },
      walletPays
    );
    expect(described).toContain("an account did not hold enough funds");
  });

  it("humanizes unknown string variants and keeps the raw value", () => {
    const described = describeVaultSimulationError("WouldExceedMaxAccountCostLimit", walletPays);
    expect(described).toContain("would exceed max account cost limit");
    expect(described).toContain("WouldExceedMaxAccountCostLimit");
  });

  it("describes InsufficientFundsForRent with the account index", () => {
    const described = describeVaultSimulationError(
      { InsufficientFundsForRent: { account_index: 3 } },
      walletPays
    );
    expect(described).toContain("account 3");
    expect(described).toContain("rent-exempt minimum");
  });

  it("falls back to raw JSON for unrecognized shapes", () => {
    expect(describeVaultSimulationError({ SomethingNew: [1, 2] }, walletPays)).toBe(
      '{"SomethingNew":[1,2]}'
    );
  });

  it("survives bigints in the raw variant", () => {
    const described = describeVaultSimulationError(
      { InstructionError: [0n, { Custom: 42n }] },
      walletPays
    );
    expect(described).toContain("instruction 0 was rejected");
    expect(described).toContain("error code 42");
  });
});
