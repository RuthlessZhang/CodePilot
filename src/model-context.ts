export type ProviderName = "openai" | "anthropic" | "deepseek";

export type ModelContextProfile = {
  contextWindowTokens: number;
  modelMaxOutputTokens: number;
  source: "model" | "provider-fallback";
};

const fallbackProfiles: Record<ProviderName, Omit<ModelContextProfile, "source">> = {
  openai: { contextWindowTokens: 128_000, modelMaxOutputTokens: 16_384 },
  anthropic: { contextWindowTokens: 200_000, modelMaxOutputTokens: 64_000 },
  deepseek: { contextWindowTokens: 128_000, modelMaxOutputTokens: 8_192 },
};

/** Conservative local profiles. Explicit project configuration always wins. */
export function resolveModelContextProfile(provider: ProviderName, model: string): ModelContextProfile {
  const normalized = model.toLowerCase();
  if (provider === "openai" && /^gpt-4\.1(?:-|$)/.test(normalized)) {
    return { contextWindowTokens: 1_047_576, modelMaxOutputTokens: 32_768, source: "model" };
  }
  if (provider === "anthropic") {
    if (/^claude-(?:fable|opus|sonnet)-5(?:-|$)/.test(normalized)) {
      return { contextWindowTokens: 1_000_000, modelMaxOutputTokens: 128_000, source: "model" };
    }
    if (/^claude-(?:opus|sonnet)-4-(?:6|7|8)(?:-|$)/.test(normalized)) {
      return { contextWindowTokens: 1_000_000, modelMaxOutputTokens: 128_000, source: "model" };
    }
    if (/^claude-(?:sonnet-4-5|haiku-4-5)(?:-|$)/.test(normalized)) {
      return { contextWindowTokens: 200_000, modelMaxOutputTokens: 64_000, source: "model" };
    }
  }
  if (provider === "deepseek" && /^deepseek-v4-(?:flash|pro)(?:-|$)/.test(normalized)) {
    return { contextWindowTokens: 1_000_000, modelMaxOutputTokens: 384_000, source: "model" };
  }
  return { ...fallbackProfiles[provider], source: "provider-fallback" };
}
