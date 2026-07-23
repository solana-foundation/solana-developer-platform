import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { mapTransferExecutionError } from "./transfers";

describe("mapTransferExecutionError", () => {
  it("maps a frozen token account program error to ACCOUNT_FROZEN", () => {
    const error = new Error(
      "Failed to sign and send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x11"
    );

    const mapped = mapTransferExecutionError(error);

    expect(mapped.code).toBe("ACCOUNT_FROZEN");
    expect(mapped.statusCode).toBe(400);
  });

  it("falls through to SOLANA_RPC_ERROR for an unrelated custom program error", () => {
    const error = new Error(
      "Failed to sign and send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1"
    );

    const mapped = mapTransferExecutionError(error);

    expect(mapped.code).toBe("SOLANA_RPC_ERROR");
    expect(mapped.statusCode).toBe(502);
  });

  it("passes an existing AppError through unchanged", () => {
    const error = new AppError("TRANSACTION_FAILED", "SPL token transfer failed on-chain");

    const mapped = mapTransferExecutionError(error);

    expect(mapped).toBe(error);
  });

  it("falls through to SOLANA_RPC_ERROR for a non-program-error failure", () => {
    const error = new Error("RPC connection refused");

    const mapped = mapTransferExecutionError(error);

    expect(mapped.code).toBe("SOLANA_RPC_ERROR");
  });
});
