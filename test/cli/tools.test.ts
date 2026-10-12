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

/** Fake parser: řídí se obsahem souboru. */
const fakeParse: ParseScriptFn = (source, filename) => {
  const diagnostics: Array<{ level: 'error' | 'warning'; message: string; line?: number }> = []
  if (source.includes('BAD')) diagnostics.push({ level: 'error', message: 'chybí export const meta', line: 1 })
  if (source.includes('SYNTAX')) diagnostics.push({ level: 'error', message: 'Unexpected token', line: 12 })
  if (source.includes('WARN')) diagnostics.push({ level: 'warning', message: 'fáze „X“ není v meta.phases', line: 7 })
  if (source.includes('THROW')) throw new Error(`parser spadl na ${filename}`)
  const ok = !diagnostics.some((d) => d.level === 'error')
  return {
    ok,
    meta: ok ? { name: 'fake', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] } : null,
    diagnostics,
    code: '',
  }
}

describe('validate', () => {
  it('platný skript → OK, exit 0, výstup na stdout', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'a.workflow.ts'), 'GOOD')
    const cap = makeIO({ cwd: dir })
    const code = await main(['validate', 'a.workflow.ts'], cap.io, { parseScript: fakeParse })
    assert.equal(code, 0)
    assert.match(cap.out(), /^OK {2}a\.workflow\.ts {2}\(fake, 2 fáze\)/)
    assert.match(cap.out(), /Vše v pořádku \(1 soubor\)/)
    assert.equal(cap.err(), '')
  })

  it('chyba s řádkem → exit 2, výpis path:řádek', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'bad.ts'), 'BAD SYNTAX')
    const cap = makeIO({ cwd: dir })
    const code = await main(['validate', 'bad.ts'], cap.io, { parseScript: fakeParse })
    assert.equal(code, 2)
    assert.match(cap.out(), /^CHYBA {2}bad\.ts/)
    assert.match(cap.out(), /bad\.ts:1: chyba: chybí export const meta/)
    assert.match(cap.out(), /bad\.ts:12: chyba: Unexpected token/)
    assert.match(cap.out(), /Neplatné skripty: 1 z 1/)
  })

  it('samotné varování nevadí (exit 0) a je vypsáno', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'w.ts'), 'WARN')
    const cap = makeIO({ cwd: dir })
    assert.equal(await main(['validate', 'w.ts'], cap.io, { parseScript: fakeParse }), 0)
    assert.match(cap.out(), /w\.ts:7: varování: fáze „X“/)
  })

  it('více souborů: jeden špatný → exit 2, ostatní se zkontrolují', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'ok.ts'), 'GOOD')
    writeFile(join(dir, 'bad.ts'), 'BAD')
    const cap = makeIO({ cwd: dir })
    const code = await main(['validate', 'ok.ts', 'bad.ts', 'ok.ts'], cap.io, { parseScript: fakeParse })
    assert.equal(code, 2)
    assert.equal((cap.out().match(/^OK /gm) ?? []).length, 2)
    assert.match(cap.out(), /Neplatné skripty: 1 z 3/)
  })

  it('neexistující soubor a adresář → exit 2', async () => {
    const dir = tmpDir()
    const cap = makeIO({ cwd: dir })
    assert.equal(await main(['validate', 'nic.workflow.ts', '.'], cap.io, { parseScript: fakeParse }), 2)
    assert.match(cap.out(), /soubor nelze přečíst/)
  })

  it('výjimka parseru neshodí příkaz', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 't.ts'), 'THROW')
    const cap = makeIO({ cwd: dir })
    assert.equal(await main(['validate', 't.ts'], cap.io, { parseScript: fakeParse }), 2)
    assert.match(cap.out(), /parser selhal: parser spadl/)
  })

  it('jméno workflow se dohledá přes discovery', async () => {
    const dir = tmpDir()
    const p = join(dir, 'elsewhere', 'x.workflow.ts')
    writeFile(p, 'GOOD')
    const cap = makeIO({ cwd: dir })
    const code = await main(['validate', 'x'], cap.io, { parseScript: fakeParse, discovery: makeDiscovery([], { x: p }) })
    assert.equal(code, 0)
  })

  it('--json: pole reportů; bez cesty → exit 2', async () => {
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

  it('šablona hello.workflow.ts projde skutečným parserem (pokud je k dispozici)', async (t) => {
    let parse: ParseScriptFn
    try {
      parse = (await import('../../src/script/parse.ts')).parseScript
    } catch {
      t.skip('src/script/parse.ts zatím není k dispozici')
      return
    }
    const res = parse(HELLO_WORKFLOW, 'hello.workflow.ts')
    assert.deepEqual(res.diagnostics.filter((d) => d.level === 'error'), [], 'šablona nesmí mít chyby')
    assert.equal(res.ok, true)
    assert.equal(res.meta?.name, 'hello')
  })

  it('titul phase() v šabloně odpovídá meta.phases', () => {
    const used = [...HELLO_WORKFLOW.matchAll(/phase\('([^']+)'\)/g)].map((m) => m[1])
    const declared = [...HELLO_WORKFLOW.matchAll(/title: '([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(used, declared)
  })
})

function fakePackage(): string {
  const root = tmpDir('uc-pkg-')
  writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '9.8.7' }))
  writeFile(join(root, 'types', 'workflow.d.ts'), 'declare function agent(): void\n')
  writeFile(join(root, 'skills', 'ultracode-workflow', 'SKILL.md'), '---\nname: ultracode-workflow\n---\nobsah\n')
  writeFile(join(root, 'skills', 'ultracode-workflow', 'references', 'api.md'), 'API\n')
  return root
}

