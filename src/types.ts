export type Risk = "read" | "write" | "execute";
export type AgentMode = "plan" | "build";

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Message =
  | { role: "user" | "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: unknown;
};

export type ToolEvent = {
  phase: "started" | "output" | "completed" | "failed";
  name: string;
  args: Record<string, unknown>;
  content?: string;
  durationMs?: number;
};

export type ProviderCompletionInput = {
  system: string;
  messages: Message[];
  tools: ToolDef[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
  toolChoice?: "auto" | "required" | { name: string };
  onEvent?: (event: ProviderStreamEvent) => void;
};

export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
};

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; usage: ProviderUsage };

export type ProviderCompletion = {
  text: string;
  toolCalls: ToolCall[];
  usage?: ProviderUsage;
  finishReason?: string;
};

export interface Provider {
  complete(input: ProviderCompletionInput): Promise<ProviderCompletion>;
}

export type ToolExecutionContext = {
  signal?: AbortSignal;
  beforeWrite?: (absPath: string) => Promise<void>;
};

export interface Tool {
  definition: ToolDef;
  risk: Risk;
  execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string>;
  dispose?(): Promise<void>;
}
