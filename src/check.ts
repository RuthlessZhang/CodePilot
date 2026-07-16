import { exec } from "node:child_process";
import { buildProjectIndex } from "./project.js";

function run(root: string, command: string) {
  return new Promise<string>((resolve) =>
    exec(command, { cwd: root, timeout: 120000, maxBuffer: 1e6 }, (error, stdout, stderr) =>
      resolve(`$ ${command}\nexit_code: ${error ? (error as any).code ?? 1 : 0}\n${stdout}${stderr}`),
    ),
  );
}

export async function runChecks(root: string) {
  const index = await buildProjectIndex(root);
  if (!index.checkCommands.length) {
    return "No check commands detected. Add scripts to package.json or project metadata.";
  }

  const outputs: string[] = [];
  for (const command of index.checkCommands) {
    const output = await run(root, command);
    outputs.push(output);
    if (!output.includes("exit_code: 0")) break;
  }
  return outputs.join("\n\n");
}
