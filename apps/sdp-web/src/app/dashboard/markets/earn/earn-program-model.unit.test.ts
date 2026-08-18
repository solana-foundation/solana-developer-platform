import { describe, expect, it } from "vitest";
import {
  type AcceptedEarnButton,
  createAcceptedEarnButton,
  EARN_PROGRAM_STORAGE_KEY,
  EARN_STRATEGIES,
  readAcceptedEarnButtons,
  serializeAcceptedEarnButtons,
  totalEarnDepositsMicros,
} from "./earn-program-model";

function acceptedButton(strategyId = "ethena-pyusd-prime", sequence = 1): AcceptedEarnButton {
  const button = createAcceptedEarnButton({ strategyId, style: "ink", sequence });
  if (!button) throw new Error(`Expected ${strategyId} to produce an accepted Earn button`);
  return button;
}

function stored(buttons: unknown): string {
  const currentEnvelope = JSON.parse(serializeAcceptedEarnButtons([])) as Record<string, unknown>;
  return JSON.stringify({ ...currentEnvelope, buttons });
}

describe("EARN_STRATEGIES", () => {
  it("pins the persisted mock catalogue for storage version one", () => {
    expect(new Set(EARN_STRATEGIES.map((strategy) => strategy.id)).size).toBe(
      EARN_STRATEGIES.length
    );
    expect(EARN_STRATEGIES).toEqual([
      {
        id: "ethena-pyusd-prime",
        name: "Ethena PYUSD Prime",
        asset: "PYUSD",
        platformPreviews: ["ios", "web"],
        mockDepositMicros: 640_000_000_000,
        apyPercent: 8.6,
      },
      {
        id: "sentora-pyusd",
        name: "Sentora PYUSD",
        asset: "PYUSD",
        platformPreviews: ["ios", "web"],
        mockDepositMicros: 220_000_000_000,
        apyPercent: 7.4,
      },
      {
        id: "steakhouse-usdg-high-yield",
        name: "Steakhouse USDG High Yield",
        asset: "USDG",
        platformPreviews: ["ios", "web"],
        mockDepositMicros: 180_000_000_000,
        apyPercent: 8.1,
      },
      {
        id: "steakhouse-usdc",
        name: "Steakhouse USDC",
        asset: "USDC",
        platformPreviews: ["ios", "web"],
        mockDepositMicros: 800_000_000_000,
        apyPercent: 4.8,
      },
      {
        id: "steakhouse-usdc-high-yield",
        name: "Steakhouse USDC High Yield",
        asset: "USDC",
        platformPreviews: ["ios", "web"],
        mockDepositMicros: 375_000_000_000,
        apyPercent: 6.7,
      },
    ]);
  });
});

describe("createAcceptedEarnButton", () => {
  it("snapshots the selected strategy and style under a deterministic id", () => {
    const strategy = EARN_STRATEGIES.find((entry) => entry.id === "sentora-pyusd");
    if (!strategy) throw new Error("Expected Sentora to exist in the Earn mock catalogue");
    const button = createAcceptedEarnButton({
      strategyId: "sentora-pyusd",
      style: "accent",
      sequence: 3,
    });
    if (!button) throw new Error("Expected Sentora to produce an accepted Earn button");

    expect(button).toEqual({
      id: "earn-button-sentora-pyusd-3",
      strategyId: "sentora-pyusd",
      sequence: 3,
      name: strategy.name,
      asset: strategy.asset,
      style: "accent",
      platformPreviews: strategy.platformPreviews,
      mockDepositMicros: strategy.mockDepositMicros,
      apyPercent: strategy.apyPercent,
    });
    expect(button.platformPreviews).not.toBe(strategy.platformPreviews);
  });

  it("defaults the sequence to one and returns the same stable id on replay", () => {
    const input = { strategyId: "steakhouse-usdc", style: "light" } as const;
    const first = createAcceptedEarnButton(input);
    const replay = createAcceptedEarnButton(input);

    expect(first?.id).toBe("earn-button-steakhouse-usdc-1");
    expect(replay).toEqual(first);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid sequence %s", (sequence) => {
    expect(
      createAcceptedEarnButton({
        strategyId: "ethena-pyusd-prime",
        style: "ink",
        sequence,
      })
    ).toBeNull();
  });

  it("rejects an unknown strategy", () => {
    expect(createAcceptedEarnButton({ strategyId: "missing", style: "ink" })).toBeNull();
  });
});

