import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  unwrapSimulationError,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { mapPreflightError } from "./sponsorship-submission";

function preflightError(logs: string[] | null): SolanaError {
  return new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
    accounts: null,
    fee: null,
    loadedAccountsDataSize: null,
    loadedAddresses: null,
    logs,
    postBalances: null,
    postTokenBalances: null,
    preBalances: null,
    preTokenBalances: null,
    replacementBlockhash: null,
    returnData: null,
    unitsConsumed: null,
  });
}

describe("mapPreflightError", () => {
  it("returns null for an error that is not a preflight rejection", () => {
    expect(mapPreflightError(new Error("socket hang up"))).toBeNull();
  });

  it("maps a preflight rejection to the last program Error line", () => {
    const logs = [
      "Program log: Error: FirstError",
      "Program log: Error: IncorrectProgramId",
      "Program Tokenz failed: incorrect program id for instruction",
    ];

    expect(mapPreflightError(preflightError(logs))).toMatchObject({
      code: "TRANSACTION_FAILED",
      statusCode: 400,
      message: "Program log: Error: IncorrectProgramId",
      details: { logs },
    });
  });

  it("maps a preflight rejection to the last program failure line", () => {
    const logs = [
      "Program log: Instruction: TransferChecked",
      "Program Tokenz failed: incorrect program id for instruction",
    ];

    expect(mapPreflightError(preflightError(logs))).toMatchObject({
      code: "TRANSACTION_FAILED",
      message: "Program Tokenz failed: incorrect program id for instruction",
      details: { logs },
    });
  });

  it("falls back to the unwrapped cause message without diagnostic lines", () => {
    const logs = ["Program log: Instruction: TransferChecked"];
    const error = preflightError(logs);
    const cause = unwrapSimulationError(error);
    if (!(cause instanceof Error)) {
      throw new Error("expected the preflight rejection to contain an Error cause");
    }

    expect(mapPreflightError(error)).toMatchObject({
      code: "TRANSACTION_FAILED",
      message: cause.message,
      details: { logs },
    });
  });
});
