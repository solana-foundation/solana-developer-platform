import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { preflightFailure } from "./preflight-failure";

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

describe("preflightFailure", () => {
  it("returns null for an error that is not a preflight rejection", () => {
    expect(preflightFailure(new Error("socket hang up"), "DvP funding")).toBeNull();
  });

  it("maps a preflight rejection to the last program Error line", () => {
    const logs = [
      "Program log: Error: FirstError",
      "Program log: Error: IncorrectProgramId",
      "Program Tokenz failed: incorrect program id for instruction",
    ];
    const error = preflightError(logs);

    expect(preflightFailure(error, "DvP funding")).toMatchObject({
      code: "TRANSACTION_FAILED",
      statusCode: 400,
      message: "DvP funding was rejected in simulation: Program log: Error: IncorrectProgramId",
      details: { logs },
    });
  });

  it("falls back to the Solana error message without diagnostic lines", () => {
    const error = preflightError(["Program log: Instruction: TransferChecked"]);

    expect(preflightFailure(error, "DvP funding")).toMatchObject({
      code: "TRANSACTION_FAILED",
      message: `DvP funding was rejected in simulation: ${error.message}`,
    });
  });
});
