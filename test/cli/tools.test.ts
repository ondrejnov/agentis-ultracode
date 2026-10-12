/** validate, types, skill install, init, help/version. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from '../../src/cli/cli.ts'
import { HELLO_WORKFLOW } from '../../src/cli/templates.ts'
import type { ParseScriptFn } from '../../src/cli/types.ts'
import { makeDiscovery, makeIO, tmpDir, writeFile } from './helpers.ts'

const REAL_ROOT = join(import.meta.dirname, '..', '..')

/** Fake parser: behaves according to the file content. */
const fakeParse: ParseScriptFn = (source, filename) => {
  const diagnostics: Array<{ level: 'error' | 'warning'; message: string; line?: number }> = []
  if (source.includes('BAD')) diagnostics.push({ level: 'error', message: 'missing export const meta', line: 1 })
  if (source.includes('SYNTAX')) diagnostics.push({ level: 'error', message: 'Unexpected token', line: 12 })
  if (source.includes('WARN')) diagnostics.push({ level: 'warning', message: 'phase “X” is not in meta.phases', line: 7 })
  if (source.includes('THROW')) throw new Error(`parser crashed on ${filename}`)
  const ok = !diagnostics.some((d) => d.level === 'error')
  return {
    ok,
    meta: ok ? { name: 'fake', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] } : null,
    diagnostics,
    code: '',
  }
}

describe('validate', () => {
  it('valid script → OK, exit 0, output on stdout', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'a.workflow.ts'), 'GOOD')
    const cap = makeIO({ cwd: dir })
    const code = await main(['validate', 'a.workflow.ts'], cap.io, { parseScript: fakeParse })
    assert.equal(code, 0)
    assert.match(cap.out(), /^OK {2}a\.workflow\.ts {2}\(fake, 2 phases\)/)
    assert.match(cap.out(), /All good \(1 file\)/)
    assert.equal(cap.err(), '')
  })

  it('error with a line → exit 2, output path:line', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'bad.ts'), 'BAD SYNTAX')
    const cap = makeIO({ cwd: dir })
    const code = await main(['validate', 'bad.ts'], cap.io, { parseScript: fakeParse })
    assert.equal(code, 2)
    assert.match(cap.out(), /^ERROR {2}bad\.ts/)
    assert.match(cap.out(), /bad\.ts:1: error: missing export const meta/)
    assert.match(cap.out(), /bad\.ts:12: error: Unexpected token/)
    assert.match(cap.out(), /Invalid scripts: 1 of 1\./)
  })

  it('a warning alone does not fail (exit 0) and is printed', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'w.ts'), 'WARN')
    const cap = makeIO({ cwd: dir })
    assert.equal(await main(['validate', 'w.ts'], cap.io, { parseScript: fakeParse }), 0)
    assert.match(cap.out(), /w\.ts:7: warning: phase “X”/)
  })

  it('multiple files: one bad → exit 2, the others are still checked', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'ok.ts'), 'GOOD')
    writeFile(join(dir, 'bad.ts'), 'BAD')
    const cap = makeIO({ cwd: dir })
    const code = await main(['validate', 'ok.ts', 'bad.ts', 'ok.ts'], cap.io, { parseScript: fakeParse })
    assert.equal(code, 2)
    assert.equal((cap.out().match(/^OK /gm) ?? []).length, 2)
    assert.match(cap.out(), /Invalid scripts: 1 of 3\./)
  })

  it('non-existent file and a directory → exit 2', async () => {
    const dir = tmpDir()
    const cap = makeIO({ cwd: dir })
    assert.equal(await main(['validate', 'nothing.workflow.ts', '.'], cap.io, { parseScript: fakeParse }), 2)
    assert.match(cap.out(), /file cannot be read/)
  })

  it('a parser exception does not crash the command', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 't.ts'), 'THROW')
    const cap = makeIO({ cwd: dir })
    assert.equal(await main(['validate', 't.ts'], cap.io, { parseScript: fakeParse }), 2)
    assert.match(cap.out(), /parser failed: parser crashed/)
  })

  it('workflow name is resolved via discovery', async () => {
    const dir = tmpDir()
    const p = join(dir, 'elsewhere', 'x.workflow.ts')
    writeFile(p, 'GOOD')
    const cap = makeIO({ cwd: dir })
    const code = await main(['validate', 'x'], cap.io, { parseScript: fakeParse, discovery: makeDiscovery([], { x: p }) })
    assert.equal(code, 0)
  })

  it('--json: array of reports; without a path → exit 2', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'a.ts'), 'GOOD')
    writeFile(join(dir, 'b.ts'), 'BAD')
    const cap = makeIO({ cwd: dir })
    const code = await main(['validate', 'a.ts', 'b.ts', '--json'], cap.io, { parseScript: fakeParse })
    assert.equal(code, 2)
    const j = JSON.parse(cap.out())
    assert.deepEqual(j.map((r: { path: string; ok: boolean }) => [r.path, r.ok]), [['a.ts', true], ['b.ts', false]])
    assert.equal(j[1].diagnostics[0].line, 1)
    const none = makeIO()
    assert.equal(await main(['validate'], none.io, { parseScript: fakeParse }), 2)
  })

  it('hello.workflow.ts template passes the real parser (if available)', async (t) => {
    let parse: ParseScriptFn
    try {
      parse = (await import('../../src/script/parse.ts')).parseScript
    } catch {
      t.skip('src/script/parse.ts is not available yet')
      return
    }
    const res = parse(HELLO_WORKFLOW, 'hello.workflow.ts')
    assert.deepEqual(res.diagnostics.filter((d) => d.level === 'error'), [], 'template must not contain errors')
    assert.equal(res.ok, true)
    assert.equal(res.meta?.name, 'hello')
  })

  it('phase() titles in the template match meta.phases', () => {
    const used = [...HELLO_WORKFLOW.matchAll(/phase\('([^']+)'\)/g)].map((m) => m[1])
    const declared = [...HELLO_WORKFLOW.matchAll(/title: '([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(used, declared)
  })
})

function fakePackage(): string {
  const root = tmpDir('uc-pkg-')
  writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '9.8.7' }))
  writeFile(join(root, 'types', 'workflow.d.ts'), 'declare function agent(): void\n')
  writeFile(join(root, 'skills', 'ultracode-workflow', 'SKILL.md'), '---\nname: ultracode-workflow\n---\ncontent\n')
  writeFile(join(root, 'skills', 'ultracode-workflow', 'references', 'api.md'), 'API\n')
  return root
}

