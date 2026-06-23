import fs from 'node:fs';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { TokenUsage } from './types.js';

export const DEFAULT_MODEL = 'openai-codex/gpt-5.4-mini';

function parseModelSpec(spec: string): [provider: string, id: string] {
  const [provider, ...rest] = spec.split('/');
  const id = rest.join('/');
  if (!provider || !id) throw new Error(`model must be provider/id, got: ${spec}`);
  return [provider, id];
}

function addUsage(a: TokenUsage, u?: TokenUsage): TokenUsage {
  if (!u) return a;
  return {
    input: (a.input ?? 0) + (u.input ?? 0),
    output: (a.output ?? 0) + (u.output ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (u.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (u.cacheWrite ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0))),
  };
}

function sumUsages(usages: TokenUsage[]): TokenUsage | undefined {
  return usages.length ? usages.reduce<TokenUsage>((acc, u) => addUsage(acc, u), {}) : undefined;
}

export type ToolCallRecord = { toolCallId: string; toolName: string; args: unknown; result?: unknown; isError?: boolean };
export type MessageTraceRecord = { type: string; phase: 'prep' | 'answer' | 'compaction'; contentIndex?: number; delta?: string; content?: unknown; toolCall?: unknown; messageContent?: unknown; stopReason?: string };

function extractTextContent(event: { content?: unknown }): string {
  const content = event.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'object' && block !== null) {
        const record = block as Record<string, unknown>;
        if (record.type === 'text' || record.type === 'message_content') return String(record.text ?? '');
      }
      return '';
    }).join('');
  }
  return '';
}

export type PiRunResult = { stdout: string; stderr: string; status: number; durationMs: number; usage?: TokenUsage; prepUsage?: TokenUsage; answerUsage?: TokenUsage; diagnosticUsage?: TokenUsage; compactionUsage?: TokenUsage; compaction?: unknown; toolCalls?: ToolCallRecord[]; messageTrace?: MessageTraceRecord[]; activeToolNames?: string[]; diagnosticAnswer?: string; diagnosticTrace?: MessageTraceRecord[] };

type RunPiSdkOptions = {
  model?: string;
  sessionFile?: string;
  stageFiles?: string[];
  cwd?: string;
  systemPrompt?: string;
  extensionPaths?: string[];
  compactBeforePrompt?: boolean;
  compactInstructions?: string;
  compactionSettings?: { keepRecentTokens?: number; reserveTokens?: number };
  allowedTools?: string[];
  prepareMemoryBeforeCompact?: boolean;
  memoryTriggerBeforeCompact?: boolean;
  memoryPrepareWaitMs?: number;
  memoryPrepareTurns?: number;
  waitAfterPromptMs?: number;
  thinkingLevel?: ModelThinkingLevel;
  customTools?: ToolDefinition[];
  seedMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxAgentTurns?: number;
  timeoutMs?: number;
  sameSessionDiagnostic?: (snapshot: { stdout: string; toolCalls: ToolCallRecord[]; messageTrace: MessageTraceRecord[]; activeToolNames?: string[] }) => string | undefined;
};

function appendSeedMessages(session: unknown, messages: Array<{ role: 'user' | 'assistant'; content: string }>): void {
  const manager = (session as { sessionManager?: { appendMessage?: (message: unknown) => void; buildSessionContext?: () => { messages: unknown[] } } }).sessionManager;
  if (!manager?.appendMessage) throw new Error('session manager does not support appendMessage');
  for (const message of messages) manager.appendMessage({ role: message.role, content: [{ type: 'text', text: message.content }] });
  const agent = (session as { agent?: { state?: { messages?: unknown[] } } }).agent;
  if (agent?.state && manager.buildSessionContext) agent.state.messages = manager.buildSessionContext().messages;
}

function appendStageFile(session: unknown, stageFile: string): void {
  const manager = (session as { sessionManager?: { appendMessage?: (message: unknown) => void; buildSessionContext?: () => { messages: unknown[] } } }).sessionManager;
  if (!manager?.appendMessage) throw new Error('session manager does not support appendMessage');
  for (const line of fs.readFileSync(stageFile, 'utf8').split(/\n+/)) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { type?: string; message?: unknown };
    if (entry.type === 'message') manager.appendMessage(entry.message);
  }
  const agent = (session as { agent?: { state?: { messages?: unknown[] } } }).agent;
  if (agent?.state && manager.buildSessionContext) agent.state.messages = manager.buildSessionContext().messages;
}

