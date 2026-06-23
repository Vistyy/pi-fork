import path from 'node:path';
import { runPiSdk } from '../lib/pi.js';
import { runJudge } from '../lib/judge.js';
import type { JudgeResult, Probe, TokenUsage } from '../lib/types.js';
import type { Effort, PromptArgs, PromptCase } from './prompt-types.js';

export function repoRoot(): string {
  return path.basename(process.cwd()) === 'eval' ? path.resolve(process.cwd(), '..') : process.cwd();
}

export async function buildForkPrompt(task: string, effort: Effort): Promise<string> {
  const mod = await import(path.join(repoRoot(), 'src/runner/prompt.ts')) as { buildForkTaskPrompt: (task: string, effort: Effort) => string };
  return mod.buildForkTaskPrompt(task, effort);
}

export function promptProbe(testCase: PromptCase): Probe {
  return {
    id: `fork-prompt-${testCase.id}`,
    question: `Did the fork child prompt produce appropriate behavior for this delegated task?`,
    rubric: { pass_if: testCase.passIf, fail_if: testCase.failIf ?? [] },
  };
}

export function deterministicFailures(testCase: PromptCase, answer: string, usage?: TokenUsage): string[] {
  const failures: string[] = [];
  if (!answer.trim()) failures.push('empty answer');
  if (/\b(modified|edited|committed|wrote|updated)\b/i.test(answer) && /do not modify files/i.test(testCase.task)) {
    failures.push('answer claims file modification despite do-not-modify task');
  }
  if (testCase.effort === 'fast' && answer.length > 2000) failures.push(`fast answer too long: ${answer.length} chars`);
  const totalTokens = usage?.totalTokens ?? 0;
  if (testCase.tier === 'smoke' && testCase.maxTotalTokens && totalTokens > testCase.maxTotalTokens) {
    failures.push(`token budget exceeded: ${totalTokens} > ${testCase.maxTotalTokens}`);
  }
  return failures;
}

const skippedJudge: JudgeResult = { passed: false, reason: 'skipped due to deterministic failure', missing: [], incorrect: [] };

export async function runPromptCase(testCase: PromptCase, args: PromptArgs) {
  const prompt = await buildForkPrompt(testCase.task, testCase.effort);
  const run = await runPiSdk(prompt, {
    model: args.model,
    thinkingLevel: args.thinkingLevel as any,
    cwd: repoRoot(),
    allowedTools: testCase.allowedTools ?? ['read'],
    maxAgentTurns: testCase.maxAgentTurns ?? 4,
    timeoutMs: args.timeoutMs,
  });
  const answer = run.stdout.trim();
  const deterministic = deterministicFailures(testCase, answer, run.usage);
  const judged = deterministic.length ? undefined : await runJudge(promptProbe(testCase), JSON.stringify({ task: testCase.task, answer }, null, 2), args.judgeModel);
  const failures = [
    ...(run.status === 0 ? [] : [`runtime failed: ${run.stderr}`]),
    ...deterministic,
    ...(judged && judged.run.status !== 0 ? [`judge runtime failed: ${judged.run.stderr}`] : []),
    ...(judged && !judged.judge.passed ? [`judge failed: ${judged.judge.reason}`] : []),
  ];
  return {
    id: testCase.id,
    tier: testCase.tier,
    effort: testCase.effort,
    passed: run.status === 0 && failures.length === 0,
    answer: answer.slice(0, 800),
    judge: judged?.judge ?? skippedJudge,
    usage: run.usage,
    judgeUsage: judged?.run.usage,
    failures,
  };
}

export function addUsage(total: TokenUsage, usage?: TokenUsage): TokenUsage {
  return {
    input: (total.input ?? 0) + (usage?.input ?? 0),
    output: (total.output ?? 0) + (usage?.output ?? 0),
    cacheRead: (total.cacheRead ?? 0) + (usage?.cacheRead ?? 0),
    cacheWrite: (total.cacheWrite ?? 0) + (usage?.cacheWrite ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (usage?.totalTokens ?? 0),
  };
}

