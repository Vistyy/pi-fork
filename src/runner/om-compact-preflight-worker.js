import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OM_FOLDED = "om.folded";
const OM_COMPACT_ERROR = "Cannot fork with sessionSnapshot=\"om-compact\": observational memory did not provide compaction.";

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isOmCompaction(value) {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    typeof value.firstKeptEntryId === "string" &&
    typeof value.tokensBefore === "number" &&
    isRecord(value.details) &&
    value.details.type === OM_FOLDED
  );
}

function parsePayload() {
  const raw = process.argv[2];
  if (!raw) throw new Error("Cannot fork with sessionSnapshot=\"om-compact\": missing preflight payload.");
  const parsed = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.cwd !== "string" ||
    typeof parsed.sessionPath !== "string" ||
    typeof parsed.omExtensionPath !== "string" ||
    typeof parsed.piCodingAgentEntry !== "string"
  ) {
    throw new Error("Cannot fork with sessionSnapshot=\"om-compact\": invalid preflight payload.");
  }
  return parsed;
}

function getPiCodingAgentPackageDir(piCodingAgentEntry) {
  const indexPath = fileURLToPath(piCodingAgentEntry);
  return path.dirname(path.dirname(indexPath));
}

async function loadPrepareCompaction(piCodingAgentEntry) {
  const modulePath = pathToFileURL(path.join(
    getPiCodingAgentPackageDir(piCodingAgentEntry),
    "dist/core/compaction/compaction.js",
  )).href;
  const mod = await import(modulePath);
  if (typeof mod.prepareCompaction !== "function") {
    throw new Error("Cannot fork with sessionSnapshot=\"om-compact\": Pi compaction preparation API is unavailable.");
  }
  return mod.prepareCompaction;
}

function getExtensionRunner(session) {
  const runner = session?._extensionRunner;
  if (!runner) {
    throw new Error("Cannot fork with sessionSnapshot=\"om-compact\": Pi extension runtime is unavailable.");
  }
  return runner;
}

async function applyOmCompactionToSession(runtime, prepareCompaction) {
  const branchEntries = runtime.sessionManager.getBranch();
  const preparation = prepareCompaction(branchEntries, runtime.settingsManager.getCompactionSettings());
  if (!preparation) return;

  if (!runtime.extensionRunner.hasHandlers("session_before_compact")) {
    throw new Error(OM_COMPACT_ERROR);
  }

  const result = await runtime.extensionRunner.emit({
    type: "session_before_compact",
    preparation,
    branchEntries,
  });
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
    });
  }
}

async function compactForkSessionWithOm(payload) {
  const pi = await import(payload.piCodingAgentEntry);
  const prepareCompaction = await loadPrepareCompaction(payload.piCodingAgentEntry);
  const agentDir = pi.getAgentDir();
  const settingsManager = pi.SettingsManager.create(payload.cwd, agentDir);
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: payload.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [payload.omExtensionPath],
  });
  await resourceLoader.reload();

  const sessionManager = pi.SessionManager.open(payload.sessionPath, undefined, payload.cwd);
  const { session } = await pi.createAgentSession({
    cwd: payload.cwd,
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
    }, prepareCompaction);
  } finally {
    session.dispose();
  }
}

try {
  await compactForkSessionWithOm(parsePayload());
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
