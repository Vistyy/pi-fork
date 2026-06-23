import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

const tempDirs: string[] = [];

function tempDir(name: string): string {
  const dir = join(tmpdir(), `pi-fork-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("defaults to no child extensions", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    expect(loadConfig(cwd).extensions).toEqual([]);
    expect(loadConfig(cwd).tools).toBeNull();
    expect(loadConfig(cwd).sessionSnapshot).toBe("full");
    expect(loadConfig(cwd).sandbox).toEqual({
      bashNetwork: false,
      tmpDir: "/tmp",
    });
    expect(DEFAULT_CONFIG.extensions).toEqual([]);
  });

  it("preserves explicit null for normal Pi extension discovery", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(agentDir, "settings.json"), { "pi-fork": { extensions: null } });

    expect(loadConfig(cwd).extensions).toBeNull();
  });

  it("resolves child extension paths relative to the settings file", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    const projectSettingsDir = join(cwd, ".pi");
    mkdirSync(projectSettingsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(projectSettingsDir, "settings.json"), {
      "pi-fork": { extensions: ["./child-extension", "npm:pkg"] },
    });

    expect(loadConfig(cwd).extensions).toEqual([
      join(projectSettingsDir, "child-extension"),
      "npm:pkg",
    ]);
  });

  it("loads explicit child tool allowlist", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(agentDir, "settings.json"), {
      "pi-fork": { tools: "read,bash,grep,find,ls,web_search,web_fetch,web_content_get" },
    });

    expect(loadConfig(cwd).tools).toBe("read,bash,grep,find,ls,web_search,web_fetch,web_content_get");
  });

  it("normalizes child tool allowlist whitespace", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(agentDir, "settings.json"), {
      "pi-fork": { tools: " read, bash, web_fetch " },
    });

    expect(loadConfig(cwd).tools).toBe("read,bash,web_fetch");
  });

  it("ignores malformed child tool allowlists", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(agentDir, "settings.json"), {
      "pi-fork": { tools: "read,bash,../bad" },
    });

    expect(loadConfig(cwd).tools).toBeNull();
  });

  it("loads compact session snapshot settings", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(agentDir, "settings.json"), {
      "pi-fork": { sessionSnapshot: "om-compact", omCompactExtension: "./extensions/pi-observational-memory/index.ts" },
    });

    expect(loadConfig(cwd).sessionSnapshot).toBe("om-compact");
    expect(loadConfig(cwd).omCompactExtension).toBe(join(agentDir, "extensions/pi-observational-memory/index.ts"));
  });

  it("ignores invalid compact session snapshot settings", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(agentDir, "settings.json"), {
      "pi-fork": { sessionSnapshot: "bad" },
    });

    expect(loadConfig(cwd).sessionSnapshot).toBe("full");
  });

  it("merges environment with project values overriding global values", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    const projectSettingsDir = join(cwd, ".pi");
    mkdirSync(projectSettingsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(agentDir, "settings.json"), {
      "pi-fork": { environment: { A: "global", B: "global" } },
    });
    writeJson(join(projectSettingsDir, "settings.json"), {
      "pi-fork": { environment: { B: "project", C: "project" } },
    });

    expect(loadConfig(cwd).environment).toEqual({ A: "global", B: "project", C: "project" });
  });

  it("merges sandbox config separately from offline mode", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    const projectSettingsDir = join(cwd, ".pi");
    mkdirSync(projectSettingsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(agentDir, "settings.json"), {
      "pi-fork": { offline: true, sandbox: { bashNetwork: true, tmpDir: "/tmp/global" } },
    });
    writeJson(join(projectSettingsDir, "settings.json"), {
      "pi-fork": { sandbox: { tmpDir: "/tmp/project" } },
    });

    expect(loadConfig(cwd).offline).toBe(true);
    expect(loadConfig(cwd).sandbox).toEqual({
      bashNetwork: true,
      tmpDir: "/tmp/project",
    });
  });

  it("ignores sandbox tmp dirs outside /tmp and /var/tmp", () => {
    const cwd = tempDir("cwd");
    const agentDir = tempDir("agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(join(agentDir, "settings.json"), {
      "pi-fork": { sandbox: { tmpDir: "/home/user/scratch" } },
    });

    expect(loadConfig(cwd).sandbox.tmpDir).toBe("/tmp");
  });
});
