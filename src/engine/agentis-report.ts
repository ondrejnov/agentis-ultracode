/**
 * Reports the workflow itself (not its agents) into the Agentis run transcript: a snapshot of the run state
 * (name, status, phases, agent counts, cost, diagram) sent via JSON-RPC `run.ultracode_event`. Agentis keeps one transcript
 * item per ultracode run id and overwrites it with each snapshot, so resends and resume are idempotent.
 *
 * Endpoint and token come from the same env as agentiscode (`AGENTIS_ENDPOINT`, `AGENTIS_API_TOKEN` / `AGENTIS_TOKEN`).
 * Failures never affect the run; they are reported once via `onError`.
 */
import type { AgentisTelemetryTarget, PhaseAgentMeta, RunEvent, RunStatus } from '../types.ts'
import { buildDiagram, type Diagram, type DiagramAgentRun } from './diagram.ts'

export type AgentisPhaseStatus = 'pending' | 'running' | 'done'

export interface AgentisWorkflowState {
  ultracode_run_id: string
  name: string
  description: string
  status: RunStatus
  resumed: boolean
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  current_phase: string | null
  phases: Array<{ title: string; detail?: string; status: AgentisPhaseStatus; agents: number; failed: number }>
  agents: { started: number; running: number; done: number; failed: number; cached: number }
  cost_usd: number
  error: string | null
  /** Workflow diagram (generic JSON language, see diagram.ts) rendered by Agentis. */
  diagram: Diagram
}

export interface AgentisWorkflowReporter {
  onEvent(e: RunEvent): void
  /** Sends the latest state (if not sent yet) and waits for all requests to finish. */
  flush(): Promise<void>
}

export interface AgentisReporterOptions {
  endpoint: string
  token?: string
  fetchImpl?: typeof fetch
  /** Minimal gap between two snapshots caused by agent events (phase/start/end are sent immediately). */
  minIntervalMs?: number
  timeoutMs?: number
  onError?: (message: string) => void
}

export type AgentisReporterFactory = (target: AgentisTelemetryTarget) => AgentisWorkflowReporter | null

/** Default factory: on only when `AGENTIS_ENDPOINT` is set (the target itself already requires it). */
export function agentisReporterFromEnv(env: NodeJS.ProcessEnv = process.env, onError?: (message: string) => void): AgentisReporterFactory {
  return (target) => {
    const endpoint = env.AGENTIS_ENDPOINT?.trim()
    if (!endpoint) return null
    const token = env.AGENTIS_API_TOKEN?.trim() || env.AGENTIS_TOKEN?.trim() || undefined
    return createAgentisReporter(target, { endpoint, ...(token ? { token } : {}), ...(onError ? { onError } : {}) })
  }
}

export function normalizeAgentisEndpoint(endpoint: string): string {
  const value = endpoint.trim().replace(/\/+$/, '')
  return value.endsWith('/api') ? value : `${value}/api`
}

interface PhaseState {
  title: string
  detail: string | undefined
  declared: PhaseAgentMeta[]
  seen: boolean
  agents: number
  failed: number
  running: number
}