describe('types', () => {
  it('default: zapíše <cwd>/.ultracode/workflow.d.ts a vypíše reference path', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    const code = await main(['types'], cap.io, { packageRoot: root })
    assert.equal(code, 0)
    assert.equal(readFileSync(join(cwd, '.ultracode', 'workflow.d.ts'), 'utf8'), 'declare function agent(): void\n')
    assert.equal(cap.out(), '/// <reference path="../workflow.d.ts" />\n')
    assert.match(cap.err(), /Typy zapsány: .*workflow\.d\.ts/)
  })

  it('--out relativní k cwd procesu, reference path vůči .ultracode/workflows', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    const code = await main(['types', '--out', 'typy/ven'], cap.io, { packageRoot: root })
    assert.equal(code, 0)
    assert.ok(existsSync(join(cwd, 'typy', 'ven', 'workflow.d.ts')))
    assert.equal(cap.out(), '/// <reference path="../../typy/ven/workflow.d.ts" />\n')
  })

  it('přepíše starší verzi typů', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    writeFile(join(cwd, '.ultracode', 'workflow.d.ts'), 'STARE')
    await main(['types'], makeIO({ cwd }).io, { packageRoot: root })
    assert.match(readFileSync(join(cwd, '.ultracode', 'workflow.d.ts'), 'utf8'), /declare function agent/)
  })

  it('chybějící zdrojový soubor → exit 1; zbytečné argumenty → 2', async () => {
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    assert.equal(await main(['types'], cap.io, { packageRoot: tmpDir() }), 1)
    assert.match(cap.err(), /Zápis typů selhal/)
    assert.equal(await main(['types', 'extra'], makeIO({ cwd }).io, { packageRoot: fakePackage() }), 2)
  })

  it('skutečný balíček obsahuje types/workflow.d.ts', async () => {
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    assert.equal(await main(['types'], cap.io, { packageRoot: REAL_ROOT }), 0)
    assert.match(readFileSync(join(cwd, '.ultracode', 'workflow.d.ts'), 'utf8'), /declare function agent/)
  })
})

