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
};

export type ProviderCompletion = {
  text: string;
  toolCalls: ToolCall[];
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
