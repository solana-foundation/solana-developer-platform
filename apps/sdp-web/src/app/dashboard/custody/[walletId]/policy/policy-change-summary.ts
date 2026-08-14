import type { PolicyDefaultAction, PolicyRule, PolicyRuleAction } from "@sdp/types";
import {
  resolveTokenByMint,
  shortenAddress,
} from "@/app/dashboard/payments/payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "@/app/dashboard/payments/payments-page.data";
import type { useTranslations } from "@/i18n/provider";
import { formatDisplayLabel } from "@/lib/utils";
import {
  PER_TRANSACTION_LIMIT_RULE_ID_PREFIX,
  type PolicyAssetOption,
  type WalletPolicyWritePayload,
} from "./wallet-policy-authoring";
import {
  DEFAULT_ACTION_LABEL_KEYS,
  FAMILY_LABEL_KEYS,
  RULE_ACTION_LABEL_KEYS,
} from "./wallet-policy-flow.shared";

type Translate = ReturnType<typeof useTranslations>;

export interface PolicyChangeRow {
  direction: "added" | "removed" | "result";
  group: string;
  label: string;
  value: string;
}

export interface PolicyChangeGroup {
  label: string;
  rows: PolicyChangeRow[];
}

export interface PolicyFieldLabels {
  defaultAction: string;
  operationControls: string;
  assetOptions: PolicyAssetOption[];
  sdpMintedLabel: string;
  operationLabel: (operation: string) => string;
  actionLabel: (action: PolicyRuleAction) => string;
  defaultActionLabel: (action: PolicyDefaultAction) => string;
}

type PolicyPayload = WalletPolicyWritePayload;

interface PolicyRuleFormatting {
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  sdpMintedLabel: string;
  actionLabel: (action: PolicyRuleAction) => string;
}

const PER_TRANSACTION_LIMIT_GROUP = `rule:${PER_TRANSACTION_LIMIT_RULE_ID_PREFIX}`;

/**
 * Builds the translated field labels and enum formatters the change summary
 * renders with, from the same label-key maps the policy wizard uses.
 *
 * @param t - The translation function.
 * @param assetOptions - Asset symbols and SDP-issued metadata available to the wizard.
 * @returns The labels consumed by {@link summarizePolicyChanges}.
 */
export function buildPolicyFieldLabels(
  t: Translate,
  assetOptions: PolicyAssetOption[]
): PolicyFieldLabels {
  return {
    defaultAction: t("DashboardCustody.policyDefaultAction"),
    operationControls: t("DashboardCustody.policyReviewOperationControls"),
    assetOptions,
    sdpMintedLabel: t("Shared.SharedComponents.sdpMintedToken"),
    operationLabel: (operation) =>
      Object.hasOwn(FAMILY_LABEL_KEYS, operation)
        ? t(FAMILY_LABEL_KEYS[operation as keyof typeof FAMILY_LABEL_KEYS])
        : formatDisplayLabel(operation),
    actionLabel: (action) =>
      Object.hasOwn(RULE_ACTION_LABEL_KEYS, action)
        ? t(RULE_ACTION_LABEL_KEYS[action as keyof typeof RULE_ACTION_LABEL_KEYS])
        : formatDisplayLabel(action),
    defaultActionLabel: (action) =>
      Object.hasOwn(DEFAULT_ACTION_LABEL_KEYS, action)
        ? t(DEFAULT_ACTION_LABEL_KEYS[action as keyof typeof DEFAULT_ACTION_LABEL_KEYS])
        : formatDisplayLabel(action),
  };
}

/**
 * Builds the per-summary token lookup context from the wizard's asset catalogue.
 *
 * @param labels - Translated labels and current asset options.
 * @returns Token lookup maps and the translated SDP-issued marker.
 */
function policyRuleFormatting(labels: PolicyFieldLabels): PolicyRuleFormatting {
  const issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol> = {};
  for (const option of labels.assetOptions) {
    if (!option.sdpIssued) continue;
    issuedTokensByMint[option.mint] = {
      id: null,
      mintAddress: option.mint,
      symbol: option.token,
      imageUrl: option.imageUrl === undefined ? null : option.imageUrl,
    };
  }
  return {
    issuedTokensByMint,
    sdpMintedLabel: labels.sdpMintedLabel,
    actionLabel: labels.actionLabel,
  };
}

