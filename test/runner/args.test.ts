import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  buildClaudeArgs,
  isTransientApiError,
  resolveClaudeBin,
} from '../../src/runner/claude.ts'

const ENV_KEYS = ['ULTRACODE_CLAUDE_BIN', 'ULTRACODE_AGENT_BIN', 'ULTRACODE_AGENT_ADAPTER'] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const base = { prompt: 'p', cwd: '/tmp', outDir: '/tmp/o' }

/** Arguments that go verbatim to `claude` through agentiscode `--extra-args-json`. */
function claudeArgs(a: string[]): string[] {
  return JSON.parse(a[a.indexOf('--extra-args-json') + 1]!) as string[]
}

describe('buildClaudeArgs', () => {
  it('minimal request', () => {
    const a = buildClaudeArgs(base)
    assert.deepEqual(a.slice(0, 5), ['--adapter', 'claude', '--json', '--disallowed-tools', 'Workflow'])
    assert.ok(!a.includes('--permission-mode'))
    const c = claudeArgs(a)
    assert.ok(c.includes('--dangerously-skip-permissions'))
    // sessions are persisted so an interrupted attempt can be resumed
    assert.ok(!c.includes('--no-session-persistence'))
    assert.equal(c[c.indexOf('--append-system-prompt') + 1], DEFAULT_SUBAGENT_SYSTEM_PROMPT)
    for (const flag of ['--model', '--effort']) assert.ok(!a.includes(flag), flag)
    for (const flag of ['--allowedTools', '--json-schema', '--max-budget-usd', '--debug-file']) assert.ok(!c.includes(flag), flag)
    assert.ok(!a.includes('--resume'))
  })

  it('resume of an interrupted session is an agentiscode option; debug log goes to claude', () => {
    const a = buildClaudeArgs({ ...base, resumeSessionId: 'ses-1', debugFile: '/tmp/o/claude-debug.log' })
    assert.equal(a[a.indexOf('--resume') + 1], 'ses-1')
    const c = claudeArgs(a)
    assert.equal(c[c.indexOf('--debug-file') + 1], '/tmp/o/claude-debug.log')
    assert.ok(!c.includes('--resume'))
  })

  it('Agentis telemetry: secondary session in the given run, with parent and title', () => {
    const a = buildClaudeArgs({ ...base, agentis: { taskId: 'task-1', runId: 'run-1', parentSessionId: 'ses-main' }, title: ' [Fix] fix:auth #7 ' })
    assert.equal(a[a.indexOf('--task-id') + 1], 'task-1')
    assert.equal(a[a.indexOf('--run-id') + 1], 'run-1')
    assert.equal(a[a.indexOf('--primary-session') + 1], 'false')
    assert.equal(a[a.indexOf('--parent-session-id') + 1], 'ses-main')
    assert.equal(a[a.indexOf('--session-title') + 1], '[Fix] fix:auth #7')
    const bare = buildClaudeArgs({ ...base, agentis: { taskId: 'task-1', runId: 'run-1' } })
    for (const flag of ['--parent-session-id', '--session-title']) assert.ok(!bare.includes(flag), flag)
    const none = buildClaudeArgs({ ...base, title: 'ignored without agentis' })
    for (const flag of ['--task-id', '--run-id', '--primary-session', '--session-title']) assert.ok(!none.includes(flag), flag)
  })

  it('model, effort and permission mode are agentiscode options; allowedTools/schema/budget go to claude', () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } } }
    const a = buildClaudeArgs({ ...base, model: 'haiku', effort: 'low', permissionMode: 'dontAsk', allowedTools: ['Read', 'Bash(git diff:*)'], schema, maxBudgetUsd: 0.5 })
    assert.equal(a[a.indexOf('--model') + 1], 'haiku')
    assert.equal(a[a.indexOf('--effort') + 1], 'low')
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk')
    const c = claudeArgs(a)
    assert.equal(c[c.indexOf('--allowedTools') + 1], 'Read,Bash(git diff:*)')
    assert.equal(c[c.indexOf('--json-schema') + 1], JSON.stringify(schema))
    assert.equal(c[c.indexOf('--max-budget-usd') + 1], '0.5')
  })

  it('adapter from env ULTRACODE_AGENT_ADAPTER', () => {
    process.env['ULTRACODE_AGENT_ADAPTER'] = 'claude-p'
    const a = buildClaudeArgs(base)
    assert.equal(a[a.indexOf('--adapter') + 1], 'claude-p')
  })

  it('Workflow in disallowedTools is not duplicated and always comes first', () => {
    const a = buildClaudeArgs({ ...base, disallowedTools: ['Bash', 'Workflow', 'Bash', ' '] })
    assert.equal(a[a.indexOf('--disallowed-tools') + 1], 'Workflow,Bash')
  })

  it('prompt is never put into argv', () => {
    const a = buildClaudeArgs({ ...base, prompt: 'SECRET PROMPT' })
    assert.ok(!a.some((x) => x.includes('SECRET PROMPT')))
  })

  it('custom system prompt is appended after the default', () => {
    const c = claudeArgs(buildClaudeArgs({ ...base, appendSystemPrompt: '  Addendum.  ' }))
    assert.equal(c[c.indexOf('--append-system-prompt') + 1], `${DEFAULT_SUBAGENT_SYSTEM_PROMPT}\n\nAddendum.`)
  })

  it('invalid budget is not passed', () => {
    assert.ok(!claudeArgs(buildClaudeArgs({ ...base, maxBudgetUsd: 0 })).includes('--max-budget-usd'))
    assert.ok(!claudeArgs(buildClaudeArgs({ ...base, maxBudgetUsd: Number.NaN })).includes('--max-budget-usd'))
  })

  it('extraArgs are at the end of the claude arguments', () => {
    const a = buildClaudeArgs({ ...base, model: 'opus', extraArgs: ['--foo', 'bar'] })
    assert.deepEqual(claudeArgs(a).slice(-2), ['--foo', 'bar'])
    assert.ok(!a.includes('--foo'))
  })
})

