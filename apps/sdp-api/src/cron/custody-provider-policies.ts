import { checkDueProviderPolicies } from "@/services/custody/provider-policy";
import { alwaysEnabled, defineCron } from "./define-cron";

export const custodyProviderPoliciesCron = defineCron({
  name: "check-custody-provider-policies",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: alwaysEnabled,
  run: checkDueProviderPolicies,
});