describe('types', () => {
  it('default: writes <cwd>/.ultracode/workflow.d.ts and prints the reference path', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    const code = await main(['types'], cap.io, { packageRoot: root })
    assert.equal(code, 0)
    assert.equal(readFileSync(join(cwd, '.ultracode', 'workflow.d.ts'), 'utf8'), 'declare function agent(): void\n')
    assert.equal(cap.out(), '/// <reference path="../workflow.d.ts" />\n')
    assert.match(cap.err(), /Types written: .*workflow\.d\.ts/)
  })

  it('--out is relative to the process cwd, reference path relative to .ultracode/workflows', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    const code = await main(['types', '--out', 'types/out'], cap.io, { packageRoot: root })
    assert.equal(code, 0)
    assert.ok(existsSync(join(cwd, 'types', 'out', 'workflow.d.ts')))
    assert.equal(cap.out(), '/// <reference path="../../types/out/workflow.d.ts" />\n')
  })

  it('overwrites an older version of the types', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    writeFile(join(cwd, '.ultracode', 'workflow.d.ts'), 'OLD')
    await main(['types'], makeIO({ cwd }).io, { packageRoot: root })
    assert.match(readFileSync(join(cwd, '.ultracode', 'workflow.d.ts'), 'utf8'), /declare function agent/)
  })

  it('missing source file → exit 1; superfluous arguments → 2', async () => {
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    assert.equal(await main(['types'], cap.io, { packageRoot: tmpDir() }), 1)
    assert.match(cap.err(), /Writing types failed/)
    assert.equal(await main(['types', 'extra'], makeIO({ cwd }).io, { packageRoot: fakePackage() }), 2)
  })

  it('the real package contains types/workflow.d.ts', async () => {
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    assert.equal(await main(['types'], cap.io, { packageRoot: REAL_ROOT }), 0)
    assert.match(readFileSync(join(cwd, '.ultracode', 'workflow.d.ts'), 'utf8'), /declare function agent/)
  })
})