export async function runPiSdk(prompt: string, options: RunPiSdkOptions = {}): Promise<PiRunResult> {
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let prepUsage: TokenUsage | undefined;
  let answerUsage: TokenUsage | undefined;
  let compactionUsage: TokenUsage | undefined;
  let diagnosticUsage: TokenUsage | undefined;
  const toolCalls: ToolCallRecord[] = [];
  const messageTrace: MessageTraceRecord[] = [];
  const diagnosticTrace: MessageTraceRecord[] = [];
  let diagnosticAnswer = '';
  let capturePhase: 'prep' | 'answer' | 'compaction' | 'diagnostic' = 'answer';
  try {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const [provider, id] = parseModelSpec(options.model ?? DEFAULT_MODEL);
    const model = modelRegistry.find(provider, id);
    if (!model) throw new Error(`unknown model: ${provider}/${id}`);

    const cwd = options.cwd ?? process.cwd();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, ...options.compactionSettings } });
    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: options.extensionPaths ?? [],
      extensionsOverride: options.extensionPaths?.length ? undefined : (current) => ({ ...current, extensions: [], errors: [] }),
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      themesOverride: () => ({ themes: [], diagnostics: [] }),
      agentsFilesOverride: () => ({ agentsFiles: [], diagnostics: [] }),
      systemPrompt: options.systemPrompt,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: options.thinkingLevel ?? 'off',
      authStorage,
      modelRegistry,
      sessionManager: options.sessionFile ? SessionManager.open(options.sessionFile) : SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader: loader,
      noTools: options.allowedTools?.length || options.customTools?.length ? undefined : 'all',
      tools: options.allowedTools,
      customTools: options.customTools,
    });

    const agentWithStream = (session as unknown as { agent?: { streamFn?: (...args: unknown[]) => Promise<{ result: () => Promise<{ usage?: TokenUsage }> }> } }).agent;
    if (agentWithStream?.streamFn) {
      const originalStreamFn = agentWithStream.streamFn.bind(agentWithStream);
      agentWithStream.streamFn = async (...args: unknown[]) => {
        const stream = await originalStreamFn(...args);
        const originalResult = stream.result.bind(stream);
        stream.result = async () => {
          const result = await originalResult();
          if (capturePhase === 'prep') prepUsage = addUsage(prepUsage ?? {}, result.usage);
          if (capturePhase === 'compaction') compactionUsage = addUsage(compactionUsage ?? {}, result.usage);
          return result;
        };
        return stream;
      };
    }

    let agentTurns = 0;
    const timeout = options.timeoutMs ? setTimeout(() => { void session.abort(); }, options.timeoutMs) : undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
      }
      if (event.type === 'tool_execution_end') {
        const existing = toolCalls.find((call) => call.toolCallId === event.toolCallId);
        if (existing) {
          existing.result = event.result;
          existing.isError = event.isError;
        } else {
          toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: undefined, result: event.result, isError: event.isError });
        }
      }
      if (event.type === 'message_update') {
        const assistantEvent = event.assistantMessageEvent as { type: string; contentIndex?: number; delta?: string; content?: unknown; toolCall?: unknown };
        messageTrace.push({
          type: assistantEvent.type,
          phase: capturePhase === 'diagnostic' ? 'answer' : capturePhase,
          contentIndex: assistantEvent.contentIndex,
          delta: assistantEvent.delta,
          content: assistantEvent.content,
          toolCall: assistantEvent.toolCall,
        });
        if (capturePhase === 'diagnostic') diagnosticTrace.push({ type: assistantEvent.type, phase: 'answer', contentIndex: assistantEvent.contentIndex, delta: assistantEvent.delta, content: assistantEvent.content, toolCall: assistantEvent.toolCall });
        if (assistantEvent.type === 'text_delta') {
          if (capturePhase === 'diagnostic') diagnosticAnswer += assistantEvent.delta ?? '';
          else stdout += assistantEvent.delta ?? '';
        }
        if (assistantEvent.type === 'text' || assistantEvent.type === 'message_content') {
          const textContent = extractTextContent(assistantEvent as { content?: unknown });
          if (capturePhase === 'diagnostic') diagnosticAnswer += textContent;
          else stdout += textContent;
        }
      }
      if (event.type === 'turn_end') {
        agentTurns += 1;
        if (options.maxAgentTurns && agentTurns >= options.maxAgentTurns) {
          void session.abort();
        }
        const message = (event as unknown as { message?: { usage?: TokenUsage; content?: unknown; stopReason?: string } }).message;
        const turnTrace = { type: 'turn_end', phase: capturePhase === 'diagnostic' ? 'answer' as const : capturePhase, messageContent: message?.content, stopReason: message?.stopReason };
        messageTrace.push(turnTrace);
        if (capturePhase === 'diagnostic') diagnosticTrace.push(turnTrace);
        if (message?.usage && capturePhase === 'answer') answerUsage = addUsage(answerUsage ?? {}, message.usage);
        if (message?.usage && capturePhase === 'diagnostic') diagnosticUsage = addUsage(diagnosticUsage ?? {}, message.usage);
      }
      if (event.type === 'agent_end') {
        const messages = (event as unknown as { messages?: Array<{ role?: string; usage?: TokenUsage; content?: unknown }> }).messages ?? [];
        const usages = messages.map((m) => m.usage).filter((u): u is TokenUsage => Boolean(u));
        if (usages.length) {
          if (capturePhase === 'answer') answerUsage = addUsage(answerUsage ?? {}, sumUsages(usages));
          if (capturePhase === 'diagnostic') diagnosticUsage = addUsage(diagnosticUsage ?? {}, sumUsages(usages));
        }
        if (!stdout.trim() && capturePhase !== 'diagnostic') {
          for (const message of messages) {
            if (message.role === 'assistant') stdout = extractTextContent(message as { content?: unknown });
          }
        }
      }
    });
    const activeToolNames = typeof session.getActiveToolNames === 'function' ? session.getActiveToolNames() : undefined;
    if (options.seedMessages?.length) appendSeedMessages(session, options.seedMessages);

    let compaction: unknown;
    if ((options.prepareMemoryBeforeCompact || options.memoryTriggerBeforeCompact) && options.compactBeforePrompt) {
      const turns = options.memoryTriggerBeforeCompact ? 1 : Math.max(1, options.memoryPrepareTurns ?? 1);
      for (let turn = 1; turn <= turns; turn += 1) {
        capturePhase = 'prep';
        const triggerPrompt = options.memoryTriggerBeforeCompact
          ? 'Continue. Reply READY only.'
          : `Prepare/update observational memory for this session. Observer eval turn ${turn}/${turns}. Reply READY only.`;
        await session.prompt(triggerPrompt, { expandPromptTemplates: false });
        stdout = '';
        await new Promise((resolve) => setTimeout(resolve, options.memoryPrepareWaitMs ?? 5000));
      }
    }
    if (options.compactBeforePrompt) {
      capturePhase = 'compaction';
      try {
        compaction = await session.compact(options.compactInstructions);
        for (const stageFile of options.stageFiles ?? []) {
          appendStageFile(session, stageFile);
          compaction = await session.compact(options.compactInstructions);
        }
      } finally {
        capturePhase = 'answer';
      }
    }
    capturePhase = 'answer';
    await session.prompt(prompt, { expandPromptTemplates: false });
    const diagnosticPrompt = options.sameSessionDiagnostic?.({ stdout, toolCalls, messageTrace, activeToolNames });
    if (diagnosticPrompt) {
      capturePhase = 'diagnostic';
      await session.prompt(diagnosticPrompt, { expandPromptTemplates: false });
      capturePhase = 'answer';
    }
    if (options.waitAfterPromptMs) {
      await new Promise((resolve) => setTimeout(resolve, options.waitAfterPromptMs));
    }
    if (timeout) clearTimeout(timeout);
    unsubscribe();
    session.dispose();
    const usage = sumUsages([prepUsage, answerUsage, diagnosticUsage, compactionUsage].filter((u): u is TokenUsage => Boolean(u)));
    return { stdout, stderr, status: 0, durationMs: Date.now() - started, usage, prepUsage, answerUsage, diagnosticUsage, compactionUsage, compaction, toolCalls, messageTrace, activeToolNames, diagnosticAnswer: diagnosticAnswer.trim() || undefined, diagnosticTrace: diagnosticTrace.length ? diagnosticTrace : undefined };
  } catch (e) {
    stderr = e instanceof Error ? (e.stack ?? e.message) : String(e);
    return { stdout, stderr, status: 1, durationMs: Date.now() - started };
  }
}

export function isolatedPiArgs(model: string, prompt: string, session?: string, thinkingLevel: ModelThinkingLevel = 'off'): string[] {
  const args = ['--print'];
  if (session) args.push('--session', session);
  else args.push('--no-session');
  args.push(
    '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--thinking', thinkingLevel, '--model', model, prompt,
  );
  return args;
}
