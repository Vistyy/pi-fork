import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { DEFAULT_MODEL } from '../lib/pi.js';
import type { PromptArgs } from './prompt-types.js';
import { promptCases } from './cases/prompt.js';
import { addUsage, runPromptCase } from './prompt-runner.js';
import type { TokenUsage } from '../lib/types.js';

function parseArgs(): PromptArgs {
  const args = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  return {
    model: get('--model', DEFAULT_MODEL)!,
    judgeModel: get('--judge-model', get('--model', DEFAULT_MODEL))!,
    thinkingLevel: get('--thinking', 'low')!,
    timeoutMs: Number(get('--timeout-ms', '60000')),
    caseId: get('--case'),
    extended: args.includes('--extended'),
  };
}

export async function main(): Promise<void> {
  const args = parseArgs();
  const selectedCases = args.caseId
    ? promptCases.filter((testCase) => testCase.id === args.caseId)
    : promptCases.filter((testCase) => args.extended || testCase.tier === 'smoke');
  if (args.caseId && selectedCases.length === 0) throw new Error(`unknown case: ${args.caseId}`);
  const results = [];
  for (const testCase of selectedCases) results.push(await runPromptCase(testCase, args));
  const passedCount = results.filter((result) => result.passed).length;
  const usage = results.reduce<TokenUsage>((total, result) => addUsage(addUsage(total, result.usage), result.judgeUsage), {});
  console.log(JSON.stringify({
    passed: passedCount === results.length,
    total: results.length,
    passedCount,
    mode: args.caseId ? 'case' : (args.extended ? 'extended' : 'smoke'),
    failed: results.filter((result) => !result.passed).map((result) => ({ id: result.id, failures: result.failures, judge: result.judge })),
    results,
    usage,
  }, null, 2));
  if (passedCount !== results.length) process.exitCode = 1;
}
