export function balancedPrompt(task: string): string {
  return `${task}

Investigate the bounded task and return a report the parent can act on.

Rules:
- Stay within the task scope.
- Do not modify files, run formatters, or commit unless the task explicitly asks for implementation.
- Give a verdict or recommendation when the evidence supports one.
- Ground claims in concrete evidence: files, symbols, commands, config keys, outputs, or observed behavior.
- Include important reasoning, uncertainty, and a next step if one follows.
- Use concise headings when helpful, such as Result, Evidence, Caveats, and Next step.
`;
}
