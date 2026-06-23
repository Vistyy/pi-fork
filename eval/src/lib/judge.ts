import type { JudgeResult, Probe } from './types.js';
import { DEFAULT_MODEL, runPiSdk } from './pi.js';

export const MINIMAL_JUDGE_SYSTEM_PROMPT = 'Strict evaluator. Return only valid JSON.';

export function judgePrompt(probe: Probe, answer: string): string {
  const passIf = probe.rubric?.pass_if ?? [];
  const failIf = probe.rubric?.fail_if ?? [];
  return `Judge strictly but semantically. Do not require exact wording.\nPassing requires every Pass if item. Any Fail if item means failed.\n\nQuestion:\n${probe.question}\n\nAnswer:\n${answer}\n\nPass if:\n${passIf.map((x) => `- ${x}`).join('\n')}\n\nFail if:\n${failIf.map((x) => `- ${x}`).join('\n')}\n\nReturn JSON only:\n{"passed": boolean, "reason": string, "missing": string[], "incorrect": string[]}`;
}

export function parseJudgeJson(text: string): JudgeResult {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge returned no JSON: ${text}`);
  return JSON.parse(m[0]) as JudgeResult;
}

export async function runJudge(probe: Probe, answer: string, model = DEFAULT_MODEL) {
  const run = await runPiSdk(judgePrompt(probe, answer), { model, systemPrompt: MINIMAL_JUDGE_SYSTEM_PROMPT });
  try { return { run, judge: parseJudgeJson(run.stdout) }; }
  catch (e) {
    return { run, judge: { passed: false, reason: String(e), missing: [], incorrect: ['judge_parse_error'] } satisfies JudgeResult };
  }
}
