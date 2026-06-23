import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { MessageTraceRecord } from '../lib/pi.js';
import type { Probe, TokenUsage } from '../lib/types.js';

export type Effort = 'fast' | 'balanced' | 'deep';
export type ExpectedEffort = Effort | Effort[];
export type SeedMessage = { role: 'user' | 'assistant'; content: string };
export type ForkCall = { task?: string; effort?: string; result?: unknown; isError?: boolean };

export type ForkEvalCase = {
  id: string;
  prompt: string;
  seedMessages?: SeedMessage[];
  expectedEfforts: ExpectedEffort[];
  mockResults?: string[];
  mockError?: boolean;
  judge?: Probe;
  maxAgentTurns?: number;
};

export type ForkEvalRecord = {
  id: string;
  prompt: string;
  expectedEfforts: ExpectedEffort[];
  activeToolNames?: string[];
  calls: ForkCall[];
  allToolCalls?: Array<{ toolName: string; args: unknown; isError?: boolean }>;
  messageTrace?: MessageTraceRecord[];
  passed: boolean;
  durationMs: number;
  answer: string;
  stderr: string;
  usage?: TokenUsage;
  judge?: unknown;
  judgeUsage?: TokenUsage;
  diagnosis?: string;
  diagnosisUsage?: TokenUsage;
  failures: string[];
};

export type Args = { model: string; judgeModel: string; outDir: string; thinkingLevel: ModelThinkingLevel; realSmoke: boolean; caseId?: string; all: boolean; judge: boolean; timeoutMs: number; maxAgentTurns?: number; diagnoseFailures: boolean };