describe('resolveClaudeBin', () => {
  it('ULTRACODE_AGENT_BIN, then ULTRACODE_CLAUDE_BIN, otherwise "agentiscode"', () => {
    delete process.env['ULTRACODE_AGENT_BIN']
    delete process.env['ULTRACODE_CLAUDE_BIN']
    assert.equal(resolveClaudeBin(), 'agentiscode')
    process.env['ULTRACODE_CLAUDE_BIN'] = '/x/fake'
    assert.equal(resolveClaudeBin(), '/x/fake')
    process.env['ULTRACODE_AGENT_BIN'] = '/y/agent'
    assert.equal(resolveClaudeBin(), '/y/agent')
    process.env['ULTRACODE_AGENT_BIN'] = '   '
    process.env['ULTRACODE_CLAUDE_BIN'] = '   '
    assert.equal(resolveClaudeBin(), 'agentiscode')
  })
})

describe('isTransientApiError', () => {
  it('HTTP codes', () => {
    for (const s of [408, 409, 429, 500, 502, 503, 529]) assert.equal(isTransientApiError(s, 'API Error'), true, String(s))
    for (const s of [400, 401, 403, 404]) assert.equal(isTransientApiError(s, 'API Error'), false, String(s))
  })
  it('without a code, the text decides', () => {
    assert.equal(isTransientApiError(null, 'API Error: Connection refused (ECONNREFUSED)'), true)
    assert.equal(isTransientApiError(null, 'Request timed out'), true)
    assert.equal(isTransientApiError(null, 'Overloaded'), true)
    assert.equal(isTransientApiError(null, 'something else'), false)
  })
  it('exhausted limit/credit is not transient, even with code 429', () => {
    assert.equal(isTransientApiError(429, "You've hit your limit · resets 5pm"), false)
    assert.equal(isTransientApiError(429, 'Credit balance is too low'), false)
    assert.equal(isTransientApiError(401, 'Invalid API key'), false)
  })
})
