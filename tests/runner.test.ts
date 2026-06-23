import { describe, expect, it } from "vitest";
import { buildPiArgs } from "../src/runner/index.js";

const inherited = {
  alwaysProxy: [],
  fallbackModel: undefined,
  fallbackThinking: undefined,
  fallbackTools: undefined,
  fallbackNoTools: false,
};

describe("buildPiArgs", () => {
  it("disables child extensions by default when extensions is an array", () => {
    expect(buildPiArgs("task", "/tmp/session.jsonl", [], undefined, inherited)).toContain("--no-extensions");
  });

  it("preserves normal Pi extension discovery for explicit null", () => {
    expect(buildPiArgs("task", "/tmp/session.jsonl", null, undefined, inherited)).not.toContain("--no-extensions");
  });

  it("allowlists explicit child extensions", () => {
    const args = buildPiArgs("task", "/tmp/session.jsonl", ["/x/ext"], undefined, inherited);
    expect(args).toEqual(expect.arrayContaining(["--no-extensions", "--extension", "/x/ext"]));
  });

  it("uses configured child tools before inherited tools", () => {
    const args = buildPiArgs("task", "/tmp/session.jsonl", [], undefined, {
      ...inherited,
      fallbackTools: "read,bash,edit,write",
    }, undefined, "read,bash,grep,find,ls,web_search,web_fetch,web_content_get");

    expect(args).toEqual(expect.arrayContaining([
      "--tools", "read,bash,grep,find,ls,web_search,web_fetch,web_content_get",
    ]));
    expect(args).not.toEqual(expect.arrayContaining([
      "--tools", "read,bash,edit,write",
    ]));
  });

  it("supports configured no-tools", () => {
    const args = buildPiArgs("task", "/tmp/session.jsonl", [], undefined, inherited, undefined, "");
    expect(args).toContain("--no-tools");
  });

  it("applies effort profile model flags", () => {
    const args = buildPiArgs("task", "/tmp/session.jsonl", [], {
      provider: "openai-codex",
      id: "gpt-5.5",
      thinking: "high",
    }, inherited);

    expect(args).toEqual(expect.arrayContaining([
      "--provider", "openai-codex",
      "--model", "gpt-5.5",
      "--thinking", "high",
    ]));
  });

  it("tells the child it is the forked child", () => {
    const args = buildPiArgs("task", "/tmp/session.jsonl", [], undefined, inherited);

    expect(args.at(-1)).toContain("You are the forked child agent, not the main session.");
    expect(args.at(-1)).toContain("Do not spawn another fork. Forking inside a fork is not allowed.");
  });

  it("tells the child about the writable temp directory", () => {
    const args = buildPiArgs(
      "task",
      "/tmp/session.jsonl",
      [],
      undefined,
      inherited,
      undefined,
      undefined,
      { bashNetwork: false, tmpDir: "/tmp/pi-fork" },
    );

    expect(args.at(-1)).toContain("writable temp directory: /tmp/pi-fork");
  });
});
