import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOmCompactionToSession, compactForkSessionWithOmInSubprocess } from "../src/runner/om-compact-preflight.js";

const entry = { type: "message", id: "entry-1", parentId: null, timestamp: "2026-06-21T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "old" }] } };
const preparation = { firstKeptEntryId: "entry-1" };
const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function tempDir(name: string): string {
  const dir = join(tmpdir(), `pi-fork-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtime(overrides: any = {}) {
  const appended: any[] = [];
  const compactionEntry = { type: "compaction", id: "compact-1", parentId: "entry-1", timestamp: "2026-06-21T00:00:01.000Z" };
  const emit = vi.fn(async (event: any) => {
    if (event.type === "session_before_compact") {
      return {
        compaction: {
          summary: "OM summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 123,
          details: { type: "om.folded", reflections: [] },
        },
      };
    }
    return undefined;
  });
  return {
    appended,
    value: {
      sessionManager: {
        getBranch: vi.fn(() => [entry]),
        appendCompaction: vi.fn((summary, firstKeptEntryId, tokensBefore, details, fromHook) => {
          appended.push({ summary, firstKeptEntryId, tokensBefore, details, fromHook });
          return "compact-1";
        }),
        getEntry: vi.fn(() => compactionEntry),
      },
      settingsManager: { getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 10 })) },
      extensionRunner: { hasHandlers: vi.fn(() => true), emit },
      ...overrides,
    },
  };
}

describe("OM compact fork preflight", () => {
  it("appends OM hook compaction and emits session_compact", async () => {
    const rt = runtime();

    await applyOmCompactionToSession(rt.value as any, { prepareCompaction: () => preparation });

    expect(rt.appended).toEqual([{ summary: "OM summary", firstKeptEntryId: "entry-1", tokensBefore: 123, details: { type: "om.folded", reflections: [] }, fromHook: true }]);
    expect(rt.value.extensionRunner.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "session_compact", compactionEntry: expect.objectContaining({ id: "compact-1" }), fromExtension: true }));
  });

  it("skips when no compaction can be prepared", async () => {
    const rt = runtime();

    await expect(applyOmCompactionToSession(rt.value as any, { prepareCompaction: () => undefined })).resolves.toBeUndefined();

    expect(rt.value.extensionRunner.emit).not.toHaveBeenCalled();
    expect(rt.value.sessionManager.appendCompaction).not.toHaveBeenCalled();
  });

  it("fails when no compaction hook is registered", async () => {
    const rt = runtime({ extensionRunner: { hasHandlers: vi.fn(() => false), emit: vi.fn() } });

    await expect(applyOmCompactionToSession(rt.value as any, { prepareCompaction: () => preparation })).rejects.toThrow("observational memory did not provide compaction");
  });

  it("fails when the hook does not return OM folded details", async () => {
    const rt = runtime({
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => ({ compaction: { summary: "native", firstKeptEntryId: "entry-1", tokensBefore: 123, details: { readFiles: [] } } })),
      },
    });

    await expect(applyOmCompactionToSession(rt.value as any, { prepareCompaction: () => preparation })).rejects.toThrow("observational memory did not provide compaction");
  });

  it("fails when the hook cancels", async () => {
    const rt = runtime({
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => ({ cancel: true })) },
    });

    await expect(applyOmCompactionToSession(rt.value as any, { prepareCompaction: () => preparation })).rejects.toThrow("cancelled");
  });

  it("runs native extension compaction against a copied session file", async () => {
    const cwd = tempDir("om-compact-cwd");
    process.env.PI_CODING_AGENT_DIR = tempDir("om-compact-agent");
    const extensionsDir = join(cwd, ".pi", "extensions");
    mkdirSync(extensionsDir, { recursive: true });
    const fakeOmPath = join(cwd, "fake-om.ts");
    const sideEffectPath = join(cwd, "side-effect-loaded");
    writeFileSync(join(extensionsDir, "fake-swop.ts"), `
      import { writeFileSync } from "node:fs";
      export default function fakeSwop() {
        writeFileSync(${JSON.stringify(sideEffectPath)}, "loaded");
      }
    `);
    writeFileSync(fakeOmPath, `
      export default function fakeOm(pi) {
        pi.on("session_before_compact", async (event) => ({

          compaction: {
            summary: "Fake OM summary",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: { type: "om.folded", reflections: [{ id: "ref_111111111111", content: "Kept.", sources: [] }] },
          },
        }));
      }
    `);
    const sessionPath = join(cwd, "fork.jsonl");
    const entries = [
      { type: "session", version: 3, id: "session-1", timestamp: "2026-06-21T00:00:00.000Z", cwd },
      { type: "message", id: "entry-1", parentId: null, timestamp: "2026-06-21T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "old" }], timestamp: Date.now() } },
      { type: "message", id: "entry-2", parentId: "entry-1", timestamp: "2026-06-21T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now() } },
    ];
    writeFileSync(sessionPath, `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`);

    await compactForkSessionWithOmInSubprocess({ cwd, sessionPath, omExtensionPath: fakeOmPath });

    expect(() => readFileSync(sideEffectPath, "utf-8")).toThrow();
    const compacted = readFileSync(sessionPath, "utf-8");
    expect(compacted).toContain("Fake OM summary");
    expect(compacted).toContain('"fromHook":true');
    expect(compacted).toContain('"type":"om.folded"');
  });
});
