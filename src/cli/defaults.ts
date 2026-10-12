/**
 * Lazy loading of the default implementations (engine, store, discovery, parseScript).
 * Injected dependencies from `deps` take precedence; modules are imported only on first use,
 * so e.g. `help` or `types` don't need the whole runtime.
 */
import type { CliDeps, CliDiscovery, CliStore, ParseScriptFn, RunWorkflowFn } from './types.ts'

async function load<T>(what: string, loader: () => Promise<T>): Promise<T> {
  try {
    return await loader()
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`Cannot load ${what}: ${detail}`, { cause: e })
  }
}

export async function resolveRunWorkflow(deps: CliDeps): Promise<RunWorkflowFn> {
  if (deps.runWorkflow) return deps.runWorkflow
  const mod = await load('engine (src/engine/engine.ts)', () => import('../engine/engine.ts'))
  return (opts) => mod.runWorkflow(opts)
}

export async function resolveStore(deps: CliDeps): Promise<CliStore> {
  if (deps.store) return deps.store
  const mod = await load('run store (src/engine/store.ts)', () => import('../engine/store.ts'))
  return {
    runsRoot: mod.runsRoot,
    listRuns: mod.listRuns,
    readRunSummary: mod.readRunSummary,
    readEvents: mod.readEvents,
    runLockHeld: mod.runLockHeld,
  }
}

export async function resolveDiscovery(deps: CliDeps): Promise<CliDiscovery> {
  if (deps.discovery) return deps.discovery
  const mod = await load('workflow discovery (src/engine/discovery.ts)', () => import('../engine/discovery.ts'))
  return { findWorkflow: mod.findWorkflow, listWorkflows: mod.listWorkflows }
}

export async function resolveParseScript(deps: CliDeps): Promise<ParseScriptFn> {
  if (deps.parseScript) return deps.parseScript
  const mod = await load('script parser (src/script/parse.ts)', () => import('../script/parse.ts'))
  return (source, filename) => mod.parseScript(source, filename)
}
