import { spawn, type ChildProcess } from "node:child_process";

export type CommandResult = {
  exitCode: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
};

export type RunCommandOptions = {
  root: string;
  command: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
};

function cancellationError() {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

function waitForProcessClose(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    child.once("close", onClose);
  });
}

async function terminateProcessTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      child.kill("SIGBREAK");
      if (await waitForProcessClose(child, 1_000)) return;
    } catch {
      // Fall back to taskkill for processes that do not accept console break.
    }

    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => {
        child.kill();
        resolve();
      });
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolve();
    }, 1_000);
    force.unref();
    child.once("close", () => {
      clearTimeout(force);
      resolve();
    });
  });
}

export function runCommand(options: RunCommandOptions) {
  return new Promise<CommandResult>((resolve, reject) => {
    if (options.signal?.aborted) return reject(cancellationError());
    const started = Date.now();
    const timeoutMs = Math.max(100, options.timeoutMs ?? 120_000);
    const maxOutputChars = Math.max(1_000, options.maxOutputChars ?? 1_000_000);
    const child = spawn(options.command, {
      cwd: options.root,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let output = "";
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let closed = false;
    let terminating = false;

    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      options.onOutput?.(text);
      if (output.length >= maxOutputChars) {
        truncated = true;
        return;
      }
      output += text.slice(0, maxOutputChars - output.length);
      if (output.length >= maxOutputChars) truncated = true;
    };
    const terminate = (reason: "timeout" | "cancel") => {
      if (closed || terminating) return;
      terminating = true;
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      clearTimeout(timeout);
      void terminateProcessTree(child);
    };
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    const onAbort = () => terminate("cancel");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => append(Buffer.from(`Unable to start command: ${error.message}\n`)));
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (cancelled) return reject(cancellationError());
      resolve({
        exitCode: timedOut ? 124 : code ?? 1,
        output,
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      });
    });
  });
}

export function formatCommandResult(result: CommandResult) {
  return [
    `exit_code: ${result.exitCode}`,
    `duration_ms: ${result.durationMs}`,
    `timed_out: ${result.timedOut}`,
    `truncated: ${result.truncated}`,
    result.output,
  ].join("\n");
}