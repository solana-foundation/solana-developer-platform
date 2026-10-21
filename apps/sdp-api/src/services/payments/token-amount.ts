import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { type Address, unwrapOption } from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import {
  type Extension,
  fetchMaybeMint,
  uiAmountToAmountForInterestBearingMintWithoutSimulation,
  uiAmountToAmountForScaledUiAmountMintWithoutSimulation,
} from "@solana-program/token-2022";
import { badRequest } from "@/lib/errors";

/** Converts a payment's UI decimal amount string into the base units its mint moves. */
export type PaymentAmountConverter = (uiAmount: string) => bigint;

type UiAmountExtension = Extract<
  Extension,
  { __kind: "InterestBearingConfig" } | { __kind: "ScaledUiAmountConfig" }
>;

function isUiAmountExtension(extension: Extension): extension is UiAmountExtension {
  return (
    extension.__kind === "InterestBearingConfig" ||
    // biome-ignore lint/security/noSecrets: Token-2022 extension name, not a secret.
    extension.__kind === "ScaledUiAmountConfig"
  );
}

/** Interest-bearing wins over scaled UI amount, the order Kit's own mint dispatch uses. */
function findUiAmountExtension(extensions: readonly Extension[]): UiAmountExtension | null {
  const uiAmountExtensions = extensions.filter(isUiAmountExtension);
  const interestBearing = uiAmountExtensions.find(
    (extension) => extension.__kind === "InterestBearingConfig"
  );
  const selected = interestBearing !== undefined ? interestBearing : uiAmountExtensions.at(0);
  return selected === undefined ? null : selected;
}

/**
 * Reads a mint's decimals and the extension, if any, that rescales its UI amounts.
 * A well-known mint declared on the open scope's cluster answers from the catalogue
 * without an RPC read: `pnpm check:well-known-mints` pins its decimals and that it
 * carries no UI-amount extension. Any other mint is read from the cluster.
 *
 * @param mint - The mint to read.
 * @returns The mint's decimals and its UI-amount extension, or null when it has none.
 */
async function readUiAmountMint(
  mint: Address
): Promise<{ decimals: number; uiAmountExtension: UiAmountExtension | null }> {
  const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  if (wellKnown?.clusters.includes(currentClusterScope().cluster)) {
    return { decimals: wellKnown.decimals, uiAmountExtension: null };
  }
  const mintAccount = await fetchMaybeMint(createClusterRpc(), mint, { commitment: "confirmed" });
  if (!mintAccount.exists) {
    throw badRequest("Token mint account does not exist");
  }
  const extensions = unwrapOption(mintAccount.data.extensions);
  return {
    decimals: mintAccount.data.decimals,
    uiAmountExtension: extensions === null ? null : findUiAmountExtension(extensions),
  };
}

/**
 * Reads a mint's decimals for a flow that fixes a raw amount once and reuses it
 * (recurring payments and subscription plans pin a per-period cap in base units),
 * refusing interest-bearing and scaled-UI-amount mints, whose raw amount for a
 * fixed UI amount drifts with the cluster clock. Token-2022 extensions are fixed
 * at mint initialization, so a mint admitted here stays admissible.
 *
 * @param mint - The mint the flow is denominated in.
 * @returns The mint's decimals.
 */
export async function readStaticAmountMintDecimals(mint: Address): Promise<number> {
  const { decimals, uiAmountExtension } = await readUiAmountMint(mint);
  if (uiAmountExtension !== null) {
    throw badRequest(
      "Recurring payments do not support interest-bearing or scaled UI amount tokens"
    );
  }
  return decimals;
}

/**
 * Reads a mint once and returns the converter every payment path uses to turn its
 * UI amount into base units. A plain SPL Token or Token-2022 mint converts by its
 * decimals alone; a mint with `InterestBearingConfig` or `ScaledUiAmountConfig`
 * reverses the token program's UI scaling as of the cluster clock read here, so
 * `TransferChecked` debits what the caller asked for rather than more. Every
 * conversion validates precision with `parseDecimalAmount` first, so the input
 * grammar and error contract are the same on every mint.
 *
 * The converter is synchronous: callers converting many amounts for one mint
 * load it once and reuse it, and a funding check and the build it precedes
 * must share one instance so both see the same raw amount.
 *
 * @param mint - The mint the amounts are denominated in.
 * @returns A converter from UI decimal strings to base units for that mint.
 */
export async function loadPaymentAmountConverter(mint: Address): Promise<PaymentAmountConverter> {
  const { decimals, uiAmountExtension } = await readUiAmountMint(mint);
  const toStaticBaseUnits: PaymentAmountConverter = (uiAmount) =>
    parseDecimalAmount(uiAmount, decimals);
  if (uiAmountExtension === null) {
    return toStaticBaseUnits;
  }

  const clock = await fetchSysvarClock(createClusterRpc(), { commitment: "confirmed" });
  switch (uiAmountExtension.__kind) {
    case "InterestBearingConfig": {
      const config = uiAmountExtension;
      return (uiAmount) => {
        toStaticBaseUnits(uiAmount);
        return uiAmountToAmountForInterestBearingMintWithoutSimulation(
          uiAmount.trim(),
          decimals,
          Number(clock.unixTimestamp),
          Number(config.lastUpdateTimestamp),
          Number(config.initializationTimestamp),
          config.preUpdateAverageRate,
          config.currentRate
        );
      };
    }
    // biome-ignore lint/security/noSecrets: Token-2022 extension name, not a secret.
    case "ScaledUiAmountConfig": {
      const multiplier =
        clock.unixTimestamp >= uiAmountExtension.newMultiplierEffectiveTimestamp
          ? uiAmountExtension.newMultiplier
          : uiAmountExtension.multiplier;
      return (uiAmount) => {
        toStaticBaseUnits(uiAmount);
        return uiAmountToAmountForScaledUiAmountMintWithoutSimulation(
          uiAmount.trim(),
          decimals,
          multiplier
        );
      };
    }
    default: {
      const exhaustive: never = uiAmountExtension;
      return exhaustive;
    }
  }
}
