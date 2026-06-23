import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CompactionResult,
  type ExtensionRunner,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const OM_FOLDED = "om.folded";
const OM_COMPACT_ERROR = "Cannot fork with sessionSnapshot=\"om-compact\": observational memory did not provide compaction.";

type CompactionSettings = ReturnType<SettingsManager["getCompactionSettings"]>;
type CompactionPreparation = unknown;
type PrepareCompaction = (entries: SessionEntry[], settings: CompactionSettings) => CompactionPreparation | undefined;

type SessionForOmCompaction = Pick<SessionManager, "appendCompaction" | "getBranch" | "getEntry">;
type SettingsForOmCompaction = Pick<SettingsManager, "getCompactionSettings">;
type ExtensionRunnerForOmCompaction = Pick<ExtensionRunner, "emit" | "hasHandlers">;

interface OmCompactionRuntime {
  sessionManager: SessionForOmCompaction;
  settingsManager: SettingsForOmCompaction;
  extensionRunner: ExtensionRunnerForOmCompaction;
}

interface ApplyOmCompactionOptions {
  signal?: AbortSignal;
  prepareCompaction?: PrepareCompaction;
}

interface CompactForkSessionWithOmOptions {
  cwd: string;
  sessionPath: string;
  signal?: AbortSignal;
  omExtensionPath: string;
}

const WORKER_STDERR_MAX_CHARS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOmCompaction(value: unknown): value is CompactionResult {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    typeof value.firstKeptEntryId === "string" &&
    typeof value.tokensBefore === "number" &&
    isRecord(value.details) &&
    value.details.type === OM_FOLDED
  );
}

function getPiCodingAgentEntry(): string {
  return import.meta.resolve("@earendil-works/pi-coding-agent");
}

function getPiCodingAgentPackageDir(): string {
  const indexPath = fileURLToPath(getPiCodingAgentEntry());
  return path.dirname(path.dirname(indexPath));
}

function getOmCompactWorkerPath(): string {
  return fileURLToPath(new URL("./om-compact-preflight-worker.js", import.meta.url));
}

function compactErrorFromStderr(stderr: string, fallback: string): Error {
  const trimmed = stderr.trim();
  return new Error(trimmed || fallback);
}

function appendCapped(buffer: string, chunk: Buffer): string {
  const next = buffer + chunk.toString("utf8");
  return next.length <= WORKER_STDERR_MAX_CHARS
    ? next
    : next.slice(next.length - WORKER_STDERR_MAX_CHARS);
}

export async function compactForkSessionWithOmInSubprocess(options: CompactForkSessionWithOmOptions): Promise<void> {
  const node = process.env.PI_FORK_NODE || process.env.NODE || "node";
  const payload = JSON.stringify({
    cwd: options.cwd,
    sessionPath: options.sessionPath,
    omExtensionPath: options.omExtensionPath,
    piCodingAgentEntry: getPiCodingAgentEntry(),
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(node, [getOmCompactWorkerPath(), payload], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("OM compact fork preflight was aborted."));
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }

    options.signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendCapped(stderr, chunk); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish();
        return;
      }
      const fallback = signal
        ? `Cannot fork with sessionSnapshot=\"om-compact\": preflight exited with signal ${signal}.`
        : `Cannot fork with sessionSnapshot=\"om-compact\": preflight exited with code ${code ?? "unknown"}.`;
      finish(compactErrorFromStderr(stderr, fallback));
    });
  });
}

async function loadPrepareCompaction(): Promise<PrepareCompaction> {
  const modulePath = pathToFileURL(path.join(getPiCodingAgentPackageDir(), "dist/core/compaction/compaction.js")).href;
  const mod = await import(modulePath) as { prepareCompaction?: unknown };
  if (typeof mod.prepareCompaction !== "function") {
    throw new Error("Cannot fork with sessionSnapshot=\"om-compact\": Pi compaction preparation API is unavailable.");
  }
  return mod.prepareCompaction as PrepareCompaction;
}

function getExtensionRunner(session: AgentSession): ExtensionRunnerForOmCompaction {
  const runner = (session as unknown as { _extensionRunner?: ExtensionRunnerForOmCompaction })._extensionRunner;
  if (!runner) {
    throw new Error("Cannot fork with sessionSnapshot=\"om-compact\": Pi extension runtime is unavailable.");
  }
  return runner;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("OM compact fork preflight was aborted.");
}

export async function applyOmCompactionToSession(
  runtime: OmCompactionRuntime,
  options: ApplyOmCompactionOptions = {},
): Promise<void> {
  const prepareCompaction = options.prepareCompaction ?? await loadPrepareCompaction();
  const branchEntries = runtime.sessionManager.getBranch();
  const preparation = prepareCompaction(branchEntries, runtime.settingsManager.getCompactionSettings());
  if (!preparation) return;

  assertNotAborted(options.signal);
  if (!runtime.extensionRunner.hasHandlers("session_before_compact")) {
    throw new Error(OM_COMPACT_ERROR);
  }

  const result = await runtime.extensionRunner.emit({
    type: "session_before_compact",
    preparation,
    branchEntries,
    signal: options.signal,
  } as any) as any;

  assertNotAborted(options.signal);
  if (result?.cancel) throw new Error("OM compact fork preflight was cancelled.");
  if (!isOmCompaction(result?.compaction)) throw new Error(OM_COMPACT_ERROR);

  const compaction = result.compaction;
  const compactionEntryId = runtime.sessionManager.appendCompaction(
    compaction.summary,
    compaction.firstKeptEntryId,
    compaction.tokensBefore,
    compaction.details,
    true,
  );
  const compactionEntry = runtime.sessionManager.getEntry(compactionEntryId);
  if (compactionEntry) {
    await runtime.extensionRunner.emit({
      type: "session_compact",
      compactionEntry,
      fromExtension: true,
    } as any);
  }
}

export async function compactForkSessionWithOm(options: CompactForkSessionWithOmOptions): Promise<void> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [options.omExtensionPath],
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.open(options.sessionPath, undefined, options.cwd);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager,
    noTools: "all",
    sessionStartEvent: { type: "session_start", reason: "startup" },
  });

  try {
    await applyOmCompactionToSession({
      sessionManager,
      settingsManager,
      extensionRunner: getExtensionRunner(session),
    }, { signal: options.signal });
  } finally {
    session.dispose();
  }
}
