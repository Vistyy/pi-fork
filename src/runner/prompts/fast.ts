export function fastPrompt(task: string): string {
  return `${task}

Find the concrete answer and report it briefly.

Rules:
- Stay within the task scope.
- Do not modify files, run formatters, or commit unless the task explicitly asks for implementation.
- Cite the source of the answer: file, symbol, command, config key, output, or observed behavior.
- If you cannot find the answer, say what you checked and what is still missing.
- Keep the report short: answer, evidence/source, and important caveat only.
`;
}
