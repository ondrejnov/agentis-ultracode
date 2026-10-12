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
  it('minimální požadavek', () => {
    const a = buildClaudeArgs(base)
    assert.deepEqual(a.slice(0, 7), ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'bypassPermissions'])
    assert.ok(a.includes('--disallowedTools'))
    assert.equal(a[a.indexOf('--disallowedTools') + 1], 'Workflow')
    assert.equal(a[a.indexOf('--append-system-prompt') + 1], DEFAULT_SUBAGENT_SYSTEM_PROMPT)
    for (const flag of ['--allowedTools', '--model', '--effort', '--json-schema', '--max-budget-usd']) {
      assert.ok(!a.includes(flag), flag)
    }
  })

  it('Workflow v disallowedTools se neduplikuje a vždy je první', () => {
    const a = buildClaudeArgs({ ...base, disallowedTools: ['Bash', 'Workflow', 'Bash', ' '] })
    assert.equal(a[a.indexOf('--disallowedTools') + 1], 'Workflow,Bash')
  })

  it('prompt se nikdy nedává do argv', () => {
    const a = buildClaudeArgs({ ...base, prompt: 'TAJNÝ PROMPT' })
    assert.ok(!a.some((x) => x.includes('TAJNÝ PROMPT')))
  })

  it('custom system prompt se připojí za výchozí', () => {
    const a = buildClaudeArgs({ ...base, appendSystemPrompt: '  Dodatek.  ' })
    assert.equal(a[a.indexOf('--append-system-prompt') + 1], `${DEFAULT_SUBAGENT_SYSTEM_PROMPT}\n\nDodatek.`)
  })

  it('neplatný rozpočet se nepředá', () => {
    assert.ok(!buildClaudeArgs({ ...base, maxBudgetUsd: 0 }).includes('--max-budget-usd'))
    assert.ok(!buildClaudeArgs({ ...base, maxBudgetUsd: Number.NaN }).includes('--max-budget-usd'))
  })

  it('extraArgs jsou na konci', () => {
    const a = buildClaudeArgs({ ...base, model: 'opus', extraArgs: ['--foo', 'bar'] })
    assert.deepEqual(a.slice(-2), ['--foo', 'bar'])
  })
})

describe('resolveClaudeBin', () => {
  it('env přepisuje, jinak „claude“', () => {
    delete process.env['ULTRACODE_CLAUDE_BIN']
    assert.equal(resolveClaudeBin(), 'claude')
    process.env['ULTRACODE_CLAUDE_BIN'] = '/x/fake'
    assert.equal(resolveClaudeBin(), '/x/fake')
    process.env['ULTRACODE_CLAUDE_BIN'] = '   '
    assert.equal(resolveClaudeBin(), 'claude')
  })
})

describe('isTransientApiError', () => {
  it('HTTP kódy', () => {
    for (const s of [408, 409, 429, 500, 502, 503, 529]) assert.equal(isTransientApiError(s, 'API Error'), true, String(s))
    for (const s of [400, 401, 403, 404]) assert.equal(isTransientApiError(s, 'API Error'), false, String(s))
  })
  it('bez kódu rozhoduje text', () => {
    assert.equal(isTransientApiError(null, 'API Error: Connection refused (ECONNREFUSED)'), true)
    assert.equal(isTransientApiError(null, 'Request timed out'), true)
    assert.equal(isTransientApiError(null, 'Overloaded'), true)
    assert.equal(isTransientApiError(null, 'něco jiného'), false)
  })
  it('vyčerpaný limit/kredit není přechodný ani s kódem 429', () => {
    assert.equal(isTransientApiError(429, "You've hit your limit · resets 5pm"), false)
    assert.equal(isTransientApiError(429, 'Credit balance is too low'), false)
    assert.equal(isTransientApiError(401, 'Invalid API key'), false)
  })
})