describe('skill install', () => {
  it('--project kopíruje celý strom do <cwd>/.claude/skills/ultracode-workflow', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    const code = await main(['skill', 'install', '--project'], cap.io, { packageRoot: root })
    assert.equal(code, 0)
    const dest = join(cwd, '.claude', 'skills', 'ultracode-workflow')
    assert.match(readFileSync(join(dest, 'SKILL.md'), 'utf8'), /obsah/)
    assert.equal(readFileSync(join(dest, 'references', 'api.md'), 'utf8'), 'API\n')
    assert.match(cap.out(), /nainstalován \(2 souborů\)/)
  })

  it('default (--user) jde do $HOME/.claude/skills; CLAUDE_CONFIG_DIR má přednost', async () => {
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

  it('nic nepřepisuje bez --force; s --force přepíše', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const dest = join(cwd, '.claude', 'skills', 'ultracode-workflow')
    writeFile(join(dest, 'SKILL.md'), 'MOJE ÚPRAVY')

    const cap = makeIO({ cwd })
    const code = await main(['skill', 'install', '--project'], cap.io, { packageRoot: root })
    assert.equal(code, 2)
    assert.match(cap.err(), /--force/)
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'MOJE ÚPRAVY', 'soubor nesmí být přepsán')
    assert.ok(!existsSync(join(dest, 'references')), 'nesmí se zkopírovat ani zbytek')

    const forced = makeIO({ cwd })
    assert.equal(await main(['skill', 'install', '--project', '--force'], forced.io, { packageRoot: root }), 0)
    assert.match(readFileSync(join(dest, 'SKILL.md'), 'utf8'), /obsah/)
    assert.ok(existsSync(join(dest, 'references', 'api.md')))
  })

  it('opakovaná instalace identického skillu je OK i bez --force', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    await main(['skill', 'install', '--project'], makeIO({ cwd }).io, { packageRoot: root })
    const cap = makeIO({ cwd })
    assert.equal(await main(['skill', 'install', '--project'], cap.io, { packageRoot: root }), 0)
    assert.match(cap.out(), /již nainstalován a aktuální/)
  })

  it('--user a --project současně / bez podpříkazu / neznámý podpříkaz → 2', async () => {
    const root = fakePackage()
    const e = (argv: string[]) => main(argv, makeIO({ cwd: tmpDir() }).io, { packageRoot: root })
    assert.equal(await e(['skill', 'install', '--user', '--project']), 2)
    assert.equal(await e(['skill']), 2)
    assert.equal(await e(['skill', 'remove']), 2)
  })

  it('balíček bez skillu → exit 1', async () => {
    const root = tmpDir()
    const cap = makeIO({ cwd: tmpDir() })
    assert.equal(await main(['skill', 'install', '--project'], cap.io, { packageRoot: root }), 1)
    assert.match(cap.err(), /chybí skill/)
  })

  it('skutečný skill z balíčku se dá nainstalovat (pokud existuje)', async (t) => {
    if (!existsSync(join(REAL_ROOT, 'skills', 'ultracode-workflow', 'SKILL.md'))) {
      t.skip('skills/ultracode-workflow ještě není k dispozici')
      return
    }
    const cwd = tmpDir()
    assert.equal(await main(['skill', 'install', '--project'], makeIO({ cwd }).io, { packageRoot: REAL_ROOT }), 0)
    assert.ok(existsSync(join(cwd, '.claude', 'skills', 'ultracode-workflow', 'SKILL.md')))
  })
})

