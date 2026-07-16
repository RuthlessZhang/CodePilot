import { DeepSeekProvider } from "./providers.js";
import { summarizeMessages } from "./session-summary.js";
import { truncateToTokens } from "./token.js";
import type { Message } from "./types.js";

export type SummaryMode = "model" | "fallback";

export type SummaryResult = {
  mode: SummaryMode;
  model: string;
  text: string;
};

function messageTranscript(messages: Message[]) {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `TOOL ${message.name} (${message.toolCallId}):\n${truncateToTokens(message.content, 400)}`;
      }
      const calls = message.toolCalls?.length
        ? `\nTOOL_CALLS: ${JSON.stringify(message.toolCalls)}`
        : "";
      return `${message.role.toUpperCase()}:\n${truncateToTokens(message.content, 800)}${calls}`;
    })
    .join("\n\n---\n\n");
}

function fallback(messages: Message[], reason = "model summarizer unavailable"): SummaryResult {
  return {
    mode: "fallback",
    model: "local-fallback",
    text: `<!-- fallback summary: ${reason} -->\n${summarizeMessages(messages)}`,
  };
}

export async function summarizeWithDeepSeekFlash(messages: Message[]): Promise<SummaryResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return fallback(messages, "DEEPSEEK_API_KEY is not set");

  const provider = new DeepSeekProvider({
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  });

  try {
    const response = await provider.complete({
      system: `You summarize coding-agent sessions for future context.
Return concise Markdown with these headings:
- Current Task
- Decisions
- Files and Changes
- Tool Results
- Verification
- Open Risks
Preserve concrete file paths, commands, errors, and user intent. Do not invent results.`,
      messages: [
        {
          role: "user",
          content: `Summarize these older CodePilot messages for future context:\n\n${messageTranscript(messages)}`,
        },
      ],
      tools: [],
    });

    const text = response.text.trim();
    if (!text) return fallback(messages, "empty model summary");
    return {
      mode: "model",
      model: "deepseek-v4-flash",
      text,
    };
  } catch (error) {
    return fallback(messages, (error as Error).message);
  }
}