export function createAgentisReporter(target: AgentisTelemetryTarget, opts: AgentisReporterOptions): AgentisWorkflowReporter {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = normalizeAgentisEndpoint(opts.endpoint)
  const minIntervalMs = opts.minIntervalMs ?? 2000
  const timeoutMs = opts.timeoutMs ?? 10_000

  let state: AgentisWorkflowState | null = null
  const phases = new Map<string, PhaseState>()
  const runs = new Map<number, DiagramAgentRun>()

  let dirty = false
  let sending: Promise<void> | null = null
  let timer: NodeJS.Timeout | null = null
  let lastSentAt = 0
  let errorReported = false

  const phaseOf = (title: string): PhaseState => {
    let p = phases.get(title)
    if (!p) {
      p = { title, detail: undefined, declared: [], seen: false, agents: 0, failed: 0, running: 0 }
      phases.set(title, p)
    }
    return p
  }

  const snapshot = (): AgentisWorkflowState => {
    const s = state!
    const running = s.status === 'running'
    const statusOf = (p: PhaseState): AgentisPhaseStatus =>
      !p.seen ? 'pending' : running && (p.title === s.current_phase || p.running > 0) ? 'running' : 'done'
    s.phases = [...phases.values()].map((p) => ({
      title: p.title,
      ...(p.detail ? { detail: p.detail } : {}),
      status: statusOf(p),
      agents: p.agents,
      failed: p.failed,
    }))
    const diagram = buildDiagram({
      phases: [...phases.values()].map((p) => ({ title: p.title, detail: p.detail, status: statusOf(p), agents: p.declared })),
      runs: [...runs.values()],
    })
    return { ...s, agents: { ...s.agents }, phases: s.phases, diagram }
  }

  const post = async (payload: AgentisWorkflowState): Promise<void> => {
    const body = {
      jsonrpc: '2.0',
      id: `ultracode-${payload.ultracode_run_id}-${Date.now()}`,
      method: 'run.ultracode_event',
      params: {
        run_id: target.runId,
        workflow_run_id: payload.ultracode_run_id,
        session_id: target.parentSessionId ?? null,
        state: payload,
      },
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.token ? { 'X-Auth-Token': opts.token } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      if (!res.ok || json?.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
    } catch (err) {
      if (!errorReported) {
        errorReported = true
        opts.onError?.(`Agentis run.ultracode_event failed: ${(err as Error)?.message ?? err}`)
      }
    }
  }

  /** One request at a time; a change during a request is sent right after it. */
  const send = (): Promise<void> => {
    if (sending) return sending
    if (!dirty || !state) return Promise.resolve()
    dirty = false
    lastSentAt = Date.now()
    sending = post(snapshot()).finally(() => {
      sending = null
    })
    return sending.then(() => {
      if (dirty) return schedule(true)
    })
  }

  const schedule = (immediate: boolean): Promise<void> | void => {
    dirty = true
    if (immediate) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      return send()
    }
    if (timer || sending) return
    const wait = Math.max(0, lastSentAt + minIntervalMs - Date.now())
    timer = setTimeout(() => {
      timer = null
      void send()
    }, wait)
    timer.unref?.()
  }

  const onEvent = (e: RunEvent): void => {
    if (e.t === 'run_start') {
      for (const p of e.phases) {
        const phase = phaseOf(p.title)
        phase.detail = p.detail
        phase.declared = p.agents ?? []
      }
      state = {
        ultracode_run_id: e.runId,
        name: e.name,
        description: e.description,
        status: 'running',
        resumed: e.resumed,
        started_at: e.ts,
        ended_at: null,
        duration_ms: null,
        current_phase: null,
        phases: [],
        agents: { started: 0, running: 0, done: 0, failed: 0, cached: 0 },
        cost_usd: 0,
        error: null,
        diagram: { version: 1, groups: [], nodes: [], edges: [] },
      }
      void schedule(true)
      return
    }
    if (!state) return
    switch (e.t) {
      case 'phase': {
        phaseOf(e.title).seen = true
        state.current_phase = e.title
        void schedule(true)
        return
      }
      case 'agent_start': {
        runs.set(e.id, {
          id: e.id,
          label: e.label,
          phase: e.phase,
          ...(e.model ? { model: e.model } : {}),
          status: 'running',
          cached: false,
          attempts: 1,
          duration_ms: null,
          cost_usd: 0,
          error: null,
        })
        state.agents.started++
        state.agents.running++
        if (e.phase) {
          const p = phaseOf(e.phase)
          p.seen = true
          p.agents++
          p.running++
        }
        void schedule(false)
        return
      }
      case 'agent_retry': {
        const run = runs.get(e.id)
        if (run) run.attempts = e.attempt
        void schedule(false)
        return
      }
      case 'agent_done': {
        state.agents.running = Math.max(0, state.agents.running - 1)
        if (e.ok) state.agents.done++
        else state.agents.failed++
        if (e.cached) state.agents.cached++
        state.cost_usd += e.costUsd
        const run = runs.get(e.id)
        if (run) {
          run.status = e.ok ? 'done' : 'failed'
          run.cached = e.cached
          run.duration_ms = e.durationMs
          run.cost_usd = e.costUsd
          run.error = e.error ?? null
        }
        if (run?.phase) {
          const p = phaseOf(run.phase)
          p.running = Math.max(0, p.running - 1)
          if (!e.ok) p.failed++
        }
        void schedule(false)
        return
      }
      case 'run_end': {
        state.status = e.status
        state.ended_at = e.ts
        state.duration_ms = e.durationMs
        state.cost_usd = e.totals.costUsd
        state.agents.running = 0
        state.error = e.error ?? null
        for (const run of runs.values()) if (run.status === 'running') run.status = 'aborted'
        void schedule(true)
        return
      }
      default:
        return
    }
  }

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    while (sending || dirty) {
      if (sending) await sending
      else await send()
    }
  }

  return { onEvent, flush }
}
