import { estimateTokens, truncateToTokens } from "./token.js";
import type { Message, ToolDef } from "./types.js";

export type ContextSection = {
  name: string;
  content: string;
};

export type SystemContext = {
  text: string;
  sections: ContextSection[];
};

export type ContextPackOptions = {
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  safetyMarginTokens?: number;
  toolDefinitions?: ToolDef[];
  toolResultMaxTokens?: number;
  oldToolResultMaxTokens?: number;
  recentToolResults?: number;
};

export type ContextReport = {
  budgetTokens: number;
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
  toolDefinitionTokens: number;
  systemTokens: number;
  systemSectionTokens: Record<string, number>;
  messageTokens: number;
  userAssistantTokens: number;
  toolResultTokens: number;
  totalTokens: number;
  remainingTokens: number;
  keptMessages: number;
  omittedMessages: number;
  prunedToolMessages: number;
  truncatedSystemSections: number;
};

export type PackedContext = {
  system: string;
  messages: Message[];
  report: ContextReport;
};

function messageText(message: Message) {
  if (message.role === "tool") return `tool:${message.name}:${message.content}`;
  return `${message.role}:${message.content}:${JSON.stringify(message.toolCalls ?? [])}`;
}

function messageTokens(message: Message) {
  return estimateTokens(messageText(message));
}

function compactToolResult(message: Message, maxTokens: number): Message {
  if (message.role !== "tool") return message;
  return { ...message, content: truncateToTokens(message.content, maxTokens) };
}

function normalizeSystem(system: string | SystemContext): SystemContext {
  if (typeof system !== "string") return system;
  return { text: system, sections: [{ name: "system", content: system }] };
}

function packSystem(context: SystemContext, budgetTokens: number) {
  const sectionTokens: Record<string, number> = {};
  const kept: string[] = [];
  let truncated = 0;
  for (const section of context.sections) {
    if (!section.content.trim()) continue;
    const currentText = kept.join("\n\n");
    const separator = kept.length ? "\n\n" : "";
    const remaining = budgetTokens - estimateTokens(currentText + separator);
    if (remaining <= 0) {
      truncated++;
      continue;
    }
    const originalTokens = estimateTokens(section.content);
    const content = originalTokens > remaining
      ? truncateToTokens(section.content, remaining)
      : section.content;
    const tokens = estimateTokens(content);
    kept.push(content);
    sectionTokens[section.name] = (sectionTokens[section.name] ?? 0) + tokens;
    if (originalTokens > remaining) truncated++;
  }
  const text = kept.join("\n\n");
  return { text, tokens: estimateTokens(text), sectionTokens, truncated };
}

type IndexedMessage = { message: Message; index: number; pruned: boolean };

function prepareMessages(messages: Message[], options: ContextPackOptions): IndexedMessage[] {
  const recentLimit = Math.max(100, options.toolResultMaxTokens ?? 1_200);
  const oldLimit = Math.max(50, Math.min(recentLimit, options.oldToolResultMaxTokens ?? 160));
  const recentCount = Math.max(0, options.recentToolResults ?? 2);
  let seenTools = 0;
  return messages.map((message, index) => ({ message, index, pruned: false })).reverse().map((item) => {
    if (item.message.role !== "tool") return item;
    const limit = seenTools++ < recentCount ? recentLimit : oldLimit;
    if (messageTokens(item.message) <= limit) return item;
    return { ...item, message: compactToolResult(item.message, limit), pruned: true };
  }).reverse();
}

