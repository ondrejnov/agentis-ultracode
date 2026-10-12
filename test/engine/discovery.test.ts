import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { findWorkflow, listWorkflows, workflowSearchDirs } from '../../src/engine/discovery.ts'
import { WorkflowNotFoundError } from '../../src/errors.ts'

let root: string
let home: string
let project: string
let envBackup: Record<string, string | undefined>

function put(dir: string, file: string, content = "export const meta = { name: 'x', description: 'd' }\n"): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, file)
  writeFileSync(p, content)
  return p
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ultracode-disc-')))
  home = join(root, 'home')
  project = join(root, 'work', 'proj', 'pkg')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  envBackup = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ULTRACODE_WORKFLOWS_DIR: process.env.ULTRACODE_WORKFLOWS_DIR }
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.ULTRACODE_WORKFLOWS_DIR
})

afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

describe('discovery', () => {
  test('workflowSearchDirs: projekt, rodiče až ke kořeni, ~/.ultracode, $ULTRACODE_WORKFLOWS_DIR (v tomto pořadí)', () => {
    process.env.ULTRACODE_WORKFLOWS_DIR = [join(root, 'shared1'), join(root, 'shared2')].join(delimiter)
    const dirs = workflowSearchDirs(project)
    assert.equal(dirs[0], join(project, '.ultracode', 'workflows'))
    assert.equal(dirs[1], join(root, 'work', 'proj', '.ultracode', 'workflows'))
    assert.equal(dirs[2], join(root, 'work', '.ultracode', 'workflows'))
    assert.ok(dirs.includes(join('/', '.ultracode', 'workflows')))
    assert.equal(dirs[dirs.length - 3], join(home, '.ultracode', 'workflows'))
    assert.equal(dirs[dirs.length - 2], join(root, 'shared1'))
    assert.equal(dirs[dirs.length - 1], join(root, 'shared2'))
    assert.equal(new Set(dirs).size, dirs.length)
  })

  test('findWorkflow: projektový adresář, přípony a priorita .workflow.ts > .workflow.js > .ts > .js', () => {
    const wf = join(project, '.ultracode', 'workflows')
    put(wf, 'alpha.js')
    assert.equal(findWorkflow('alpha', project), join(wf, 'alpha.js'))
    put(wf, 'alpha.ts')
    assert.equal(findWorkflow('alpha', project), join(wf, 'alpha.ts'))
    put(wf, 'alpha.workflow.js')
    assert.equal(findWorkflow('alpha', project), join(wf, 'alpha.workflow.js'))
    put(wf, 'alpha.workflow.ts')
    assert.equal(findWorkflow('alpha', project), join(wf, 'alpha.workflow.ts'))
  })

  test('findWorkflow: nalezne v rodičovském adresáři, projekt přebíjí rodiče', () => {
    const parent = join(root, 'work', 'proj', '.ultracode', 'workflows')
    put(parent, 'deploy.workflow.ts')
    assert.equal(findWorkflow('deploy', project), join(parent, 'deploy.workflow.ts'))
    const own = put(join(project, '.ultracode', 'workflows'), 'deploy.workflow.ts')
    assert.equal(findWorkflow('deploy', project), own)
  })

  test('findWorkflow: uživatelský adresář ~/.ultracode/workflows', () => {
    const f = put(join(home, '.ultracode', 'workflows'), 'global-audit.workflow.ts')
    assert.equal(findWorkflow('global-audit', project), f)
  })

  test('findWorkflow: $ULTRACODE_WORKFLOWS_DIR (i relativní cesta k cwd) jako poslední zdroj', () => {
    const f = put(join(root, 'shared'), 'team-flow.ts')
    process.env.ULTRACODE_WORKFLOWS_DIR = join(root, 'shared')
    assert.equal(findWorkflow('team-flow', project), f)
    process.env.ULTRACODE_WORKFLOWS_DIR = '../../../shared'
    assert.equal(findWorkflow('team-flow', project), f)
    // uživatelský adresář má přednost před env
    const u = put(join(home, '.ultracode', 'workflows'), 'team-flow.ts')
    assert.equal(findWorkflow('team-flow', project), u)
  })

  test('findWorkflow: nenalezeno → WorkflowNotFoundError se seznamem prohledaných adresářů', () => {
    assert.throws(
      () => findWorkflow('nic', project),
      (e: unknown) => {
        assert.ok(e instanceof WorkflowNotFoundError)
        assert.match(e.message, /nic/)
        assert.ok(e.message.includes(join(project, '.ultracode', 'workflows')))
        return true
      },
    )
    assert.throws(() => findWorkflow('', project), WorkflowNotFoundError)
  })

  test('findWorkflow: cesta k existujícímu souboru se vrátí absolutně; adresář se jménem se nebere', () => {
    const f = put(project, 'local.workflow.ts')
    assert.equal(findWorkflow('./local.workflow.ts', project), f)
    assert.equal(findWorkflow(f, project), f)
    mkdirSync(join(project, '.ultracode', 'workflows', 'adresar.ts'), { recursive: true })
    assert.throws(() => findWorkflow('adresar', project), WorkflowNotFoundError)
  })

  test('listWorkflows: jména bez přípon, scope, popis z meta, stínování a ignorování .d.ts', () => {
    const wf = join(project, '.ultracode', 'workflows')
    put(wf, 'b-flow.workflow.ts', "export const meta = {\n  name: 'b-flow',\n  description: 'Najde \\'flaky\\' testy',\n}\n")
    put(wf, 'a-flow.ts', 'export const meta = { name: "a-flow", description: "Popis A" }\n')
    put(wf, 'types.d.ts', 'declare const x: 1\n')
    put(wf, 'readme.md', '# ne')
    put(wf, 'no-meta.js', 'return 1\n')
    put(join(home, '.ultracode', 'workflows'), 'a-flow.ts', "export const meta = { name: 'a', description: 'z home' }\n")
    put(join(home, '.ultracode', 'workflows'), 'home-only.workflow.js', "export const meta = { name: 'h', description: `Šablonový popis` }\n")
    const list = listWorkflows(project)
    assert.deepEqual(
      list.map((w) => [w.name, w.scope, w.description]),
      [
        ['a-flow', 'project', 'Popis A'],
        ['b-flow', 'project', "Najde 'flaky' testy"],
        ['no-meta', 'project', undefined],
        ['home-only', 'user', 'Šablonový popis'],
      ],
    )
    assert.equal(list[0].path, join(wf, 'a-flow.ts'))
  })

  test('listWorkflows: prázdný výsledek, když nic neexistuje', () => {
    assert.deepEqual(listWorkflows(project), [])
  })
})
