export const meta = {
  name: 'sdd-implementer',
  description: 'Run one SDD implementer agent on a pinned model (default claude-sonnet-5)',
  whenToUse: 'Subagent-driven-development implementer dispatch when the model must be a full ID the Agent tool enum cannot express. Pass args {promptFile, label?, model?}.',
  phases: [{ title: 'Implement', model: 'claude-sonnet-5' }],
}

// args may arrive as a JSON-encoded string depending on the caller — tolerate both.
let A = args
if (typeof A === 'string') {
  try { A = JSON.parse(A) } catch { A = null }
}
if (!A || typeof A.promptFile !== 'string' || !A.promptFile) {
  throw new Error('args.promptFile is required (absolute path to the full dispatch prompt)')
}
const MODEL = A.model || 'claude-sonnet-5'

const result = await agent(
  [
    `Read ${A.promptFile} first — it is your complete task dispatch. Execute it fully and exactly:`,
    `follow its required reading order, implement, run the gates it names, commit as it specifies, and write the report file it names.`,
    `Your final reply must contain ONLY what the dispatch asks for in its closing paragraph (STATUS / commit SHA / one-line test summary / concerns).`,
  ].join(' '),
  { label: A.label || 'implementer', phase: 'Implement', model: MODEL },
)

return result
