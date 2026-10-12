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

/** A token/USD/agent cap was exceeded; further `agent()` calls are no longer allowed. */
export class BudgetExceededError extends UltracodeError {
  constructor(message: string) {
    super('BUDGET_EXCEEDED', message)
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