export function packContext(
  system: string | SystemContext,
  messages: Message[],
  budgetTokens: number,
  options: ContextPackOptions = {},
): PackedContext {
  const requestedBudget = Math.max(2_000, budgetTokens);
  const contextWindowTokens = Math.max(1, options.contextWindowTokens ?? requestedBudget);
  const outputReserveTokens = Math.max(0, options.outputReserveTokens ?? 0);
  const safetyMarginTokens = Math.max(0, options.safetyMarginTokens ?? 0);
  const maximumInput = Math.max(0, contextWindowTokens - outputReserveTokens - safetyMarginTokens);
  const inputBudgetTokens = Math.min(requestedBudget, maximumInput);
  const toolDefinitionTokens = estimateTokens(JSON.stringify(options.toolDefinitions ?? []));
  const contentBudget = Math.max(0, inputBudgetTokens - toolDefinitionTokens);
  const prepared = prepareMessages(messages, options);
  const totalPreparedMessageTokens = prepared.reduce((sum, item) => sum + messageTokens(item.message), 0);
  const messageReserve = Math.min(totalPreparedMessageTokens, Math.floor(contentBudget * 0.45));
  const systemBudget = Math.max(0, contentBudget - messageReserve);
  const packedSystem = packSystem(normalizeSystem(system), systemBudget);
  const messageBudget = Math.max(0, contentBudget - packedSystem.tokens);
  const kept: IndexedMessage[] = [];
  let used = 0;

  for (const item of [...prepared].reverse()) {
    const cost = messageTokens(item.message);
    if (used + cost > messageBudget && kept.length > 0) break;
    if (used + cost > messageBudget) {
      const remaining = messageBudget - used;
      if (remaining > 0) {
        const message = item.message.role === "tool"
          ? compactToolResult(item.message, remaining)
          : { ...item.message, content: truncateToTokens(item.message.content, remaining) };
        kept.push({ ...item, message, pruned: true });
      }
      break;
    }
    kept.push(item);
    used += cost;
  }

  const packedItems = kept.reverse();
  while (packedItems[0]?.message.role === "tool") packedItems.shift();
  const packedMessages = packedItems.map((item) => item.message);
  const userAssistantTokens = packedMessages
    .filter((message) => message.role !== "tool")
    .reduce((sum, message) => sum + messageTokens(message), 0);
  const toolResultTokens = packedMessages
    .filter((message) => message.role === "tool")
    .reduce((sum, message) => sum + messageTokens(message), 0);
  const messageTokenTotal = userAssistantTokens + toolResultTokens;
  const totalTokens = packedSystem.tokens + messageTokenTotal + toolDefinitionTokens;

  return {
    system: packedSystem.text,
    messages: packedMessages,
    report: {
      budgetTokens: inputBudgetTokens,
      contextWindowTokens,
      outputReserveTokens,
      safetyMarginTokens,
      inputBudgetTokens,
      toolDefinitionTokens,
      systemTokens: packedSystem.tokens,
      systemSectionTokens: packedSystem.sectionTokens,
      messageTokens: messageTokenTotal,
      userAssistantTokens,
      toolResultTokens,
      totalTokens,
      remainingTokens: Math.max(0, inputBudgetTokens - totalTokens),
      keptMessages: packedMessages.length,
      omittedMessages: Math.max(0, messages.length - packedMessages.length),
      prunedToolMessages: packedItems.filter((item) => item.pruned && item.message.role === "tool").length,
      truncatedSystemSections: packedSystem.truncated,
    },
  };
}

export function formatContextReport(report: ContextReport) {
  const sectionLines = Object.entries(report.systemSectionTokens)
    .map(([name, tokens]) => `  ${name}: ${tokens}`);
  return [
    `contextWindowTokens: ${report.contextWindowTokens}`,
    `outputReserveTokens: ${report.outputReserveTokens}`,
    `safetyMarginTokens: ${report.safetyMarginTokens}`,
    `budgetTokens: ${report.budgetTokens}`,
    `inputBudgetTokens: ${report.inputBudgetTokens}`,
    `toolDefinitionTokens: ${report.toolDefinitionTokens}`,
    `systemTokens: ${report.systemTokens}`,
    ...sectionLines,
    `messageTokens: ${report.messageTokens}`,
    `userAssistantTokens: ${report.userAssistantTokens}`,
    `toolResultTokens: ${report.toolResultTokens}`,
    `totalTokens: ${report.totalTokens}`,
    `remainingTokens: ${report.remainingTokens}`,
    `keptMessages: ${report.keptMessages}`,
    `omittedMessages: ${report.omittedMessages}`,
    `prunedToolMessages: ${report.prunedToolMessages}`,
    `truncatedSystemSections: ${report.truncatedSystemSections}`,
  ].join("\n");
}
