import { describe, expect, it } from "vitest";
import { buildChildEnv, PI_FORK_CHILD_ENV } from "../src/runner/env.js";

describe("buildChildEnv", () => {
  it("marks spawned Pi processes as fork children", () => {
    const env = buildChildEnv({}, {}, "linux", true);

    expect(env[PI_FORK_CHILD_ENV]).toBe("1");
  });

  it("prevents configured environment from overriding the fork child marker", () => {
    const env = buildChildEnv({ [PI_FORK_CHILD_ENV]: "0" }, {}, "linux", true);

    expect(env[PI_FORK_CHILD_ENV]).toBe("1");
  });

  it("normalizes fork child marker casing on Windows", () => {
    const env = buildChildEnv({ pi_fork_child: "0" }, {}, "win32", true);

    expect(env[PI_FORK_CHILD_ENV]).toBe("1");
    expect(env.pi_fork_child).toBeUndefined();
  });
});
