import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MessageTraceRecord, ToolCallRecord } from '../lib/pi.js';
import type { Effort, ForkCall, ForkEvalCase } from './types.js';

export function repoRoot(): string {
  return path.basename(process.cwd()) === 'eval' ? path.resolve(process.cwd(), '..') : process.cwd();
}

type ForkToolText = {
  taskDescription: string;
  effortDescription: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
};

export function loadForkToolText(): ForkToolText {
  const toolPath = path.join(repoRoot(), 'src/tool.ts');
  const source = fs.readFileSync(toolPath, 'utf8');
  const match = source.match(/export const FORK_TOOL_TEXT = (\{[\s\S]*?\n\}) as const;/);
  if (!match?.[1]) throw new Error(`failed to extract FORK_TOOL_TEXT from ${toolPath}`);
  return Function(`\"use strict\"; return (${match[1]});`)() as ForkToolText;
}

export const FORK_TOOL_TEXT = loadForkToolText();

export function callArgs(call: ToolCallRecord): ForkCall {
  const args = call.args as { task?: unknown; effort?: unknown } | undefined;
  return {
    task: typeof args?.task === 'string' ? args.task : undefined,
    effort: typeof args?.effort === 'string' ? args.effort : undefined,
    result: call.result,
    isError: call.isError,
  };
}

export function formatTraceForDiagnosis(trace: MessageTraceRecord[] | undefined): string {
  const thinking = (trace ?? []).filter((entry) => entry.type === 'thinking_delta').map((entry) => entry.delta ?? '').join('').trim();
  return thinking || '(no visible thinking text captured)';
}

export function makeFailureDiagnosisPrompt(testCase: ForkEvalCase, snapshot: { toolCalls: ToolCallRecord[]; messageTrace: MessageTraceRecord[]; activeToolNames?: string[] }): string | undefined {
  const forkCalls = snapshot.toolCalls.filter((call) => call.toolName === 'fork');
  const actualEfforts = forkCalls.map((call) => {
    const args = call.args as { effort?: unknown } | undefined;
    return typeof args?.effort === 'string' ? args.effort : 'omitted';
  });
  const expected = testCase.expectedEfforts;
  const countMismatch = forkCalls.length !== expected.length;
  const effortMismatch = !countMismatch && expected.some((effort, index) => {
    const options = Array.isArray(effort) ? effort : [effort];
    return !options.includes(actualEfforts[index] as Effort);
  });
  if (!countMismatch && !effortMismatch) return undefined;

  const calls = snapshot.toolCalls.map((call) => ({ toolName: call.toolName, args: call.args, isError: call.isError }));
  const mismatch = countMismatch
    ? `Expected ${expected.length} fork call(s), but you made ${forkCalls.length}.`
    : `Expected fork effort(s) ${JSON.stringify(expected)}, but you chose ${JSON.stringify(actualEfforts)}.`;
  const focus = forkCalls.length === 0
    ? 'Why did direct parent tool work feel like the right first move instead of calling fork?'
    : countMismatch
      ? 'Why did you combine/split the work this way instead of matching the expected number of bounded fork subtasks?'
      : 'Why did that effort level feel right? What instruction or wording would have made the expected effort more natural?';

  return `We are debugging fork tool-selection behavior in an eval. This is not an accusation; treat it as an investigation into what instruction or context shaped your choice.

Original user request:
${testCase.prompt}

Mismatch:
${mismatch}

Active tools:
${JSON.stringify(snapshot.activeToolNames ?? [], null, 2)}

Fork guidance excerpt:
- ${FORK_TOOL_TEXT.promptSnippet}
${FORK_TOOL_TEXT.promptGuidelines.map((guideline) => `- ${guideline}`).join('\n')}

effort parameter description:
${FORK_TOOL_TEXT.effortDescription}

Tool calls you actually made before this diagnostic prompt:
${JSON.stringify(calls, null, 2)}

Visible thinking captured before this diagnostic prompt:
${formatTraceForDiagnosis(snapshot.messageTrace)}

Please analyze the decision. ${focus} Was fork inapplicable, less useful, unclear, insufficiently salient, or did the labels/guidance imply your choice?

Answer as a concise debugging report, not as an apology.`;
}

export function makeMockForkTool(results: string[], error = false): ToolDefinition {
  let index = 0;
  return defineTool({
    name: 'fork',
    label: 'Fork',
    description: FORK_TOOL_TEXT.description,
    promptSnippet: FORK_TOOL_TEXT.promptSnippet,
    promptGuidelines: [...FORK_TOOL_TEXT.promptGuidelines],
    parameters: Type.Object({
      task: Type.String({ description: FORK_TOOL_TEXT.taskDescription }),
      effort: Type.Optional(Type.Union([Type.Literal('fast'), Type.Literal('balanced'), Type.Literal('deep')], { description: FORK_TOOL_TEXT.effortDescription })),
    }),
    async execute(_toolCallId, params) {
      const text = results[index++] ?? `Mock fork finding for task: ${params.task}`;
      if (error) {
        return { content: [{ type: 'text' as const, text: `Fork failed: ${text}` }], isError: true, details: { mock: true } };
      }
      return { content: [{ type: 'text' as const, text }], details: { mock: true } };
    },
  });
}

