import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  buildClaudeArgs,
  isTransientApiError,
  resolveClaudeBin,
} from '../../src/runner/claude.ts'

const saved = process.env['ULTRACODE_CLAUDE_BIN']
afterEach(() => {
  if (saved === undefined) delete process.env['ULTRACODE_CLAUDE_BIN']
  else process.env['ULTRACODE_CLAUDE_BIN'] = saved
})

const base = { prompt: 'p', cwd: '/tmp', outDir: '/tmp/o' }

describe('buildClaudeArgs', () => {
  it('minimal request', () => {
    const a = buildClaudeArgs(base)
    assert.deepEqual(a.slice(0, 7), ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'bypassPermissions'])
    assert.ok(a.includes('--disallowedTools'))
    assert.equal(a[a.indexOf('--disallowedTools') + 1], 'Workflow')
    assert.equal(a[a.indexOf('--append-system-prompt') + 1], DEFAULT_SUBAGENT_SYSTEM_PROMPT)
    for (const flag of ['--allowedTools', '--model', '--effort', '--json-schema', '--max-budget-usd']) {
      assert.ok(!a.includes(flag), flag)
    }
  })

  it('Workflow in disallowedTools is not duplicated and always comes first', () => {
    const a = buildClaudeArgs({ ...base, disallowedTools: ['Bash', 'Workflow', 'Bash', ' '] })
    assert.equal(a[a.indexOf('--disallowedTools') + 1], 'Workflow,Bash')
  })

  it('prompt is never put into argv', () => {
    const a = buildClaudeArgs({ ...base, prompt: 'SECRET PROMPT' })
    assert.ok(!a.some((x) => x.includes('SECRET PROMPT')))
  })

  it('custom system prompt is appended after the default', () => {
    const a = buildClaudeArgs({ ...base, appendSystemPrompt: '  Addendum.  ' })
    assert.equal(a[a.indexOf('--append-system-prompt') + 1], `${DEFAULT_SUBAGENT_SYSTEM_PROMPT}\n\nAddendum.`)
  })

  it('invalid budget is not passed', () => {
    assert.ok(!buildClaudeArgs({ ...base, maxBudgetUsd: 0 }).includes('--max-budget-usd'))
    assert.ok(!buildClaudeArgs({ ...base, maxBudgetUsd: Number.NaN }).includes('--max-budget-usd'))
  })

  it('extraArgs are at the end', () => {
    const a = buildClaudeArgs({ ...base, model: 'opus', extraArgs: ['--foo', 'bar'] })
    assert.deepEqual(a.slice(-2), ['--foo', 'bar'])
  })
})

describe('resolveClaudeBin', () => {
  it('env overrides, otherwise "claude"', () => {
    delete process.env['ULTRACODE_CLAUDE_BIN']
    assert.equal(resolveClaudeBin(), 'claude')
    process.env['ULTRACODE_CLAUDE_BIN'] = '/x/fake'
    assert.equal(resolveClaudeBin(), '/x/fake')
    process.env['ULTRACODE_CLAUDE_BIN'] = '   '
    assert.equal(resolveClaudeBin(), 'claude')
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
