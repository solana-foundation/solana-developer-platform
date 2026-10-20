import { cmpDecimalFixedPoint, decimalFixedPoint } from "@solana/fixed-points";
import type { FireblocksAddressEntry } from "./fireblocks-address-book";
import type { FireblocksPolicyRule } from "./fireblocks-policy";

type Match = true | false | "unknown";
type Obj = Record<string, unknown>;
function obj(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}
function and(values: Match[]): Match {
  return values.includes(false) ? false : values.includes("unknown") ? "unknown" : true;
}
function or(values: Match[]): Match {
  return values.includes(true) ? true : values.includes("unknown") ? "unknown" : false;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}
function wildcard(value: unknown) {
  return value === "*" || value === "ANY";
}
function unsupported(value: Obj, keys: string[]) {
  return Object.keys(value).some((key) => !keys.includes(key) && value[key] != null);
}
export interface FireblocksPolicyTransfer {
  initiatorId: string;
  vaultId: string;
  assetId: string;
  amount: string;
  destination: FireblocksAddressEntry | null;
}
function initiatorMatch(value: unknown, id: string): Match {
  if (typeof value === "string") return wildcard(value) || value === id;
  const config = obj(value);
  if (
    !config ||
    unsupported(config, ["operator", "users", "groups"]) ||
    (config.operator && config.operator !== "INCLUDES")
  )
    return "unknown";
  if (config.users !== undefined && !strings(config.users)) return "unknown";
  if (config.groups !== undefined && !strings(config.groups)) return "unknown";
  const userMatch = strings(config.users)
    ? config.users.some((user) => wildcard(user) || user === id)
    : false;
  return userMatch || (Array.isArray(config.groups) && config.groups.length ? "unknown" : false);
}
function accountMatch(value: unknown, id: string | null, type: string, subtype?: string): Match {
  const config = obj(value);
  if (
    config?.operator !== "INCLUDES" ||
    unsupported(config, ["operator", "type", "ids", "subType", "addressType"])
  )
    return "unknown";
  // The API schema does not specify how mixed selectors combine. Do not widen them.
  const dimensions = ["type", "ids", "subType"].filter(
    (key) => Array.isArray(config[key]) && (config[key] as unknown[]).length > 0
  );
  if (dimensions.length !== 1 || (config.type !== undefined && !strings(config.type)))
    return "unknown";
  const checks: Match[] = [];
  if (strings(config.type) && config.type.length)
    checks.push(config.type.some((t) => wildcard(t) || t === type || t === subtype));
  for (const key of ["ids", "subType"]) {
    if (config[key] === undefined) continue;
    if (!Array.isArray(config[key])) return "unknown";
    for (const item of config[key] as unknown[]) {
      const account = obj(item);
      if (!account || unsupported(account, ["id", "type", "subType"])) {
        checks.push("unknown");
        continue;
      }
      checks.push(
        (account.id === undefined || wildcard(account.id) || account.id === id) &&
          (account.type === undefined ||
            wildcard(account.type) ||
            account.type === type ||
            account.type === subtype) &&
          (account.subType === undefined ||
            wildcard(account.subType) ||
            account.subType === subtype)
      );
    }
  }
  return checks.length ? or(checks) : "unknown";
}
function assetMatch(value: unknown, id: string): Match {
  const config = obj(value);
  if (
    config?.nftTransfer !== false ||
    unsupported(config, ["nftTransfer", "assetTypes", "operator"]) ||
    (config.operator && config.operator !== "INCLUDES") ||
    !strings(config.assetTypes)
  )
    return "unknown";
  return config.assetTypes.some((asset) => wildcard(asset) || asset === "FUNGIBLE" || asset === id);
}
function compare(a: string, b: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(a) || !/^\d+(\.\d+)?$/.test(b) || a.length > 100 || b.length > 100)
    return null;
  try {
    const scale = Math.max(a.split(".")[1]?.length ?? 0, b.split(".")[1]?.length ?? 0);
    const amount = decimalFixedPoint("unsigned", 256, scale);
    return cmpDecimalFixedPoint(amount(a), amount(b));
  } catch {
    return null;
  }
}
function amountMatch(value: unknown, amount: string): Match {
  if (value === undefined) return true;
  const config = obj(value);
  const range = obj(config?.range);
  if (
    !config ||
    !range ||
    unsupported(config, ["currency", "range"]) ||
    unsupported(range, ["min", "max"]) ||
    typeof range.min !== "string"
  )
    return "unknown";
  if (config.currency !== undefined && !["USD", "EUR", "NATIVE"].includes(String(config.currency)))
    return "unknown";
  if (compare(range.min, "0") === 0 && range.max === undefined) return true;
  // Fiat conversion and AOT quotas must be evaluated by Fireblocks; never guess a match.
  if (config.currency !== "NATIVE" || !amount) return "unknown";
  const min = compare(amount, range.min);
  const max =
    range.max === undefined
      ? -1
      : typeof range.max === "string"
        ? compare(amount, range.max)
        : null;
  return min === null || max === null ? "unknown" : min >= 0 && max <= 0;
}
export function matchFireblocksTransferRule(
  rule: FireblocksPolicyRule,
  transfer: FireblocksPolicyTransfer
): Match {
  if (rule.type !== "TRANSFER") return "unknown";
  if (rule.subType !== undefined && rule.subType !== "TRANSFER") return "unknown";
  const dest = obj(rule.destination);
  const addressType = transfer.destination ? "WHITELISTED" : "ONE_TIME";
  const type = transfer.destination ? "UNMANAGED" : "ONE_TIME_ADDRESS";
  const subtype =
    transfer.destination?.walletType === "INTERNAL_WALLET"
      ? "INTERNAL"
      : transfer.destination
        ? "EXTERNAL"
        : undefined;
  const condition = and([
    initiatorMatch(rule.initiator, transfer.initiatorId),
    accountMatch(rule.source, transfer.vaultId, "VAULT"),
    assetMatch(rule.asset, transfer.assetId),
    !dest ? "unknown" : wildcard(dest.addressType) || dest.addressType === addressType,
    accountMatch(rule.destination, transfer.destination?.walletId ?? null, type, subtype),
    amountMatch(rule.amount, transfer.amount),
  ]);
  if (condition === false) return false;
  if (
    rule.policyEngineVersion !== "v2" ||
    rule.amountOverTime != null ||
    unsupported(rule, [
      "id",
      "name",
      "index",
      "policyEngineVersion",
      "type",
      "subType",
      "initiator",
      "source",
      "destination",
      "asset",
      "amount",
      "verdict",
      "externalDescriptor",
      "isGlobalPolicy",
    ]) ||
    rule.isGlobalPolicy === true
  )
    return "unknown";
  return condition;
}
export function evaluateFireblocksTransferPolicy(
  rules: FireblocksPolicyRule[],
  transfer: FireblocksPolicyTransfer
) {
  // Returned order is meaningful. If explicit indices disagree, do not infer precedence.
  const indices = rules.map((r) => r.index);
  if (
    indices.some(
      (x, i) =>
        typeof x === "number" &&
        i > 0 &&
        typeof indices[i - 1] === "number" &&
        x <= (indices[i - 1] as number)
    )
  )
    return { state: "unknown" as const };
  for (const rule of rules) {
    const match = matchFireblocksTransferRule(rule, transfer);
    if (match === false) continue;
    const ruleName = typeof rule.name === "string" ? rule.name : undefined;
    if (match === "unknown") return { state: "unknown" as const, ruleName };
    const verdict = obj(rule.verdict);
    if (verdict?.action === "BLOCK")
      return { state: "blocked" as const, ruleName, ruleId: rule.id };
    if (verdict?.action === "ALLOW" || verdict?.action === "2-TIER")
      return { state: "covered" as const, ruleName };
    return { state: "unknown" as const, ruleName };
  }
  return { state: "missing" as const };
}
