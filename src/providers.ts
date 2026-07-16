import type { Message, Provider, ToolDef } from "./types.js";
import { ProviderProtocolError, requestProvider, type ProviderRequestOptions } from "./provider-runtime.js";

export type ProviderOptions = ProviderRequestOptions & {
  apiKey: string;
  baseUrl: string;
  model: string;
  extraBody?: Record<string, unknown>;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError(`Provider response is missing ${label}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new ProviderProtocolError(`Provider response has invalid ${label}`);
  return value;
}

function textContent(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    }).join("\n");
  }
  throw new ProviderProtocolError("Provider response has invalid message content");
}

function toolArguments(value: unknown, name: string) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") throw new ProviderProtocolError(`Tool ${name} has invalid arguments`);
  const trimmed = value.trim();
  if (!trimmed) return {};
  const candidates = [trimmed];
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (unfenced !== trimmed) candidates.push(unfenced);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next conservative JSON extraction before failing the response.
    }
  }
  throw new ProviderProtocolError(`Tool ${name} returned malformed JSON arguments`);
}

function parseOpenAIResponse(data: unknown) {
  const root = record(data, "response object");
  const choices = root.choices;
  if (!Array.isArray(choices) || !choices.length) throw new ProviderProtocolError("Provider response has no choices");
  const message = record(record(choices[0], "choice").message, "choice message");
  const rawCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) throw new ProviderProtocolError("Provider response has invalid tool_calls");
  return {
    text: textContent(message.content),
    toolCalls: rawCalls.map((value) => {
      const call = record(value, "tool call");
      const fn = record(call.function, "tool function");
      const name = requiredString(fn.name, "tool name");
      return {
        id: requiredString(call.id, "tool call id"),
        name,
        arguments: toolArguments(fn.arguments, name),
      };
    }),
  };
}

function parseAnthropicResponse(data: unknown) {
  const content = record(data, "response object").content;
  if (!Array.isArray(content)) throw new ProviderProtocolError("Provider response has invalid content blocks");
  const text: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const value of content) {
    const block = record(value, "content block");
    if (block.type === "text") text.push(requiredString(block.text, "text block"));
    if (block.type === "tool_use") {
      const name = requiredString(block.name, "tool name");
      toolCalls.push({
        id: requiredString(block.id, "tool call id"),
        name,
        arguments: toolArguments(block.input, name),
      });
    }
  }
  return { text: text.join("\n"), toolCalls };
}

export class OpenAIProvider implements Provider {
  constructor(private options: ProviderOptions) {}

  async complete(input: {
    system: string;
    messages: Message[];
    tools: ToolDef[];
    signal?: AbortSignal;
  }) {
    const messages: unknown[] = [{ role: "system", content: input.system }];

    for (const message of input.messages) {
      if (message.role === "tool") {
        messages.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        });
      } else {
        messages.push({
          role: message.role,
          content: message.content || null,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              }
            : {}),
        });
      }
    }

    return await requestProvider(
      `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          tools: input.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
          ...this.options.extraBody,
        }),
      },
      this.options,
      input.signal,
      parseOpenAIResponse,
    );
  }
}

export class DeepSeekProvider extends OpenAIProvider {
  constructor(options: ProviderOptions) {
    super({
      ...options,
      extraBody: { temperature: 0, ...options.extraBody },
    });
  }
}

export class AnthropicProvider implements Provider {
  constructor(private options: ProviderOptions) {}

  async complete(input: {
    system: string;
    messages: Message[];
    tools: ToolDef[];
    signal?: AbortSignal;
  }) {
    const messages: unknown[] = [];

    for (const message of input.messages) {
      if (message.role === "tool") {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: message.content,
            },
          ],
        });
      } else {
        messages.push({
          role: message.role,
          content: message.toolCalls?.length
            ? [
                ...(message.content ? [{ type: "text", text: message.content }] : []),
                ...message.toolCalls.map((call) => ({
                  type: "tool_use",
                  id: call.id,
                  name: call.name,
                  input: call.arguments,
                })),
              ]
            : message.content,
        });
      }
    }

    return await requestProvider(
      `${this.options.baseUrl.replace(/\/$/, "")}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: 8192,
          system: input.system,
          messages,
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
      },
      this.options,
      input.signal,
      parseAnthropicResponse,
    );
  }
}
