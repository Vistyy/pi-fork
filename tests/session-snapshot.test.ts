import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildForkSessionSnapshotJsonl, writeForkSessionSnapshotJsonl } from "../src/session-snapshot.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-fork-snapshot-"));
  tempDirs.push(dir);
  return join(dir, "fork.jsonl");
}

const header = { type: "session", id: "session-1" };

function message(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "2026-06-21T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } };
}

function session(entries: unknown[]) {
  return { getHeader: () => header, getBranch: () => entries };
}

function lines(jsonl: string): any[] {
  return jsonl.trim().split("\n").map((line) => JSON.parse(line));
}

describe("fork session snapshots", () => {
  it("copies the full active branch", () => {
    const entries = [message("raw-1", "one"), message("raw-2", "two")];

    const snapshot = buildForkSessionSnapshotJsonl(session(entries));

    expect(lines(snapshot ?? "")).toEqual([header, ...entries]);
  });

  it("writes the full active branch directly to a file", () => {
    const entries = [message("raw-1", "one"), message("raw-2", "two")];
    const filePath = tempPath();

    expect(writeForkSessionSnapshotJsonl(session(entries), filePath)).toBe(true);

    expect(lines(readFileSync(filePath, "utf-8"))).toEqual([header, ...entries]);
  });

  it("returns null when the session header is unavailable", () => {
    expect(buildForkSessionSnapshotJsonl({ getHeader: () => null, getBranch: () => [] })).toBeNull();
  });

  it("does not write a file when the session header is unavailable", () => {
    const filePath = tempPath();

    expect(writeForkSessionSnapshotJsonl({ getHeader: () => null, getBranch: () => [] }, filePath)).toBe(false);
  });
});