describe('skill install', () => {
  it('--project copies the whole tree to <cwd>/.claude/skills/ultracode-workflow', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    const code = await main(['skill', 'install', '--project'], cap.io, { packageRoot: root })
    assert.equal(code, 0)
    const dest = join(cwd, '.claude', 'skills', 'ultracode-workflow')
    assert.match(readFileSync(join(dest, 'SKILL.md'), 'utf8'), /content/)
    assert.equal(readFileSync(join(dest, 'references', 'api.md'), 'utf8'), 'API\n')
    assert.match(cap.out(), /installed \(2 files\)/)
  })

  it('default (--user) goes to $HOME/.claude/skills; CLAUDE_CONFIG_DIR takes precedence', async () => {
    const root = fakePackage()
    const home = tmpDir()
    const a = makeIO({ cwd: tmpDir(), env: { HOME: home } })
    assert.equal(await main(['skill', 'install'], a.io, { packageRoot: root }), 0)
    assert.ok(existsSync(join(home, '.claude', 'skills', 'ultracode-workflow', 'SKILL.md')))

    const cfg = tmpDir()
    const b = makeIO({ cwd: tmpDir(), env: { HOME: home, CLAUDE_CONFIG_DIR: cfg } })
    assert.equal(await main(['skill', 'install', '--user'], b.io, { packageRoot: root }), 0)
    assert.ok(existsSync(join(cfg, 'skills', 'ultracode-workflow', 'SKILL.md')))
  })

  it('overwrites nothing without --force; with --force it overwrites', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const dest = join(cwd, '.claude', 'skills', 'ultracode-workflow')
    writeFile(join(dest, 'SKILL.md'), 'MY EDITS')

    const cap = makeIO({ cwd })
    const code = await main(['skill', 'install', '--project'], cap.io, { packageRoot: root })
    assert.equal(code, 2)
    assert.match(cap.err(), /--force/)
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'MY EDITS', 'file must not be overwritten')
    assert.ok(!existsSync(join(dest, 'references')), 'the rest must not be copied either')

    const forced = makeIO({ cwd })
    assert.equal(await main(['skill', 'install', '--project', '--force'], forced.io, { packageRoot: root }), 0)
    assert.match(readFileSync(join(dest, 'SKILL.md'), 'utf8'), /content/)
    assert.ok(existsSync(join(dest, 'references', 'api.md')))
  })

  it('repeated install of an identical skill is OK even without --force', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    await main(['skill', 'install', '--project'], makeIO({ cwd }).io, { packageRoot: root })
    const cap = makeIO({ cwd })
    assert.equal(await main(['skill', 'install', '--project'], cap.io, { packageRoot: root }), 0)
    assert.match(cap.out(), /already installed and up to date/)
  })

  it('--user and --project together / no subcommand / unknown subcommand → 2', async () => {
    const root = fakePackage()
    const e = (argv: string[]) => main(argv, makeIO({ cwd: tmpDir() }).io, { packageRoot: root })
    assert.equal(await e(['skill', 'install', '--user', '--project']), 2)
    assert.equal(await e(['skill']), 2)
    assert.equal(await e(['skill', 'remove']), 2)
  })

  it('package without a skill → exit 1', async () => {
    const root = tmpDir()
    const cap = makeIO({ cwd: tmpDir() })
    assert.equal(await main(['skill', 'install', '--project'], cap.io, { packageRoot: root }), 1)
    assert.match(cap.err(), /Skill is missing from the package/)
  })

  it('the real skill from the package can be installed (if it exists)', async (t) => {
    if (!existsSync(join(REAL_ROOT, 'skills', 'ultracode-workflow', 'SKILL.md'))) {
      t.skip('skills/ultracode-workflow is not available yet')
      return
    }
    const cwd = tmpDir()
    assert.equal(await main(['skill', 'install', '--project'], makeIO({ cwd }).io, { packageRoot: REAL_ROOT }), 0)
    assert.ok(existsSync(join(cwd, '.claude', 'skills', 'ultracode-workflow', 'SKILL.md')))
  })
})