/**
 * The list itself when defined, an empty list otherwise.
 *
 * @param values - An optional list field.
 * @returns The list to spread.
 */
function orEmpty<T>(values: T[] | undefined): T[] {
  return values === undefined ? [] : values;
}

/**
 * A one-element list when the value is defined, an empty list otherwise.
 *
 * @param value - An optional scalar field.
 * @returns The list to spread.
 */
function singleton<T>(value: T | undefined): T[] {
  return value === undefined ? [] : [value];
}

/**
 * Appends a value to the list stored under a map key, creating the list on
 * first use.
 *
 * @param map - The map of lists.
 * @param key - The group key.
 * @param value - The value to append.
 */
function pushGrouped<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const group = map.get(key);
  if (group === undefined) {
    map.set(key, [value]);
  } else {
    group.push(value);
  }
}

/**
 * Display label for a rule: its stored human-readable name, its id when it
 * never carried a name, or its kind when it carries neither.
 *
 * @param rule - The rule to label.
 * @returns The label shown on change rows for this rule.
 */
function ruleLabel(rule: PolicyRule): string {
  if (rule.name !== undefined) {
    return rule.name;
  }
  if (rule.id !== undefined) {
    return rule.id;
  }
  return rule.kind;
}

/**
 * Identity key for matching a rule across the before/after payloads: the
 * rule's kind plus id, or its full serialized shape for rules without an id.
 * Kind is part of the identity so a rule resubmitted under the same id with
 * a different kind reads as one removal plus one addition, never as an item
 * diff that hides the type change.
 *
 * @param rule - The rule to key.
 * @returns The matching key.
 */
function ruleKey(rule: PolicyRule): string {
  return rule.id === undefined ? JSON.stringify(rule) : `${rule.kind}:${rule.id}`;
}

/**
 * Identifies wizard-authored per-asset transfer-cap rules.
 *
 * @param rule - The policy rule to inspect.
 * @returns Whether the rule belongs in the shared per-transaction group.
 */
function isPerTransactionLimitRule(
  rule: PolicyRule
): rule is Extract<PolicyRule, { kind: "amount" }> {
  return (
    rule.kind === "amount" &&
    rule.id !== undefined &&
    rule.id.startsWith(PER_TRANSACTION_LIMIT_RULE_ID_PREFIX)
  );
}

/**
 * Chooses the display group for a rule without changing its matching identity.
 *
 * @param key - The rule's before/after matching key.
 * @param rule - The policy rule being displayed.
 * @returns The shared limit group or the rule's existing individual group.
 */
function ruleGroup(key: string, rule: PolicyRule): string {
  return isPerTransactionLimitRule(rule) ? PER_TRANSACTION_LIMIT_GROUP : `rule:${key}`;
}

/**
 * Mint display via the shared token resolver: well-known token symbol when
 * registered, shortened address otherwise.
 *
 * @param mint - The mint address.
 * @param formatting - Current asset catalogue and translated issued marker.
 * @returns The human-readable token reference.
 */
function formatAsset(mint: string, formatting: PolicyRuleFormatting): string {
  const tokenName = resolveTokenByMint(mint, formatting.issuedTokensByMint).tokenName;
  return Object.hasOwn(formatting.issuedTokensByMint, mint)
    ? `${tokenName} (${formatting.sdpMintedLabel})`
    : tokenName;
}

/**
 * The list-shaped contents of a rule, formatted for display: assets as token
 * symbols, destinations as shortened addresses, operation families and types
 * as their raw identifiers.
 *
 * @param rule - The rule to unpack.
 * @param formatting - Current asset catalogue and translated issued marker.
 * @returns The rule's items in display form.
 */
