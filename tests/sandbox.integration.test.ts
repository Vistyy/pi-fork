import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSandboxedCommand } from "../src/sandbox.js";

const hasBwrap = (() => {
  try {
    execSync("command -v bwrap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function runInSandbox(command: string): string {
  return execSync(buildSandboxedCommand(command), {
    encoding: "utf-8",
    env: {
      ...process.env,
      SHOULD_NOT_LEAK_TO_SANDBOX: "secret-value",
    },
  }).trim();
}

describe.skipIf(!hasBwrap)("sandbox integration", () => {
  it("allows repo reads and /tmp writes", () => {
    const out = runInSandbox("test -f package.json && touch /tmp/sandbox-ok && echo ok");

    expect(out).toBe("ok");
  });

  it("blocks repo writes", () => {
    expect(() => runInSandbox("touch SHOULD_FAIL")).toThrow(/Read-only file system/);
  });

  it("clears inherited environment", () => {
    const out = runInSandbox("printenv SHOULD_NOT_LEAK_TO_SANDBOX || true");

    expect(out).toBe("");
  });

  it("blocks shell network", () => {
    const out = runInSandbox("curl -fsS --max-time 2 https://example.com >/dev/null 2>&1 || echo blocked");

    expect(out).toBe("blocked");
  });
});
