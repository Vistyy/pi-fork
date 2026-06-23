import path from 'node:path';
import { runPiSdk } from '../lib/pi.js';
import { runJudge } from '../lib/judge.js';
import type { TokenUsage } from '../lib/types.js';
import type { Args, Effort, ExpectedEffort, ForkCall, ForkEvalCase, ForkEvalRecord } from './types.js';
import { callArgs, makeFailureDiagnosisPrompt, makeMockForkTool, repoRoot } from './tool.js';

export function formatExpectedEffort(expected: ExpectedEffort): string {
  return Array.isArray(expected) ? expected.join('/') : expected;
}

export function compareEfforts(expected: ExpectedEffort[], calls: ForkCall[]): string[] {
  const failures: string[] = [];
  if (calls.length !== expected.length) failures.push(`expected ${expected.length} fork calls, got ${calls.length}`);
  const n = Math.min(expected.length, calls.length);
  for (let i = 0; i < n; i += 1) {
    const options = Array.isArray(expected[i]) ? expected[i] : [expected[i]];
    if (!options.includes(calls[i]?.effort as Effort)) failures.push(`call ${i + 1}: expected effort ${formatExpectedEffort(expected[i])}, got ${calls[i]?.effort ?? 'omitted'}`);
  }
  return failures;
}

export async function judgeCase(testCase: ForkEvalCase, calls: ForkCall[], answer: string, judgeModel: string) {
  if (!testCase.judge) return undefined;
  const payload = JSON.stringify({
    seedMessages: testCase.seedMessages ?? [],
    prompt: testCase.prompt,
    forkCalls: calls,
    finalAnswer: answer,
  }, null, 2);
  return runJudge(testCase.judge, payload, judgeModel);
}

export async function runMockCase(testCase: ForkEvalCase, args: Args): Promise<ForkEvalRecord> {
  const tool = makeMockForkTool(testCase.mockResults ?? [], testCase.mockError);
  const run = await runPiSdk(testCase.prompt, {
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    cwd: repoRoot(),
    customTools: [tool],
    allowedTools: ['read', 'bash', 'edit', 'write', 'fork'],
    seedMessages: testCase.seedMessages,
    maxAgentTurns: args.maxAgentTurns ?? testCase.maxAgentTurns ?? (testCase.mockError ? 2 : 1),
    timeoutMs: args.timeoutMs,
    sameSessionDiagnostic: args.diagnoseFailures ? (snapshot) => makeFailureDiagnosisPrompt(testCase, snapshot) : undefined,
  });
  const allToolCalls = (run.toolCalls ?? []).map((call) => ({ toolName: call.toolName, args: call.args, isError: call.isError }));
  const calls = (run.toolCalls ?? []).filter((call) => call.toolName === 'fork').map(callArgs);
  const failures = compareEfforts(testCase.expectedEfforts, calls);
  const judged = failures.length || !args.judge ? undefined : await judgeCase(testCase, calls, run.stdout.trim(), args.judgeModel);
  if (judged && (judged.run.status !== 0 || !judged.judge.passed)) failures.push(`judge failed: ${judged.judge.reason}`);
  if (run.status !== 0) failures.push(`runtime failed: ${run.stderr}`);
  return { id: testCase.id, prompt: testCase.prompt, expectedEfforts: testCase.expectedEfforts, activeToolNames: run.activeToolNames, calls, allToolCalls, messageTrace: run.messageTrace, passed: failures.length === 0, durationMs: run.durationMs, answer: run.stdout.trim(), stderr: run.stderr, usage: run.usage, judge: judged?.judge, judgeUsage: judged?.run.usage, diagnosis: run.diagnosticAnswer, diagnosisUsage: run.diagnosticUsage, failures };
}

export async function runRealSmoke(args: Args): Promise<ForkEvalRecord> {
  const prompt = 'can you sanity check one small thing in the repo independently and tell me if fork is actually usable now, not a whole big review';
  const run = await runPiSdk(prompt, {
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    cwd: repoRoot(),
    extensionPaths: [path.join(repoRoot(), 'index.ts')],
    allowedTools: ['fork'],
    maxAgentTurns: args.maxAgentTurns ?? 2,
    timeoutMs: args.timeoutMs,
  });
  const calls = (run.toolCalls ?? []).filter((call) => call.toolName === 'fork').map(callArgs);
  const failures = calls.length === 1 ? [] : [`expected 1 real fork call, got ${calls.length}`];
  if (calls[0]?.isError) failures.push('real fork tool ended with isError=true');
  if (!calls[0]?.result) failures.push('real fork tool produced no captured result');
  if (run.status !== 0) failures.push(`runtime failed: ${run.stderr}`);
  return { id: 'real-smoke', prompt, expectedEfforts: [], activeToolNames: run.activeToolNames, calls, messageTrace: run.messageTrace, passed: failures.length === 0, durationMs: run.durationMs, answer: run.stdout.trim(), stderr: run.stderr, usage: run.usage, failures };
}

export function summarize(records: ForkEvalRecord[]) {
  const passed = records.filter((r) => r.passed).length;
  return {
    passed: passed === records.length,
    total: records.length,
    passedCount: passed,
    failed: records.filter((r) => !r.passed).map((r) => ({ id: r.id, failures: r.failures, calls: r.calls })),
    usage: records.reduce<TokenUsage>((acc, r) => ({
      input: (acc.input ?? 0) + (r.usage?.input ?? 0) + (r.judgeUsage?.input ?? 0),
      output: (acc.output ?? 0) + (r.usage?.output ?? 0) + (r.judgeUsage?.output ?? 0),
      cacheRead: (acc.cacheRead ?? 0) + (r.usage?.cacheRead ?? 0) + (r.judgeUsage?.cacheRead ?? 0),
      cacheWrite: (acc.cacheWrite ?? 0) + (r.usage?.cacheWrite ?? 0) + (r.judgeUsage?.cacheWrite ?? 0),
      totalTokens: (acc.totalTokens ?? 0) + (r.usage?.totalTokens ?? 0) + (r.judgeUsage?.totalTokens ?? 0),
    }), {}),
  };
}

