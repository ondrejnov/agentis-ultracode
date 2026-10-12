/** Test shimu bin/ultracode.mjs jako skutečného procesu. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { tmpDir, writeFile } from './helpers.ts'

const REAL_BIN = join(import.meta.dirname, '..', '..', 'bin', 'ultracode.mjs')

describe('bin/ultracode.mjs (skutečný proces)', () => {
  it('je spustitelný a má shebang', () => {
    assert.ok(statSync(REAL_BIN).mode & 0o111, 'chybí +x')
  })

  it('--version a --help: exit 0, výstup na stdout', () => {
    const v = spawnSync(process.execPath, [REAL_BIN, '--version'], { encoding: 'utf8' })
    assert.equal(v.status, 0)
    assert.match(v.stdout, /^ultracode \d+\.\d+\.\d+/)
    const h = spawnSync(process.execPath, [REAL_BIN, 'help'], { encoding: 'utf8' })
    assert.equal(h.status, 0)
    assert.match(h.stdout, /dynamická workflow/)
  })

  it('neznámý příkaz → exit 2 a hláška na stderr', () => {
    const r = spawnSync(process.execPath, [REAL_BIN, 'blabla'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /neznámý příkaz/)
    assert.equal(r.stdout, '')
  })

  it('run bez workflow → exit 2 (bez barev, protože stderr není TTY)', () => {
    const r = spawnSync(process.execPath, [REAL_BIN, 'run'], { encoding: 'utf8', cwd: tmpDir() })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /Chybí workflow/)
    assert.doesNotMatch(r.stderr, /\u001b\[/)
  })

  it('init + types v dočasném adresáři přes skutečný proces', () => {
    const cwd = tmpDir()
    const r = spawnSync(process.execPath, [REAL_BIN, 'init'], { encoding: 'utf8', cwd })
    assert.equal(r.status, 0, r.stderr)
    const t = spawnSync(process.execPath, [REAL_BIN, 'types', '--out', 'out'], { encoding: 'utf8', cwd })
    assert.equal(t.status, 0, t.stderr)
    assert.equal(t.stdout.trim(), '/// <reference path="../../out/workflow.d.ts" />')
  })
})

/**
 * Shim s podvrženým dist/cli/cli.js: ověříme, že existující dist má přednost před src,
 * že signál SIGINT/SIGTERM abortuje AbortSignal a že druhý SIGINT ukončí proces okamžitě.
 */
function makeShimPackage(mainBody: string): string {
  const root = tmpDir('uc-shim-')
  mkdirSync(join(root, 'bin'), { recursive: true })
  copyFileSync(REAL_BIN, join(root, 'bin', 'ultracode.mjs'))
  writeFile(join(root, 'package.json'), '{"type":"module"}')
  writeFile(join(root, 'dist', 'cli', 'cli.js'), `export async function main(argv, io, deps) {\n${mainBody}\n}\n`)
  return join(root, 'bin', 'ultracode.mjs')
}

function waitForLine(child: ReturnType<typeof spawn>, re: RegExp, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error(`timeout čekání na ${re}; stdout=${buf}`)), timeoutMs)
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString()
      if (re.test(buf)) {
        clearTimeout(t)
        resolve()
      }
    })
  })
}

function exitOf(child: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('proces neskončil včas'))
    }, timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(t)
      resolve({ code, signal })
    })
  })
}

