import fs from 'node:fs';
import path from 'node:path';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { DEFAULT_MODEL } from '../lib/pi.js';
import type { Args, ForkEvalRecord } from './types.js';
import { cases } from './cases/index.js';
import { runMockCase, runRealSmoke, summarize } from './runner.js';

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  return {
    model: get('--model', DEFAULT_MODEL)!,
    judgeModel: get('--judge-model', get('--model', DEFAULT_MODEL))!,
    outDir: get('--out', path.join('runs', `fork-agent-evals-${Date.now()}`))!,
    thinkingLevel: (get('--thinking', 'low') ?? 'low') as ModelThinkingLevel,
    realSmoke: args.includes('--real-smoke'),
    caseId: get('--case'),
    all: args.includes('--all'),
    judge: args.includes('--judge'),
    timeoutMs: Number(get('--timeout-ms', '30000')),
    maxAgentTurns: get('--max-agent-turns') ? Number(get('--max-agent-turns')) : undefined,
    diagnoseFailures: !args.includes('--no-diagnose-failures'),
  };
}

export async function main() {
  const args = parseArgs();
  fs.mkdirSync(args.outDir, { recursive: true });
  const selectedCases = args.caseId ? cases.filter((testCase) => testCase.id === args.caseId) : args.all ? cases : cases.slice(0, 1);
  if (args.caseId && selectedCases.length === 0) throw new Error(`unknown case: ${args.caseId}`);
  if (!args.caseId && !args.all) {
    console.error('No --case or --all supplied; running first case only. Use --all for the full mock suite.');
  }
  const records: ForkEvalRecord[] = [];
  for (const testCase of selectedCases) records.push(await runMockCase(testCase, args));
  if (args.realSmoke) records.push(await runRealSmoke(args));
  fs.writeFileSync(path.join(args.outDir, 'results.json'), JSON.stringify(records, null, 2));
  const summary = summarize(records);
  fs.writeFileSync(path.join(args.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exitCode = 1;
}
