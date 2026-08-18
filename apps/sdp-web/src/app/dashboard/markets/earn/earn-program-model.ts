import {
  INITIAL_TREASURY_STATE,
  type StrategyAsset,
  type TreasuryStrategy,
  USDC_MICROS,
} from "../treasury-solutions/treasury-solutions-model";

export const EARN_PROGRAM_STORAGE_KEY = "sdp.markets.earn-program.accepted-buttons.v1";

const EARN_PROGRAM_STORAGE_VERSION = 1;

export type EarnButtonStyle = "ink" | "light" | "accent";
export type EarnPlatformPreview = "ios" | "web";

export interface EarnStrategy {
  id: string;
  name: string;
  asset: StrategyAsset;
  platformPreviews: readonly EarnPlatformPreview[];
  mockDepositMicros: number;
  apyPercent: number;
}

export interface AcceptedEarnButton {
  id: string;
  strategyId: string;
  sequence: number;
  name: string;
  asset: StrategyAsset;
  style: EarnButtonStyle;
  platformPreviews: EarnPlatformPreview[];
  mockDepositMicros: number;
  apyPercent: number;
}

interface EarnStrategySeed {
  strategyId: string;
  platformPreviews: readonly EarnPlatformPreview[];
  mockDepositMicros: number;
}

const EARN_STRATEGY_SEEDS: readonly EarnStrategySeed[] = [
  {
    strategyId: "ethena-pyusd-prime",
    platformPreviews: ["ios", "web"],
    mockDepositMicros: 640_000 * USDC_MICROS,
  },
  {
    strategyId: "sentora-pyusd",
    platformPreviews: ["ios", "web"],
    mockDepositMicros: 220_000 * USDC_MICROS,
  },
  {
    strategyId: "steakhouse-usdg-high-yield",
    platformPreviews: ["ios", "web"],
    mockDepositMicros: 180_000 * USDC_MICROS,
  },
  {
    strategyId: "steakhouse-usdc",
    platformPreviews: ["ios", "web"],
    mockDepositMicros: 800_000 * USDC_MICROS,
  },
  {
    strategyId: "steakhouse-usdc-high-yield",
    platformPreviews: ["ios", "web"],
    mockDepositMicros: 375_000 * USDC_MICROS,
  },
];

function treasuryStrategy(strategyId: string): TreasuryStrategy {
  const strategy = INITIAL_TREASURY_STATE.strategies.find((entry) => entry.id === strategyId);
  if (!strategy) {
    throw new Error(`Earn mock strategy is missing its Treasury source: ${strategyId}`);
  }
  return strategy;
}

/** Earn's mock catalogue, sharing names, assets, and rates with Treasury Solutions. */
export const EARN_STRATEGIES: readonly EarnStrategy[] = EARN_STRATEGY_SEEDS.map((seed) => {
  const strategy = treasuryStrategy(seed.strategyId);
  return {
    id: strategy.id,
    name: strategy.name,
    asset: strategy.asset,
    platformPreviews: seed.platformPreviews,
    mockDepositMicros: seed.mockDepositMicros,
    apyPercent: strategy.apyPercent,
  };
});

function acceptedEarnButtonId(strategyId: string, sequence: number): string {
  return `earn-button-${strategyId}-${sequence}`;
}

function isEarnButtonStyle(value: unknown): value is EarnButtonStyle {
  return value === "ink" || value === "light" || value === "accent";
}

function isStrategyAsset(value: unknown): value is StrategyAsset {
  return value === "PYUSD" || value === "USDG" || value === "USDC";
}

function isEarnPlatformPreview(value: unknown): value is EarnPlatformPreview {
  return value === "ios" || value === "web";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAcceptedEarnButton(value: unknown): value is AcceptedEarnButton {
  if (!isRecord(value)) return false;

  const {
    apyPercent,
    asset,
    id,
    mockDepositMicros,
    name,
    platformPreviews,
    sequence,
    strategyId,
    style,
  } = value;
  if (!isNonEmptyString(strategyId) || !isPositiveSafeInteger(sequence)) return false;
  if (id !== acceptedEarnButtonId(strategyId, sequence)) return false;
  const strategy = EARN_STRATEGIES.find((entry) => entry.id === strategyId);
  if (!strategy) return false;
  if (!isNonEmptyString(name) || !isStrategyAsset(asset) || !isEarnButtonStyle(style)) return false;
  if (
    !Array.isArray(platformPreviews) ||
    platformPreviews.length === 0 ||
    !platformPreviews.every(isEarnPlatformPreview)
  ) {
    return false;
  }
  if (!isPositiveSafeInteger(mockDepositMicros)) return false;
  if (
    name !== strategy.name ||
    asset !== strategy.asset ||
    mockDepositMicros !== strategy.mockDepositMicros ||
    apyPercent !== strategy.apyPercent ||
    platformPreviews.length !== strategy.platformPreviews.length ||
    platformPreviews.some((platform, index) => platform !== strategy.platformPreviews[index])
  ) {
    return false;
  }
  return (
    typeof apyPercent === "number" &&
    Number.isFinite(apyPercent) &&
    apyPercent > 0 &&
    apyPercent <= 100
  );
}

function cloneAcceptedEarnButton(button: AcceptedEarnButton): AcceptedEarnButton {
  return { ...button, platformPreviews: [...button.platformPreviews] };
}

/** Creates the deterministic record persisted when a mock Earn button is accepted. */
export function createAcceptedEarnButton({
  strategyId,
  style,
  sequence = 1,
}: {
  strategyId: string;
  style: EarnButtonStyle;
  sequence?: number;
}): AcceptedEarnButton | null {
  if (!isEarnButtonStyle(style) || !isPositiveSafeInteger(sequence)) return null;
  const strategy = EARN_STRATEGIES.find((entry) => entry.id === strategyId);
  if (!strategy) return null;

  return {
    id: acceptedEarnButtonId(strategy.id, sequence),
    strategyId: strategy.id,
    sequence,
    name: strategy.name,
    asset: strategy.asset,
    style,
    platformPreviews: [...strategy.platformPreviews],
    mockDepositMicros: strategy.mockDepositMicros,
    apyPercent: strategy.apyPercent,
  };
}

/** Encodes accepted mock buttons in a versioned envelope for localStorage. */
export function serializeAcceptedEarnButtons(buttons: readonly AcceptedEarnButton[]): string {
  return JSON.stringify({ version: EARN_PROGRAM_STORAGE_VERSION, buttons });
}

/**
 * Reads localStorage without trusting its shape. Any malformed, unsupported, or
 * internally inconsistent payload falls back to an empty accepted set. Stored
 * strategy snapshots must match the current mock catalogue; change the storage
 * version whenever that catalogue's persisted fields intentionally change.
 */
export function readAcceptedEarnButtons(raw: string | null): AcceptedEarnButton[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed) || parsed.version !== EARN_PROGRAM_STORAGE_VERSION) return [];
  if (!Array.isArray(parsed.buttons) || !parsed.buttons.every(isAcceptedEarnButton)) return [];

  const ids = new Set<string>();
  let totalMicros = 0;
  for (const button of parsed.buttons) {
    if (ids.has(button.id)) return [];
    ids.add(button.id);
    totalMicros += button.mockDepositMicros;
    if (!Number.isSafeInteger(totalMicros)) return [];
  }

  return parsed.buttons.map(cloneAcceptedEarnButton);
}

/** Total mock USDC deposited across every accepted Earn button. */
export function totalEarnDepositsMicros(buttons: readonly AcceptedEarnButton[]): number {
  return buttons.reduce((total, button) => total + button.mockDepositMicros, 0);
}
