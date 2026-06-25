/**
 * Fork process runner.
 *
 * Spawns an isolated `pi` process, gives it a temporary session snapshot, and
 * streams JSON-mode results back to the parent tool call.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { buildChildEnv, PI_FORK_SANDBOX_HOST_TMPDIR_ENV, PI_FORK_SANDBOX_TMPDIR_ENV } from "./env.js";
import { buildForkTaskPrompt } from "./prompt.js";
import { DEFAULT_SANDBOX_CONFIG, type ForkSandboxConfig } from "../config.js";
import { compactForkSessionWithOmInSubprocess } from "./om-compact-preflight.js";
import { type ForkDetails, type ForkEffort, type ForkEffortProfile, type ForkEffortState, type ForkResult, emptyUsage, normalizeCompletedResult } from "../core/types.js";
import type { ForkSessionSnapshotMode } from "../session-snapshot.js";
import { parseInheritedCliArgs } from "./cli.js";
import { processPiJsonLine } from "../child-events/index.js";
import { getChildProgressText } from "../child-events/progress.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;

type OnUpdateCallback = (partial: AgentToolResult<ForkDetails>) => void;
export type ContextWindowResolver = (provider?: string, model?: string) => number | undefined;

export function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const configured = process.env.PI_FORK_PI_COMMAND?.trim();
  return { command: configured || "pi", prefixArgs: [] };
}

function createForkSessionTempFile(): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-"));
  return { dir: tmpDir, filePath: path.join(tmpDir, "fork.jsonl") };
}

function createForkSandboxTempDir(baseTmpDir: string): string {
  fs.mkdirSync(baseTmpDir, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(baseTmpDir, "pi-fork-sandbox-"));
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

export function buildPiArgs(
  task: string,
  forkSessionPath: string,
  extensions: string[] | null,
  effortProfile?: ForkEffortProfile,
  inherited = inheritedCliArgs,
  effort?: ForkEffort,
  tools?: string | null,
  sandbox?: ForkSandboxConfig,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inherited.alwaysProxy,
    "-p",
    "--session",
    forkSessionPath,
  ];

  if (extensions !== null) {
    args.push("--no-extensions");
  }

  if (inherited.fallbackModel) {
    args.push("--model", inherited.fallbackModel);
  }

  if (inherited.fallbackThinking) {
    args.push("--thinking", inherited.fallbackThinking);
  }

  if (effortProfile) {
    args.push("--provider", effortProfile.provider);
    args.push("--model", effortProfile.id);
    args.push("--thinking", effortProfile.thinking);
  }

  if (tools !== undefined && tools !== null) {
    if (tools === "") args.push("--no-tools");
    else args.push("--tools", tools);
  } else if (inherited.fallbackTools !== undefined) {
    args.push("--tools", inherited.fallbackTools);
  } else if (inherited.fallbackNoTools) {
    args.push("--no-tools");
  }

  if (extensions !== null) {
    for (const extension of extensions) {
      args.push("--extension", extension);
    }
  }

  args.push(buildForkTaskPrompt(task, effort, { writableTmpDir: sandbox?.tmpDir }));
  return args;
}

export interface RunForkOptions {
  cwd: string;
  task: string;
  forkSessionSnapshotJsonl?: string;
  writeForkSessionSnapshot?: (filePath: string) => boolean;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  tools?: string | null;
  offline?: boolean;
  sandbox?: ForkSandboxConfig;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: ForkResult[]) => ForkDetails;
  effort?: ForkEffortState;
  resolveContextWindow?: ContextWindowResolver;
  sessionSnapshot?: ForkSessionSnapshotMode;
  omCompactExtension?: string;
}

export async function runFork(opts: RunForkOptions): Promise<ForkResult> {
  const {
    cwd,
    task,
    forkSessionSnapshotJsonl,
    writeForkSessionSnapshot,
    extensions = null,
    environment = {},
    tools = null,
    offline = true,
    sandbox,
    signal,
    onUpdate,
    makeDetails,
    effort,
    resolveContextWindow,
    sessionSnapshot = "full",
    omCompactExtension,
  } = opts;

  if (!writeForkSessionSnapshot && !forkSessionSnapshotJsonl?.trim()) {
    const failedResult: ForkResult = {
      task,
      exitCode: 1,
      messages: [],
      stderr: "Cannot fork: missing parent session snapshot context.",
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: "Cannot fork: missing parent session snapshot context.",
    };
    if (effort) failedResult.effort = effort;
    return failedResult;
  }

  const result: ForkResult = {
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };
  if (effort) result.effort = effort;

  const enrichContextWindow = () => {
    if (result.usage.contextWindow || !resolveContextWindow) return;
    const contextWindow = resolveContextWindow(result.provider, result.model);
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      result.usage.contextWindow = contextWindow;
    }
  };

  const emitUpdate = () => {
    enrichContextWindow();
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getChildProgressText(result),
        },
      ],
      details: makeDetails([result]),
    });
  };

  const failBeforeSpawn = (message: string): ForkResult => {
    result.exitCode = signal?.aborted ? 130 : 1;
    result.stderr = message;
    result.stopReason = signal?.aborted ? "aborted" : "error";
    result.errorMessage = message;
    return result;
  };

  let forkSessionTmpDir: string | null = null;
  let forkSessionTmpPath: string | null = null;
  let forkSandboxTmpDir: string | null = null;
  const configuredSandbox = sandbox || DEFAULT_SANDBOX_CONFIG;

  try {
    const tmp = createForkSessionTempFile();
    forkSessionTmpDir = tmp.dir;
    forkSessionTmpPath = tmp.filePath;
    forkSandboxTmpDir = createForkSandboxTempDir(configuredSandbox.tmpDir);
    const effectiveSandbox = { ...configuredSandbox, tmpDir: forkSandboxTmpDir };

    try {
      if (writeForkSessionSnapshot) {
        if (!writeForkSessionSnapshot(forkSessionTmpPath)) {
          return failBeforeSpawn("Cannot fork: failed to snapshot current session context.");
        }
      } else {
        fs.writeFileSync(forkSessionTmpPath, forkSessionSnapshotJsonl || "", { encoding: "utf-8", mode: 0o600 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failBeforeSpawn(message);
    }

    if (sessionSnapshot === "om-compact") {
      try {
        if (!omCompactExtension) {
          throw new Error("Cannot fork with sessionSnapshot=\"om-compact\": pi-fork.omCompactExtension is not configured.");
        }
        await compactForkSessionWithOmInSubprocess({ cwd, sessionPath: forkSessionTmpPath, signal, omExtensionPath: omCompactExtension });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failBeforeSpawn(message);
      }
    }

    const piArgs = buildPiArgs(task, forkSessionTmpPath, extensions, effort?.profile, inheritedCliArgs, effort?.selected, tools, effectiveSandbox);
    const childEnvironment = {
      ...environment,
      [PI_FORK_SANDBOX_HOST_TMPDIR_ENV]: forkSandboxTmpDir,
      [PI_FORK_SANDBOX_TMPDIR_ENV]: effectiveSandbox.tmpDir,
    };
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const { command, prefixArgs } = resolvePiSpawn();
      const proc = spawn(command, [...prefixArgs, ...piArgs], {
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(childEnvironment, process.env, process.platform, offline),
      });

      proc.stdin.on("error", () => {
        /* ignore broken pipe on fast exits */
      });
      proc.stdin.end();

      let buffer = "";
      let didClose = false;
      let settled = false;
      let abortHandler: (() => void) | undefined;

      const terminateChild = () => {
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.unref();
          }
          return;
        }

        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!didClose) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve(code);
      };

      const flushLine = (line: string) => {
        if (processPiJsonLine(line, result)) emitUpdate();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const onStdoutData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
      };

      const onStderrData = (chunk: Buffer) => {
        result.stderr += chunk.toString();
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);

      proc.on("close", (code) => {
        didClose = true;
        if (buffer.trim()) flushBufferedLines(buffer);
        finish(code ?? 0);
      });

      proc.on("error", (err) => {
        if (!result.stderr.trim()) result.stderr = err.message;
        finish(1);
      });

      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    enrichContextWindow();
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    cleanupTempDir(forkSessionTmpDir);
    cleanupTempDir(forkSandboxTmpDir);
  }
}