describe('bin: signály a exit kód', () => {
  it('předá argv a io, nastaví exit kód podle návratové hodnoty main', async () => {
    const bin = makeShimPackage(`
      io.stdout.write(JSON.stringify({ argv, cwd: io.cwd, hasSignal: deps.signal instanceof AbortSignal, tty: io.isTTY }) + '\\n')
      return 7`)
    const r = spawnSync(process.execPath, [bin, 'a', '--b', 'c'], { encoding: 'utf8' })
    assert.equal(r.status, 7)
    const j = JSON.parse(r.stdout)
    assert.deepEqual(j.argv, ['a', '--b', 'c'])
    assert.equal(j.hasSignal, true)
    assert.equal(j.tty, false)
  })

  it('SIGINT abortuje signál; main doběhne a vrátí 130', async () => {
    const bin = makeShimPackage(`
      const keep = setInterval(() => {}, 1000) // jako běžící potomek: drží event loop
      io.stdout.write('ready\\n')
      await new Promise((r) => deps.signal.addEventListener('abort', r, { once: true }))
      clearInterval(keep)
      return 130`)
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForLine(child, /ready/)
    child.kill('SIGINT')
    const { code } = await exitOf(child)
    assert.equal(code, 130)
  })

  it('SIGTERM také abortuje', async () => {
    const bin = makeShimPackage(`
      const keep = setInterval(() => {}, 1000)
      io.stdout.write('ready\\n')
      await new Promise((r) => deps.signal.addEventListener('abort', r, { once: true }))
      clearInterval(keep)
      return 130`)
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForLine(child, /ready/)
    child.kill('SIGTERM')
    assert.equal((await exitOf(child)).code, 130)
  })

  it('druhý SIGINT ukončí proces okamžitě, i když main abort ignoruje', async () => {
    const bin = makeShimPackage(`
      setInterval(() => {}, 1000)
      io.stdout.write('ready\\n')
      await new Promise(() => {})   // visí navždy
      return 0`)
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForLine(child, /ready/)
    child.kill('SIGINT')
    await new Promise((r) => setTimeout(r, 150))
    child.kill('SIGINT')
    const { code } = await exitOf(child, 3000)
    assert.equal(code, 130)
  })

  it('výjimka v main → exit 1 a zpráva na stderr', () => {
    const bin = makeShimPackage(`throw new Error('bum')`)
    const r = spawnSync(process.execPath, [bin], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /neočekávaná chyba.*bum/s)
  })

  it('SIGHUP (zavření terminálu) také abortuje a main doběhne s úklidem', async () => {
    const bin = makeShimPackage(`
      const keep = setInterval(() => {}, 1000)
      io.stdout.write('ready\\n')
      await new Promise((r) => deps.signal.addEventListener('abort', r, { once: true }))
      clearInterval(keep)
      return 130`)
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForLine(child, /ready/)
    child.kill('SIGHUP')
    const { code, signal } = await exitOf(child)
    assert.equal(signal, null, 'proces nesmí skončit na výchozí akci SIGHUP (bez úklidu)')
    assert.equal(code, 130)
  })

  it('velký výstup do pomalu čtoucí roury se neuseká pojistkou (stdout = úplný JSON)', async () => {
    const size = 8_000_000
    const bin = makeShimPackage(`
      io.stdout.write(JSON.stringify({ s: 'x'.repeat(${size}) }) + '\\n')
      return 0`)
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    // odběratel začne číst až po 3,5 s (pojistka bin má 3 s)
    child.stdout!.pause()
    const chunks: Buffer[] = []
    setTimeout(() => {
      child.stdout!.on('data', (c: Buffer) => chunks.push(c))
      child.stdout!.resume()
    }, 3500)
    const { code } = await exitOf(child, 15_000)
    // 'exit' může přijít dřív než dočteme data → počkej na konec streamu
    await new Promise((r) => (child.stdout!.readableEnded ? r(null) : child.stdout!.once('end', () => r(null))))
    const text = Buffer.concat(chunks).toString('utf8')
    assert.equal(code, 0)
    assert.equal(text.length, size + 8 + 1, `přišlo ${text.length} znaků`)
    assert.equal((JSON.parse(text) as { s: string }).s.length, size)
  })

  it('zavřená rourou na stdout/stderr (EPIPE) nesmí shodit proces ani změnit exit kód', async () => {
    const bin = makeShimPackage(`
      io.stdout.write('ready\\n')
      await new Promise((r) => setTimeout(r, 600))
      io.stdout.write('a'.repeat(100000) + '\\n')
      io.stderr.write('b'.repeat(100000) + '\\n')
      await new Promise((r) => setTimeout(r, 100))
      io.stdout.write('c\\n')
      io.stderr.write('d\\n')
      return 5`)
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForLine(child, /ready/)
    child.stdout!.destroy()
    child.stderr!.destroy()
    const { code } = await exitOf(child, 10_000)
    assert.equal(code, 5)
  })

  it('pojistka pořád ukončí proces, který drží event loop (zapomenutý potomek) – i po vyprázdnění výstupu', async () => {
    const bin = makeShimPackage(`
      setInterval(() => {}, 1000)
      io.stdout.write('hotovo\\n')
      return 3`)
    const t0 = Date.now()
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    const { code } = await exitOf(child, 10_000)
    assert.equal(code, 3)
    assert.ok(Date.now() - t0 < 6000)
  })
})

describe('přímé spuštění src/cli/cli.ts (stejné ošetření jako bin)', () => {
  const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli', 'cli.ts')
  const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs')

  function slowProject(): string {
    const cwd = tmpDir('uc-direct-')
    writeFile(
      join(cwd, '.ultracode', 'workflows', 'slow.workflow.ts'),
      `export const meta = { name: 'slow', description: 'pomalý agent' }
const r = await agent('pomalu [[fake:sleep 20000]]', { label: 'slow' })
return { r }
`,
    )
    return cwd
  }

  it('SIGHUP abortuje běh: exit 130, run.json aborted, žádný osiřelý agent', async () => {
    const cwd = slowProject()
    const fakeLog = join(cwd, 'fake.log')
    const env = { ...process.env, ULTRACODE_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: fakeLog, ULTRACODE_KILL_GRACE_MS: '500', NO_COLOR: '1' }
    const child = spawn(process.execPath, [CLI, 'run', 'slow', '--run-id', 'hup1'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr!.on('data', (c: Buffer) => (err += c.toString()))
    const t = Date.now()
    while (!/slow/.test(err) && Date.now() - t < 8000) await new Promise((r) => setTimeout(r, 25))
    await new Promise((r) => setTimeout(r, 300)) // agent opravdu rozběhnutý
    child.kill('SIGHUP')
    const { code, signal } = await exitOf(child, 10_000)
    assert.equal(signal, null, err)
    assert.equal(code, 130, err)
    const run = JSON.parse(readFileSync(join(cwd, '.ultracode', 'runs', 'hup1', 'run.json'), 'utf8'))
    assert.equal(run.status, 'aborted')
    // fake-claude zapíše řádek logu až při ukončení (SIGTERM) → agent byl uklizen, neběží osiřele
    const t2 = Date.now()
    while (!existsSync(fakeLog) && Date.now() - t2 < 3000) await new Promise((r) => setTimeout(r, 25))
    assert.ok(existsSync(fakeLog), 'agent nebyl ukončen')
  })
})