function ruleItems(rule: PolicyRule, formatting: PolicyRuleFormatting): string[] {
  switch (rule.kind) {
    case "operation_family":
      return [...orEmpty(rule.families), ...singleton(rule.family)];
    case "operation_type":
      return [...orEmpty(rule.operationTypes), ...singleton(rule.operationType)];
    case "asset":
    case "amount":
      return [...orEmpty(rule.assets), ...singleton(rule.asset)].map((mint) =>
        formatAsset(mint, formatting)
      );
    case "destination":
      return [
        ...orEmpty(rule.allowlist),
        ...orEmpty(rule.blocklist),
        ...orEmpty(rule.destinations),
        ...singleton(rule.destination),
      ].map(shortenAddress);
    case "approval":
      return [
        ...orEmpty(rule.families),
        ...orEmpty(rule.operationTypes),
        ...orEmpty(rule.assets).map((mint) => formatAsset(mint, formatting)),
      ];
    case "always":
      return [];
    default: {
      const exhausted: never = rule;
      throw new Error(`Unhandled rule kind: ${JSON.stringify(exhausted)}`);
    }
  }
}

/**
 * Per-operation action assignments declared by the payload's operation family
 * and operation type rules. Every action assigned to an operation is kept, so
 * conflicting rules over the same operation are all reported rather than
 * last-writer-wins.
 *
 * @param rules - The payload's rules.
 * @param formatting - Current asset catalogue and translated issued marker.
 * @returns The operation → actions map.
 */
function operationAssignments(
  rules: PolicyRule[],
  formatting: PolicyRuleFormatting
): Map<string, Set<PolicyRuleAction>> {
  const assignments = new Map<string, Set<PolicyRuleAction>>();
  for (const rule of rules) {
    if (rule.action === undefined) {
      continue;
    }
    if (rule.kind !== "operation_family" && rule.kind !== "operation_type") {
      continue;
    }
    for (const operation of ruleItems(rule, formatting)) {
      const actions = assignments.get(operation);
      if (actions === undefined) {
        assignments.set(operation, new Set([rule.action]));
      } else {
        actions.add(rule.action);
      }
    }
  }
  return assignments;
}

/**
 * The scalar facts of a rule (action, amount bounds, approval group) as one
 * comparable display string.
 *
 * @param rule - The rule to summarize.
 * @param formatting - Translated action labels for display.
 * @returns The scalar summary, empty when the rule has no scalar facts.
 */
function ruleScalarSummary(rule: PolicyRule, formatting: PolicyRuleFormatting): string {
  const parts: string[] = [];
  if (rule.action !== undefined) {
    parts.push(formatting.actionLabel(rule.action));
  }
  if (rule.kind === "amount") {
    if (rule.min !== undefined) {
      parts.push(`min ${rule.min}`);
    }
    if (rule.max !== undefined) {
      parts.push(`max ${rule.max}`);
    }
  }
  if (rule.kind === "approval" && rule.approvalGroupId !== undefined) {
    parts.push(rule.approvalGroupId);
  }
  return parts.join(", ");
}

/**
 * Everything a rule declares — items plus scalar facts — as one display
 * string, used when a whole rule is added or removed.
 *
 * @param rule - The rule to describe.
 * @param formatting - Current asset catalogue and translated issued marker.
 * @returns The full display summary.
 */
function ruleSummary(rule: PolicyRule, formatting: PolicyRuleFormatting): string {
  const items = ruleItems(rule, formatting).join(", ");
  const scalar = ruleScalarSummary(rule, formatting);
  return [items, scalar].filter((part) => part !== "").join(" · ");
}

/**
 * Emits removed/added rows for one scalar field when its value changed.
 *
 * @param rows - The row list to append to.
 * @param group - The stable group key for the field.
 * @param label - The field's display label.
 * @param before - The old value, when set.
 * @param after - The new value, when set.
 */
function pushScalarChange(
  rows: PolicyChangeRow[],
  group: string,
  label: string,
  before: string | undefined,
  after: string | undefined
): void {
  if (before === after) {
    return;
  }
  if (before !== undefined) {
    rows.push({ direction: "removed", group, label, value: before });
  }
  if (after !== undefined) {
    rows.push({ direction: "added", group, label, value: after });
  }
}

