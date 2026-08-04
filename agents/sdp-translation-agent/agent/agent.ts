import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.TRANSLATION_AGENT_MODEL ?? "deepseek/deepseek-v4-flash",
  limits: {
    maxInputTokensPerSession: 200_000,
    maxOutputTokensPerSession: 50_000,
  },
});
