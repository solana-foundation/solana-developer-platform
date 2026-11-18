import { dailyGrowthSummaryEnabled, postDailyGrowthSummary } from "@/services/daily-growth-summary";
import { defineCron } from "./define-cron";

/**
 * The daily #sdp-requests post of the previous UTC day's new organizations and signups. Fires at
 * the top of each hour from 15:00 to 20:00 in the Worker's time zone (UTC on Cloud Run, so 7 or
 * 8 am Pacific onward): the first slot posts, and a later one retries only if that post failed. Global, because organizations and users have no
 * Environment. Off where the requests webhook is not set.
 */
export const slackDailyGrowthCron = defineCron({
  name: "slack-daily-growth",
  schedule: "0 0 15-20 * * *",
  scope: "global",
  effect: "observes",
  enabled: dailyGrowthSummaryEnabled,
  run: async (env) => {
    await postDailyGrowthSummary(env);
  },
});
