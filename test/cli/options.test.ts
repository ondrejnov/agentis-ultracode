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
  it('rozparsuje všechny volby příkazu run', () => {
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

  it('podporuje --volba=hodnota a zkratky', () => {
    const p = parseCommandLine('logs', ['wf_1', '-f', '--agent=3'])
    assert.deepEqual(p.positionals, ['wf_1'])
    assert.equal(p.values.follow, true)
    assert.equal(p.values.agent, '3')
  })

  it('neznámá volba → UsageError česky, s názvem volby', () => {
    assert.throws(
      () => parseCommandLine('status', ['--nope']),
      (e: unknown) => e instanceof UsageError && /Neznámá volba --nope/.test(e.message) && /status/.test(e.message),
    )
  })

  it('volba bez hodnoty → UsageError', () => {
    assert.throws(
      () => parseCommandLine('run', ['wf', '--model']),
      (e: unknown) => e instanceof UsageError && /--model vyžaduje hodnotu/.test(e.message),
    )
  })

  it('hodnota začínající pomlčkou je nejednoznačná → rada použít =', () => {
    assert.throws(
      () => parseCommandLine('run', ['wf', '--args', '-5']),
      (e: unknown) => e instanceof UsageError && /--args=<hodnota>/.test(e.message),
    )
    const ok = parseCommandLine('run', ['wf', '--args=-5'])
    assert.equal(ok.values.args, '-5')
  })

  it('volby jednoho příkazu nejsou platné u jiného', () => {
    assert.throws(() => parseCommandLine('list', ['--follow']), UsageError)
    assert.throws(() => parseCommandLine('types', ['--json']), UsageError)
  })

  it('„--“ ukončí volby', () => {
    const p = parseCommandLine('validate', ['--', '--divne-jmeno.ts'])
    assert.deepEqual(p.positionals, ['--divne-jmeno.ts'])
  })
})

describe('validace hodnot voleb', () => {
  it('parsePositiveInt', () => {
    assert.equal(parsePositiveInt('x', undefined), undefined)
    assert.equal(parsePositiveInt('x', '8'), 8)
    for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3', ' ']) {
      assert.throws(() => parsePositiveInt('concurrency', bad), (e: unknown) => e instanceof UsageError && /--concurrency/.test(e.message), `má odmítnout „${bad}“`)
    }
  })

  it('parsePositiveNumber', () => {
    assert.equal(parsePositiveNumber('max-usd', '0.5'), 0.5)
    assert.equal(parsePositiveNumber('max-usd', '3'), 3)
    for (const bad of ['0', '-2', 'NaN', 'Infinity', 'x', '']) {
      assert.throws(() => parsePositiveNumber('max-usd', bad), UsageError, `má odmítnout „${bad}“`)
    }
  })

  it('parseEffort', () => {
    for (const ok of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(parseEffort(ok), ok)
    assert.equal(parseEffort(undefined), undefined)
    assert.throws(() => parseEffort('ultra'), (e: unknown) => e instanceof UsageError && /low, medium/.test(e.message))
  })
})
