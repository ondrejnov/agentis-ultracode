import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseCommandLine,
  parseEffort,
  parsePositiveInt,
  parsePositiveNumber,
} from '../../src/cli/options.ts'
import { UsageError } from '../../src/cli/types.ts'

describe('parseCommandLine', () => {
  it('parses all options of the run command', () => {
    const p = parseCommandLine('run', [
      'wf',
      '--args',
      '{"a":1}',
      '--cwd',
      '/x',
      '--concurrency',
      '4',
      '--max-agents',
      '10',
      '--max-tokens',
      '1000',
      '--max-usd',
      '2.5',
      '--model',
      'haiku',
      '--effort',
      'low',
      '--run-id',
      'r1',
      '--quiet',
      '--json',
      '--no-color',
    ])
    assert.deepEqual(p.positionals, ['wf'])
    assert.equal(p.values.args, '{"a":1}')
    assert.equal(p.values.concurrency, '4')
    assert.equal(p.values['max-usd'], '2.5')
    assert.equal(p.values.quiet, true)
    assert.equal(p.values.json, true)
    assert.equal(p.values['no-color'], true)
  })

  it('supports --option=value and shorthands', () => {
    const p = parseCommandLine('logs', ['wf_1', '-f', '--agent=3'])
    assert.deepEqual(p.positionals, ['wf_1'])
    assert.equal(p.values.follow, true)
    assert.equal(p.values.agent, '3')
  })

  it('unknown option → UsageError in English, with the option name', () => {
    assert.throws(
      () => parseCommandLine('status', ['--nope']),
      (e: unknown) => e instanceof UsageError && /Unknown option --nope/.test(e.message) && /status/.test(e.message),
    )
  })

  it('option without value → UsageError', () => {
    assert.throws(
      () => parseCommandLine('run', ['wf', '--model']),
      (e: unknown) => e instanceof UsageError && /--model requires a value/.test(e.message),
    )
  })

  it('value starting with a dash is ambiguous → hint to use =', () => {
    assert.throws(
      () => parseCommandLine('run', ['wf', '--args', '-5']),
      (e: unknown) => e instanceof UsageError && /--args=<value>/.test(e.message),
    )
    const ok = parseCommandLine('run', ['wf', '--args=-5'])
    assert.equal(ok.values.args, '-5')
  })

  it('options of one command are not valid for another', () => {
    assert.throws(() => parseCommandLine('list', ['--follow']), UsageError)
    assert.throws(() => parseCommandLine('types', ['--json']), UsageError)
  })

  it('“--” ends options', () => {
    const p = parseCommandLine('validate', ['--', '--odd-name.ts'])
    assert.deepEqual(p.positionals, ['--odd-name.ts'])
  })
})

describe('option value validation', () => {
  it('parsePositiveInt', () => {
    assert.equal(parsePositiveInt('x', undefined), undefined)
    assert.equal(parsePositiveInt('x', '8'), 8)
    for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3', ' ']) {
      assert.throws(() => parsePositiveInt('concurrency', bad), (e: unknown) => e instanceof UsageError && /--concurrency/.test(e.message), `must reject “${bad}”`)
    }
  })

  it('parsePositiveNumber', () => {
    assert.equal(parsePositiveNumber('max-usd', '0.5'), 0.5)
    assert.equal(parsePositiveNumber('max-usd', '3'), 3)
    for (const bad of ['0', '-2', 'NaN', 'Infinity', 'x', '']) {
      assert.throws(() => parsePositiveNumber('max-usd', bad), UsageError, `must reject “${bad}”`)
    }
  })

  it('parseEffort', () => {
    for (const ok of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(parseEffort(ok), ok)
    assert.equal(parseEffort(undefined), undefined)
    assert.throws(() => parseEffort('ultra'), (e: unknown) => e instanceof UsageError && /low, medium/.test(e.message))
  })
})
