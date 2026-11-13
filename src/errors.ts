/** Runtime errors. Erasable syntax only: fields are declared explicitly, not via parameter properties. */

export class UltracodeError extends Error {
  code: string
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

/** The script is invalid (missing meta, import(), invalid meta literal, syntax error…). Thrown BEFORE the run starts. */
export class ScriptValidationError extends UltracodeError {
  diagnostics: string[]
  constructor(message: string, diagnostics: string[] = []) {
    super('SCRIPT_INVALID', message)
    this.diagnostics = diagnostics
  }
}

/** The script used a forbidden non-deterministic function (Date.now, Math.random, new Date()). */
export class DeterminismError extends UltracodeError {
  constructor(what: string) {
    super(
      'NON_DETERMINISTIC',
      `${what} is not allowed in a workflow script (it would break resume). Pass the value via \`args\`.`,
    )
  }
}

/** The per-run agent limit (`--max-agents`) was reached; further `agent()` calls are no longer allowed. */
export class AgentLimitError extends UltracodeError {
  constructor(message: string) {
    super('AGENT_LIMIT', message)
  }
}

/**
 * The usage/subscription limit of the agent account is exhausted. The run stops: this and every later `agent()` call
 * throws; `ultracode resume <runId>` continues (from the journal) after the limit resets.
 */
export class UsageLimitError extends UltracodeError {
  constructor(message: string) {
    super('USAGE_LIMIT', message)
  }
}

export class WorkflowNotFoundError extends UltracodeError {
  constructor(ref: string, searched: string[]) {
    super('WORKFLOW_NOT_FOUND', `Workflow “${ref}” not found. Searched: ${searched.join(', ') || '(nowhere)'}`)
  }
}

export class AbortedError extends UltracodeError {
  constructor(message = 'Run was aborted.') {
    super('ABORTED', message)
  }
}
