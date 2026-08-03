import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codepilot-package-install-"));

function run(command, args, options = {}) {
  const expectedExitCodes = options.expectedExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (expectedExitCodes.includes(code)) resolve({ code, stdout, stderr });
      else reject(Error(`${command} exited with ${code}\n${stdout}${stderr}`));
    });
  });
}

function runNpm(args, cwd = repositoryRoot) {
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args], { cwd });
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd });
}

function runInstalled(bin, args, options = {}) {
  if (process.platform !== "win32") return run(bin, args, options);
  return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "call", bin, ...args], options);
}

try {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const packageDirectory = path.join(temporaryRoot, "package");
  const installPrefix = path.join(temporaryRoot, "global");
  const workspace = path.join(temporaryRoot, "workspace");
  const configDirectory = path.join(temporaryRoot, "config");
  await Promise.all([
    mkdir(packageDirectory, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(configDirectory, { recursive: true }),
  ]);
  const resolvedWorkspace = await realpath(workspace);

  await runNpm(["pack", "--pack-destination", packageDirectory, "--silent"]);
  const tarballs = (await readdir(packageDirectory)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw Error(`Expected one package tarball, found ${tarballs.length}`);
  const tarball = path.join(packageDirectory, tarballs[0]);

  await runNpm([
    "install", "--global", "--prefix", installPrefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball,
  ]);
  const executable = process.platform === "win32"
    ? path.join(installPrefix, "codepilot.cmd")
    : path.join(installPrefix, "bin", "codepilot");
  await access(executable);

  const env = { ...process.env, CODEPILOT_CONFIG_DIR: configDirectory };
  delete env.OPENAI_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.ANTHROPIC_API_KEY;

  const version = await runInstalled(executable, ["--version"], { cwd: resolvedWorkspace, env });
  if (version.stdout.trim() !== packageJson.version) {
    throw Error(`Installed version mismatch: expected ${packageJson.version}, received ${version.stdout.trim()}`);
  }
  const help = await runInstalled(executable, ["--help"], { cwd: resolvedWorkspace, env });
  if (!/Usage:/.test(help.stdout) || !/codepilot init/.test(help.stdout)) throw Error("Installed help is incomplete");

  await runInstalled(executable, ["init", "--cwd", resolvedWorkspace], { cwd: resolvedWorkspace, env });
  await access(path.join(resolvedWorkspace, "AGENTS.md"));
  const doctor = await runInstalled(executable, ["doctor", "--json", "--cwd", resolvedWorkspace], {
    cwd: resolvedWorkspace,
    env,
    expectedExitCodes: [0, 1],
  });
  const report = JSON.parse(doctor.stdout);
  if (!report.version || report.workspace !== resolvedWorkspace) throw Error("Installed doctor report is invalid");

  console.log(`Verified global install of ${packageJson.name}@${packageJson.version}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
