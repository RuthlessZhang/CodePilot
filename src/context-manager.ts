import { estimateTokens, truncateToTokens } from "./token.js";
import type { Message } from "./types.js";

export type ContextReport = {
  budgetTokens: number;
  systemTokens: number;
  messageTokens: number;
  totalTokens: number;
  keptMessages: number;
  omittedMessages: number;
};

export type PackedContext = {
  system: string;
  messages: Message[];
  report: ContextReport;
};

function messageText(message: Message) {
  if (message.role === "tool") {
    return `tool:${message.name}:${message.content}`;
  }
  return `${message.role}:${message.content}:${JSON.stringify(message.toolCalls ?? [])}`;
}

function messageTokens(message: Message) {
  return estimateTokens(messageText(message));
}

function compactToolResult(message: Message, maxTokens: number): Message {
  if (message.role !== "tool") return message;
  return {
    ...message,
    content: truncateToTokens(message.content, maxTokens),
  };
}

export function packContext(system: string, messages: Message[], budgetTokens: number): PackedContext {
  const safeBudget = Math.max(2000, budgetTokens);
  const systemBudget = Math.floor(safeBudget * 0.35);
  const messageBudget = safeBudget - systemBudget;
  const packedSystem = truncateToTokens(system, systemBudget);
  const kept: Message[] = [];
  let used = 0;

  for (const message of [...messages].reverse()) {
    const candidate =
      message.role === "tool" && messageTokens(message) > 500
        ? compactToolResult(message, 500)
        : message;
    const cost = messageTokens(candidate);
    if (used + cost > messageBudget && kept.length > 0) break;
    if (used + cost > messageBudget) {
      kept.push(
        candidate.role === "tool"
          ? compactToolResult(candidate, Math.max(100, messageBudget - used))
          : { ...candidate, content: truncateToTokens(candidate.content, Math.max(100, messageBudget - used)) },
      );
      break;
    }
    kept.push(candidate);
    used += cost;
  }

  const packedMessages = kept.reverse();
  const systemTokens = estimateTokens(packedSystem);
  const totalMessageTokens = packedMessages.reduce((sum, message) => sum + messageTokens(message), 0);

  return {
    system: packedSystem,
    messages: packedMessages,
    report: {
      budgetTokens: safeBudget,
      systemTokens,
      messageTokens: totalMessageTokens,
      totalTokens: systemTokens + totalMessageTokens,
      keptMessages: packedMessages.length,
      omittedMessages: Math.max(0, messages.length - packedMessages.length),
    },
  };
}

export function formatContextReport(report: ContextReport) {
  return [
    `budgetTokens: ${report.budgetTokens}`,
    `systemTokens: ${report.systemTokens}`,
    `messageTokens: ${report.messageTokens}`,
    `totalTokens: ${report.totalTokens}`,
    `keptMessages: ${report.keptMessages}`,
    `omittedMessages: ${report.omittedMessages}`,
  ].join("\n");
}
