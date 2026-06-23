export function deepPrompt(task: string): string {
  return `${task}

Challenge the area thoroughly and return a report the parent can act on.

Rules:
- Stay within the task scope, but inspect adjacent surfaces when needed to test the claim.
- Do not modify files, run formatters, or commit unless the task explicitly asks for implementation.
- Look for missed problems, failure modes, counterarguments, edge cases, and hidden assumptions.
- Compare relevant surfaces when consistency matters: code, docs, config, tests, runtime behavior, or prior assumptions.
- Ground claims in concrete evidence: files, symbols, commands, config keys, outputs, or observed behavior.
- State confidence limits, blind spots, and what would need further checking.
- Include reusable lessons or future checks that would prevent repeated work when useful.
`;
}
