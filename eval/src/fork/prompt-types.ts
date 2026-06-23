import type { TokenUsage, Probe } from '../lib/types.js';

export type Effort = 'fast' | 'balanced' | 'deep';
export type Tier = 'smoke' | 'extended';

export type PromptCase = {
  id: string;
  tier: Tier;
  effort: Effort;
  task: string;
  passIf: string[];
  failIf?: string[];
  maxAgentTurns?: number;
  allowedTools?: string[];
  maxTotalTokens?: number;
};

export type PromptArgs = { model: string; judgeModel: string; thinkingLevel: string; timeoutMs: number; caseId?: string; extended: boolean };