describe("Earn Program localStorage helpers", () => {
  it("uses a versioned storage key", () => {
    expect(EARN_PROGRAM_STORAGE_KEY).toBe("sdp.markets.earn-program.accepted-buttons.v1");
  });

  it("round-trips accepted buttons without sharing preview arrays", () => {
    const buttons = [acceptedButton(), acceptedButton("steakhouse-usdc-high-yield", 2)];
    const read = readAcceptedEarnButtons(serializeAcceptedEarnButtons(buttons));

    expect(read).toEqual(buttons);
    expect(read[0]?.platformPreviews).not.toBe(buttons[0]?.platformPreviews);
  });

  it.each([null, "", "   ", "{", "null", "[]", "{}", '{"version":2,"buttons":[]}'])(
    "falls back to no accepted buttons for invalid storage %j",
    (raw) => {
      expect(readAcceptedEarnButtons(raw)).toEqual([]);
    }
  );

  it.each<[string, (button: AcceptedEarnButton) => unknown]>([
    ["mismatched stable id", (button) => ({ ...button, id: "tampered" })],
    [
      "unknown strategy",
      (button) => ({
        ...button,
        id: "earn-button-missing-1",
        strategyId: "missing",
      }),
    ],
    ["unsupported style", (button) => ({ ...button, style: "neon" })],
    ["unsupported asset", (button) => ({ ...button, asset: "BTC" })],
    ["unsupported platform preview", (button) => ({ ...button, platformPreviews: ["desktop"] })],
    ["fractional deposit micros", (button) => ({ ...button, mockDepositMicros: 1.5 })],
    ["non-positive APY", (button) => ({ ...button, apyPercent: 0 })],
    ["out-of-range APY", (button) => ({ ...button, apyPercent: 101 })],
  ])("rejects a record with %s", (_label, corrupt) => {
    expect(readAcceptedEarnButtons(stored([corrupt(acceptedButton())]))).toEqual([]);
  });

  it.each<[string, (button: AcceptedEarnButton) => unknown]>([
    ["another strategy name", (button) => ({ ...button, name: "Steakhouse USDC" })],
    ["another supported asset", (button) => ({ ...button, asset: "USDC" })],
    ["a partial supported preview set", (button) => ({ ...button, platformPreviews: ["ios"] })],
    ["another positive deposit", (button) => ({ ...button, mockDepositMicros: 1 })],
    ["another valid APY", (button) => ({ ...button, apyPercent: 5 })],
  ])("rejects canonical strategy metadata replaced by %s", (_label, corrupt) => {
    expect(readAcceptedEarnButtons(stored([corrupt(acceptedButton())]))).toEqual([]);
  });

  it("uses an all-or-empty fallback for duplicate or partly invalid records", () => {
    const valid = acceptedButton();
    expect(readAcceptedEarnButtons(stored([valid, valid]))).toEqual([]);
    expect(readAcceptedEarnButtons(stored([valid, { ...valid, id: "tampered" }]))).toEqual([]);
  });
});

describe("totalEarnDepositsMicros", () => {
  it("derives the combined mock deposits from accepted buttons", () => {
    const buttons = [acceptedButton(), acceptedButton("sentora-pyusd", 2)];
    expect(totalEarnDepositsMicros(buttons)).toBe(860_000_000_000);
  });

  it("returns zero for an empty accepted set", () => {
    expect(totalEarnDepositsMicros([])).toBe(0);
  });
});
