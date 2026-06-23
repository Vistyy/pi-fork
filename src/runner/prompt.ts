import type { ForkEffort } from "../core/types.js";
import { balancedPrompt, deepPrompt, fastPrompt } from "./prompts/index.js";

export interface ForkPromptOptions {
  writableTmpDir?: string;
}

function appendForkChildContext(prompt: string): string {
  return `${prompt}
Fork child context:
- You are the forked child agent, not the main session.
- The parent agent delegated this bounded task to you and is waiting for your report.
- Do not continue the parent session's broader work.
- Do not spawn another fork. Forking inside a fork is not allowed.
- Return findings, evidence, caveats, and next steps for the parent to act on.
`;
}

function appendRuntimeNotes(prompt: string, options: ForkPromptOptions): string {
  if (!options.writableTmpDir) return prompt;
  return `${prompt}
Runtime note:
- If you need scratch files, downloads, clones, or quick experiments, use the writable temp directory: ${options.writableTmpDir}.
`;
}

export function buildForkTaskPrompt(
  task: string,
  effort: ForkEffort = "balanced",
  options: ForkPromptOptions = {},
): string {
  const prompt = effort === "fast"
    ? fastPrompt(task)
    : effort === "deep"
      ? deepPrompt(task)
      : balancedPrompt(task);
  return appendRuntimeNotes(appendForkChildContext(prompt), options);
}
