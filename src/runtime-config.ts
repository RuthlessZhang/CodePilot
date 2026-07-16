import { JsonlRuntimeAudit } from "./runtime-audit.js";
import { RuntimeEventBus, type RuntimeHook, type RuntimeHookError } from "./runtime-events.js";

export type RuntimeConfiguration = {
  runtimeAudit: boolean;
  runtimeAuditPath: string;
  runtimeHookTimeoutMs: number;
  protectedPaths: string[];
};

function normalize(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function globMatches(value: string, pattern: string) {
  const source = normalize(pattern).replace(/\/$/, "/**");
  let expression = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "*") {
      if (source[index + 1] === "*") {
        index++;
        expression += ".*";
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`).test(normalize(value));
}

function editPaths(args: Record<string, unknown>) {
  const paths = typeof args.path === "string" ? [args.path] : [];
  if (typeof args.patch === "string") {
    paths.push(...[...args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((match) => match[1].trim()));
  }
  return [...new Set(paths.map(normalize))];
}

export function createProtectedPathsHook(patterns: readonly string[]): RuntimeHook {
  const normalizedPatterns = patterns.map(normalize).filter(Boolean);
  return {
    name: "protect-paths",
    events: ["edit.preparing"],
    handle(event) {
      if (event.name !== "edit.preparing") return;
      const blocked = editPaths(event.data.args).find((file) =>
        normalizedPatterns.some((pattern) => globMatches(file, pattern)),
      );
      if (blocked) return { deny: `Path is protected by runtime policy: ${blocked}` };
    },
  };
}

export function createConfiguredRuntime(
  root: string,
  config: RuntimeConfiguration,
  onHookError?: (failure: RuntimeHookError) => void,
) {
  const audit = config.runtimeAudit ? new JsonlRuntimeAudit(root, config.runtimeAuditPath) : undefined;
  const hooks = config.protectedPaths.length ? [createProtectedPathsHook(config.protectedPaths)] : [];
  return new RuntimeEventBus({
    hooks,
    hookTimeoutMs: config.runtimeHookTimeoutMs,
    onEvent: audit ? (event) => audit.record(event) : undefined,
    onHookError,
  });
}