/**
 * Emits rows for operation-control action transitions, batching operations
 * that share the same removed or added action into one row each.
 *
 * @param rows - The row list to append to.
 * @param before - The currently active policy payload.
 * @param after - The payload about to be activated.
 * @param labels - Translated display labels.
 * @param formatting - Current asset catalogue and translated issued marker.
 */
function pushOperationChanges(
  rows: PolicyChangeRow[],
  before: PolicyPayload,
  after: PolicyPayload,
  labels: PolicyFieldLabels,
  formatting: PolicyRuleFormatting
): void {
  const beforeOperations = operationAssignments(before.rules, formatting);
  const afterOperations = operationAssignments(after.rules, formatting);
  const removedByAction = new Map<PolicyRuleAction, string[]>();
  const addedByAction = new Map<PolicyRuleAction, string[]>();
  for (const operation of new Set([...beforeOperations.keys(), ...afterOperations.keys()])) {
    const beforeActions = beforeOperations.get(operation);
    const afterActions = afterOperations.get(operation);
    for (const action of beforeActions === undefined ? [] : beforeActions) {
      if (afterActions === undefined || !afterActions.has(action)) {
        pushGrouped(removedByAction, action, operation);
      }
    }
    for (const action of afterActions === undefined ? [] : afterActions) {
      if (beforeActions === undefined || !beforeActions.has(action)) {
        pushGrouped(addedByAction, action, operation);
      }
    }
  }
  for (const [action, operations] of removedByAction) {
    rows.push({
      direction: "removed",
      group: "operations",
      label: labels.operationControls,
      value: `${operations.map(labels.operationLabel).join(", ")} · ${labels.actionLabel(action)}`,
    });
  }
  for (const [action, operations] of addedByAction) {
    rows.push({
      direction: "added",
      group: "operations",
      label: labels.operationControls,
      value: `${operations.map(labels.operationLabel).join(", ")} · ${labels.actionLabel(action)}`,
    });
  }
}

/**
 * Emits one whole-rule removal and its empty result when the rule does not
 * belong to the shared per-transaction group.
 *
 * @param rows - The row list to append to.
 * @param key - The rule's before/after matching key.
 * @param rule - The removed policy rule.
 * @param formatting - Current asset catalogue and translated issued marker.
 * @returns The removed limit group's label, or nothing for another rule kind.
 */
function pushRemovedRule(
  rows: PolicyChangeRow[],
  key: string,
  rule: PolicyRule,
  formatting: PolicyRuleFormatting
): string | undefined {
  const group = ruleGroup(key, rule);
  const label = ruleLabel(rule);
  rows.push({ direction: "removed", group, label, value: ruleSummary(rule, formatting) });
  if (isPerTransactionLimitRule(rule)) return label;
  rows.push({ direction: "result", group, label, value: "" });
  return undefined;
}

/**
 * Emits rows for non-operation rule changes: whole-rule additions and
 * removals, per-item membership changes, and scalar-fact changes, matching
 * rules across payloads by id.
 *
 * @param rows - The row list to append to.
 * @param before - The currently active policy payload.
 * @param after - The payload about to be activated.
 * @param formatting - Current asset catalogue and translated issued marker.
 */
