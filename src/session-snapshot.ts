import { closeSync, openSync, writeSync } from "node:fs";

export type ForkSessionSnapshotMode = "full" | "om-compact";

export interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

function stringifyEntry(entry: unknown): string {
  const serialized = JSON.stringify(entry);
  if (typeof serialized !== "string") {
    throw new Error("Cannot fork: session snapshot contains an unserializable entry.");
  }
  return serialized;
}

function writeJsonlEntry(fd: number, entry: unknown): void {
  writeSync(fd, stringifyEntry(entry));
  writeSync(fd, "\n");
}

function buildFullSnapshot(header: unknown, entries: unknown[]): string {
  let snapshot = `${stringifyEntry(header)}\n`;
  for (const entry of entries) snapshot += `${stringifyEntry(entry)}\n`;
  return snapshot;
}

export function buildForkSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  return buildFullSnapshot(header, sessionManager.getBranch());
}

export function writeForkSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
  filePath: string,
): boolean {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return false;

  const fd = openSync(filePath, "w", 0o600);
  try {
    writeJsonlEntry(fd, header);
    for (const entry of sessionManager.getBranch()) writeJsonlEntry(fd, entry);
    return true;
  } finally {
    closeSync(fd);
  }
}