describe('init', () => {
  it('vytvoří workflows/hello.workflow.ts, typy a .gitignore', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    const cap = makeIO({ cwd })
    const code = await main(['init'], cap.io, { packageRoot: root })
    assert.equal(code, 0)
    assert.equal(readFileSync(join(cwd, '.ultracode', 'workflows', 'hello.workflow.ts'), 'utf8'), HELLO_WORKFLOW)
    assert.ok(existsSync(join(cwd, '.ultracode', 'workflow.d.ts')))
    assert.match(readFileSync(join(cwd, '.ultracode', '.gitignore'), 'utf8'), /^runs\/$/m)
    assert.match(cap.out(), /Vytvořen: .*hello\.workflow\.ts/)
  })

  it('nepřepíše upravený hello bez --force; s --force ano', async () => {
    const root = fakePackage()
    const cwd = tmpDir()
    await main(['init'], makeIO({ cwd }).io, { packageRoot: root })
    const hello = join(cwd, '.ultracode', 'workflows', 'hello.workflow.ts')
    writeFileSync(hello, 'MOJE')
    const cap = makeIO({ cwd })
    assert.equal(await main(['init'], cap.io, { packageRoot: root }), 0)
    assert.equal(readFileSync(hello, 'utf8'), 'MOJE')
    assert.match(cap.out(), /Ponechán \(už existuje\)/)
    assert.equal(await main(['init', '--force'], makeIO({ cwd }).io, { packageRoot: root }), 0)
    assert.equal(readFileSync(hello, 'utf8'), HELLO_WORKFLOW)
  })

  it('selhání (chybí typy v balíčku) → exit 1', async () => {
    const cap = makeIO({ cwd: tmpDir() })
    assert.equal(await main(['init'], cap.io, { packageRoot: tmpDir() }), 1)
    assert.match(cap.err(), /Inicializace selhala/)
  })
})

describe('nápověda a verze', () => {
  it('--help / -h / help → stdout, exit 0, česky se všemi příkazy', async () => {
    for (const argv of [['--help'], ['-h'], ['help']]) {
      const cap = makeIO()
      assert.equal(await main(argv, cap.io, {}), 0)
      for (const word of ['run', 'resume', 'status', 'list', 'logs', 'validate', 'types', 'skill install', 'init', 'Exit kódy', 'Použití']) {
        assert.ok(cap.out().includes(word), `${argv.join(' ')}: chybí „${word}“`)
      }
      assert.equal(cap.err(), '')
    }
  })

  it('bez argumentů: nápověda na stderr, exit 2', async () => {
    const cap = makeIO()
    assert.equal(await main([], cap.io, {}), 2)
    assert.match(cap.err(), /Použití:/)
    assert.equal(cap.out(), '')
  })

  it('nápověda konkrétního příkazu: help <cmd> i <cmd> --help (bez spuštění příkazu)', async () => {
    const a = makeIO()
    assert.equal(await main(['help', 'run'], a.io, {}), 0)
    assert.match(a.out(), /Použití: ultracode run/)
    assert.match(a.out(), /--max-usd/)
    let engineCalled = false
    const b = makeIO()
    const code = await main(['run', '--help'], b.io, {
      runWorkflow: async () => {
        engineCalled = true
        throw new Error('nesmí být voláno')
      },
    })
    assert.equal(code, 0)
    assert.equal(engineCalled, false)
    assert.match(b.out(), /Použití: ultracode run/)
    const c = makeIO()
    assert.equal(await main(['skill', 'install', '-h'], c.io, {}), 0)
    assert.match(c.out(), /skill install/)
  })

  it('neznámé téma nápovědy a neznámý příkaz → 2', async () => {
    const a = makeIO()
    assert.equal(await main(['help', 'nic'], a.io, {}), 2)
    const b = makeIO()
    assert.equal(await main(['--cwd', 'x', 'run'], b.io, {}), 2)
    assert.match(b.err(), /příkaz musí být první/)
  })

  it('--version vypíše verzi z package.json balíčku', async () => {
    const cap = makeIO()
    assert.equal(await main(['--version'], cap.io, { packageRoot: fakePackage() }), 0)
    assert.equal(cap.out(), 'ultracode 9.8.7\n')
    const real = makeIO()
    await main(['--version'], real.io, {})
    const pkg = JSON.parse(readFileSync(join(REAL_ROOT, 'package.json'), 'utf8')) as { version: string }
    assert.equal(real.out(), `ultracode ${pkg.version}\n`)
  })
})
