import { describe, expect, it } from "vitest";
import { resolvePiSpawn } from "../src/runner/index.js";

describe("resolvePiSpawn", () => {
  it("spawns pi by default instead of guessing argv[1]", () => {
    const previous = process.env.PI_FORK_PI_COMMAND;
    delete process.env.PI_FORK_PI_COMMAND;
    try {
      expect(resolvePiSpawn()).toEqual({ command: "pi", prefixArgs: [] });
    } finally {
      if (previous === undefined) delete process.env.PI_FORK_PI_COMMAND;
      else process.env.PI_FORK_PI_COMMAND = previous;
    }
  });

  it("allows command override through PI_FORK_PI_COMMAND", () => {
    const previous = process.env.PI_FORK_PI_COMMAND;
    process.env.PI_FORK_PI_COMMAND = "/custom/pi";
    try {
      expect(resolvePiSpawn()).toEqual({ command: "/custom/pi", prefixArgs: [] });
    } finally {
      if (previous === undefined) delete process.env.PI_FORK_PI_COMMAND;
      else process.env.PI_FORK_PI_COMMAND = previous;
    }
  });
});
