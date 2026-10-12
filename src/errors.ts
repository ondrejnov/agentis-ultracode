/** Chyby runtime. Pouze erasable syntaxe: pole deklarujeme explicitně, ne přes parameter properties. */

export class UltracodeError extends Error {
  code: string
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

/** Skript je neplatný (chybí meta, import(), nevalidní meta literál, syntaktická chyba…). Vyhazuje se PŘED startem běhu. */
export class ScriptValidationError extends UltracodeError {
  diagnostics: string[]
  constructor(message: string, diagnostics: string[] = []) {
    super('SCRIPT_INVALID', message)
    this.diagnostics = diagnostics
  }
}

/** Skript použil zakázanou nedeterministickou funkci (Date.now, Math.random, new Date()). */
export class DeterminismError extends UltracodeError {
  constructor(what: string) {
    super(
      'NON_DETERMINISTIC',
      `${what} není ve skriptu workflow povoleno (rozbilo by resume). Předej hodnotu přes \`args\`.`,
    )
  }
}

/** Překročen strop tokenů/USD/agentů; další `agent()` volání už nejsou povolena. */
export class BudgetExceededError extends UltracodeError {
  constructor(message: string) {
    super('BUDGET_EXCEEDED', message)
  }
}

export class WorkflowNotFoundError extends UltracodeError {
  constructor(ref: string, searched: string[]) {
    super('WORKFLOW_NOT_FOUND', `Workflow „${ref}“ nenalezeno. Hledáno: ${searched.join(', ') || '(nikde)'}`)
  }
}

export class AbortedError extends UltracodeError {
  constructor(message = 'Běh byl přerušen.') {
    super('ABORTED', message)
  }
}