function pushRuleChanges(
  rows: PolicyChangeRow[],
  before: PolicyPayload,
  after: PolicyPayload,
  formatting: PolicyRuleFormatting
): void {
  const isOperationRule = (rule: PolicyRule) =>
    rule.kind === "operation_family" || rule.kind === "operation_type";
  const beforeRules = new Map(
    before.rules.filter((rule) => !isOperationRule(rule)).map((rule) => [ruleKey(rule), rule])
  );
  const afterRules = new Map(
    after.rules.filter((rule) => !isOperationRule(rule)).map((rule) => [ruleKey(rule), rule])
  );
  const hasAfterPerTransactionLimits = [...afterRules.values()].some(isPerTransactionLimitRule);
  let removedPerTransactionLimitLabel: string | undefined;

  for (const [key, rule] of beforeRules) {
    if (afterRules.has(key)) {
      continue;
    }
    const removedLimitLabel = pushRemovedRule(rows, key, rule, formatting);
    if (removedPerTransactionLimitLabel === undefined && removedLimitLabel !== undefined) {
      removedPerTransactionLimitLabel = removedLimitLabel;
    }
  }

  for (const [key, rule] of afterRules) {
    if (beforeRules.has(key)) {
      continue;
    }
    rows.push({
      direction: "added",
      group: ruleGroup(key, rule),
      label: ruleLabel(rule),
      value: ruleSummary(rule, formatting),
    });
  }

  for (const [key, beforeRule] of beforeRules) {
    const afterRule = afterRules.get(key);
    if (afterRule === undefined) {
      continue;
    }
    const group = ruleGroup(key, afterRule);
    const label = ruleLabel(afterRule);
    if (isPerTransactionLimitRule(beforeRule) && isPerTransactionLimitRule(afterRule)) {
      pushScalarChange(
        rows,
        group,
        label,
        ruleSummary(beforeRule, formatting),
        ruleSummary(afterRule, formatting)
      );
      continue;
    }
    const beforeItems = ruleItems(beforeRule, formatting);
    const afterItems = ruleItems(afterRule, formatting);
    const removedItems = beforeItems.filter((item) => !afterItems.includes(item));
    const addedItems = afterItems.filter((item) => !beforeItems.includes(item));
    if (removedItems.length > 0) {
      rows.push({ direction: "removed", group, label, value: removedItems.join(", ") });
    }
    if (addedItems.length > 0) {
      rows.push({ direction: "added", group, label, value: addedItems.join(", ") });
    }
    if (removedItems.length > 0 && afterItems.length === 0) {
      rows.push({ direction: "result", group, label, value: "" });
    }
    const beforeScalar = ruleScalarSummary(beforeRule, formatting);
    const afterScalar = ruleScalarSummary(afterRule, formatting);
    pushScalarChange(
      rows,
      group,
      label,
      beforeScalar === "" ? undefined : beforeScalar,
      afterScalar === "" ? undefined : afterScalar
    );
  }

  if (removedPerTransactionLimitLabel !== undefined && !hasAfterPerTransactionLimits) {
    rows.push({
      direction: "result",
      group: PER_TRANSACTION_LIMIT_GROUP,
      label: removedPerTransactionLimitLabel,
      value: "",
    });
  }
}

/**
 * Semantic change summary between the active policy payload and the payload
 * about to be activated: one row per meaningful change — removed values,
 * added values, and a neutral "result" row when a list ends up empty. Rules
 * are matched by id, and each row carries a stable `group` key so display
 * grouping never collides on user-supplied rule names.
 *
 * @param before - The currently active policy payload.
 * @param after - The payload about to be activated.
 * @param labels - Translated display labels, from {@link buildPolicyFieldLabels}.
 * @returns The change rows in display order.
 */
export function summarizePolicyChanges(
  before: PolicyPayload,
  after: PolicyPayload,
  labels: PolicyFieldLabels
): PolicyChangeRow[] {
  const rows: PolicyChangeRow[] = [];
  const formatting = policyRuleFormatting(labels);
  pushScalarChange(
    rows,
    "defaultAction",
    labels.defaultAction,
    labels.defaultActionLabel(before.defaultAction),
    labels.defaultActionLabel(after.defaultAction)
  );
  pushOperationChanges(rows, before, after, labels, formatting);
  pushRuleChanges(rows, before, after, formatting);
  return rows;
}

/**
 * Groups change rows for display by their stable group key, preserving row
 * order, with each group titled by its rows' shared label.
 *
 * @param rows - The rows from {@link summarizePolicyChanges}.
 * @returns The display groups in first-appearance order.
 */
export function groupPolicyChanges(rows: PolicyChangeRow[]): PolicyChangeGroup[] {
  const byGroup = new Map<string, PolicyChangeRow[]>();
  for (const row of rows) {
    pushGrouped(byGroup, row.group, row);
  }
  return [...byGroup.values()].map((groupRows) => ({
    label: groupRows[0].label,
    rows: groupRows,
  }));
}
