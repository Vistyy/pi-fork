import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRunFork = vi.hoisted(() => vi.fn());

vi.mock("../src/runner/index.js", () => ({ runFork: mockRunFork }));
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return { ...actual, loadConfig: () => ({ extensions: [], environment: {}, tools: null, offline: true, costFooter: true, sessionSnapshot: "full", defaultEffort: "balanced" }) };
});

import { PI_FORK_CHILD_ENV } from "../src/runner/env.js";
import { PI_USAGE_RECORDED } from "../src/usage.js";
import { registerForkTool } from "../src/tool.js";

let originalForkChildEnv: string | undefined;

beforeEach(() => {
  originalForkChildEnv = process.env[PI_FORK_CHILD_ENV];
  delete process.env[PI_FORK_CHILD_ENV];
});

afterEach(() => {
  if (originalForkChildEnv === undefined) delete process.env[PI_FORK_CHILD_ENV];
  else process.env[PI_FORK_CHILD_ENV] = originalForkChildEnv;
});

describe("fork tool registration", () => {
  it("does not register inside a fork child process", () => {
    process.env[PI_FORK_CHILD_ENV] = "1";
    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
    } as any;

    registerForkTool(pi);

    expect(pi.registerTool).not.toHaveBeenCalled();
  });
});

describe("fork tool usage recording", () => {
  it("records generic usage with effort tag", async () => {
    let execute: any;
    const appendEntry = vi.fn();
    const pi = {
      appendEntry,
      registerTool: vi.fn((tool) => { execute = tool.execute; }),
    } as any;
    registerForkTool(pi);
    mockRunFork.mockResolvedValueOnce({
      task: "investigate",
      exitCode: 0,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      stderr: "",
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.25, contextTokens: 20, turns: 1 },
      provider: "anthropic",
      model: "claude",
      stopReason: "stop",
      sawAgentEnd: true,
      effort: { selected: "deep", source: "tool" },
    });

    await execute("call-1", { task: "investigate", effort: "deep" }, undefined, undefined, {
      cwd: "/tmp/project",
      modelRegistry: { find: vi.fn() },
      sessionManager: { getHeader: () => ({ type: "header" }), getBranch: () => [] },
    });

    expect(mockRunFork).toHaveBeenCalledWith(expect.objectContaining({
      sessionSnapshot: "full",
      writeForkSessionSnapshot: expect.any(Function),
    }));
    expect(mockRunFork.mock.calls[0]?.[0]).not.toHaveProperty("forkSessionSnapshotJsonl");
    expect(appendEntry).toHaveBeenCalledWith(PI_USAGE_RECORDED, expect.objectContaining({
      extension: "fork",
      agent: "child-agent",
      operation: "fork",
      tags: { effort: "deep" },
      usage: expect.objectContaining({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: 0.25 }),
    }));
  });
});