describe('init', () => {
  it('creates workflows/hello.workflow.ts, the types and .gitignore', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    const code = await main(['init'], cap.io, { packageRoot: root })
    assert.equal(code, 0)
    assert.equal(readFileSync(join(cwd, '.ultracode', 'workflows', 'hello.workflow.ts'), 'utf8'), HELLO_WORKFLOW)
    assert.ok(existsSync(join(cwd, '.ultracode', 'workflow.d.ts')))
    assert.match(readFileSync(join(cwd, '.ultracode', '.gitignore'), 'utf8'), /^runs\/$/m)
    assert.match(cap.out(), /Created: .*hello\.workflow\.ts/)
  })

  it('does not overwrite a modified hello without --force; with --force it does', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    await main(['init'], makeIO({ cwd }).io, { packageRoot: root })
    const hello = join(cwd, '.ultracode', 'workflows', 'hello.workflow.ts')
    writeFileSync(hello, 'MINE')
    const cap = makeIO({ cwd })
    assert.equal(await main(['init'], cap.io, { packageRoot: root }), 0)
    assert.equal(readFileSync(hello, 'utf8'), 'MINE')
    assert.match(cap.out(), /Kept \(already exists\)/)
    assert.equal(await main(['init', '--force'], makeIO({ cwd }).io, { packageRoot: root }), 0)
    assert.equal(readFileSync(hello, 'utf8'), HELLO_WORKFLOW)
  })

  it('failure (types missing from the package) → exit 1', async () => {
    const cap = makeIO({ cwd: tmpDir() })
    assert.equal(await main(['init'], cap.io, { packageRoot: tmpDir() }), 1)
    assert.match(cap.err(), /Initialization failed/)
  })
})

describe('help and version', () => {
  it('--help / -h / help → stdout, exit 0, with all commands', async () => {
    for (const argv of [['--help'], ['-h'], ['help']]) {
      const cap = makeIO()
      assert.equal(await main(argv, cap.io, {}), 0)
      for (const word of ['run', 'resume', 'status', 'list', 'logs', 'validate', 'types', 'skill install', 'init', 'Exit codes', 'Usage']) {
        assert.ok(cap.out().includes(word), `${argv.join(' ')}: missing “${word}”`)
      }
      assert.equal(cap.err(), '')
    }
  })

  it('no arguments: help on stderr, exit 2', async () => {
    const cap = makeIO()
    assert.equal(await main([], cap.io, {}), 2)
    assert.match(cap.err(), /Usage:/)
    assert.equal(cap.out(), '')
  })

  it('help for a specific command: help <cmd> and <cmd> --help (without running the command)', async () => {
    const a = makeIO()
    assert.equal(await main(['help', 'run'], a.io, {}), 0)
    assert.match(a.out(), /Usage: ultracode run/)
    assert.match(a.out(), /--max-usd/)
    let engineCalled = false
    const b = makeIO()
    const code = await main(['run', '--help'], b.io, {
      runWorkflow: async () => {
        engineCalled = true
        throw new Error('must not be called')
      },
    })
    assert.equal(code, 0)
    assert.equal(engineCalled, false)
    assert.match(b.out(), /Usage: ultracode run/)
    const c = makeIO()
    assert.equal(await main(['skill', 'install', '-h'], c.io, {}), 0)
    assert.match(c.out(), /skill install/)
  })

  it('unknown help topic and unknown command → 2', async () => {
    const a = makeIO()
    assert.equal(await main(['help', 'nothing'], a.io, {}), 2)
    const b = makeIO()
    assert.equal(await main(['--cwd', 'x', 'run'], b.io, {}), 2)
    assert.match(b.err(), /must be the first argument/)
  })

  it('--version prints the version from package.json', async () => {
    const cap = makeIO()
    assert.equal(await main(['--version'], cap.io, { packageRoot: fakePackage() }), 0)
    assert.equal(cap.out(), 'ultracode 9.8.7\n')
    const real = makeIO()
    await main(['--version'], real.io, {})
    const pkg = JSON.parse(readFileSync(join(REAL_ROOT, 'package.json'), 'utf8')) as { version: string }
    assert.equal(real.out(), `ultracode ${pkg.version}\n`)
  })
})
