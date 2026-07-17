import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.TRANSLATION_AGENT_MODEL ?? "openai/gpt-4.1-mini",
  limits: {
    maxInputTokensPerSession: 200_000,
    maxOutputTokensPerSession: 50_000,
  },
});
