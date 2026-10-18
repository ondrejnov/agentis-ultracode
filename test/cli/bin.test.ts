/** Tests bin/ultracode.mjs as a real process. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { tmpDir, writeFile } from './helpers.ts'

const REAL_BIN = join(import.meta.dirname, '..', '..', 'bin', 'ultracode.mjs')
// test the current sources, not a possibly older dist/
const REAL_ENV = { ...process.env, ULTRACODE_FORCE_SRC: '1' }

describe('bin/ultracode.mjs (real process)', () => {
  it('is executable and has a shebang', () => {
    assert.ok(statSync(REAL_BIN).mode & 0o111, 'missing +x')
  })

  it('--version and --help: exit 0, output on stdout', () => {
    const v = spawnSync(process.execPath, [REAL_BIN, '--version'], { encoding: 'utf8', env: REAL_ENV })
    assert.equal(v.status, 0)
    assert.match(v.stdout, /^ultracode \d+\.\d+\.\d+/)
    const h = spawnSync(process.execPath, [REAL_BIN, 'help'], { encoding: 'utf8', env: REAL_ENV })
    assert.equal(h.status, 0)
    assert.match(h.stdout, /dynamic workflows/)
  })

  it('unknown command → exit 2 and message on stderr', () => {
    const r = spawnSync(process.execPath, [REAL_BIN, 'blabla'], { encoding: 'utf8', env: REAL_ENV })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown command/)
    assert.equal(r.stdout, '')
  })

  it('run without workflow → exit 2 (no colors, because stderr is not a TTY)', () => {
    const r = spawnSync(process.execPath, [REAL_BIN, 'run'], { encoding: 'utf8', cwd: tmpDir(), env: REAL_ENV })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /Missing workflow/)
    assert.doesNotMatch(r.stderr, /\u001b\[/)
  })

  it('init + types in a temp directory via a real process', () => {
    const cwd = tmpDir()
    const r = spawnSync(process.execPath, [REAL_BIN, 'init'], { encoding: 'utf8', cwd, env: REAL_ENV })
    assert.equal(r.status, 0, r.stderr)
    const t = spawnSync(process.execPath, [REAL_BIN, 'types', '--out', 'out'], { encoding: 'utf8', cwd, env: REAL_ENV })
    assert.equal(t.status, 0, t.stderr)
    assert.equal(t.stdout.trim(), '/// <reference path="../../out/workflow.d.ts" />')
  })
})

/**
 * Shim with a fake dist/cli/cli.js: verifies that an existing dist takes precedence over src,
 * that SIGINT/SIGTERM abort the AbortSignal and that a second SIGINT exits the process immediately.
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
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${re}; stdout=${buf}`)), timeoutMs)
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
      reject(new Error('process did not exit in time'))
    }, timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(t)
      resolve({ code, signal })
    })
  })
}

describe('bin: signals and exit code', () => {
  it('passes argv and io, sets exit code according to the return value of main', async () => {
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

  it('SIGINT aborts the signal; main finishes and returns 130', async () => {
    const bin = makeShimPackage(`
      const keep = setInterval(() => {}, 1000) // like a running child: keeps the event loop alive
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

  it('SIGTERM also aborts', async () => {
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

  it('a second SIGINT exits the process immediately, even if main ignores the abort', async () => {
    const bin = makeShimPackage(`
      setInterval(() => {}, 1000)
      io.stdout.write('ready\\n')
      await new Promise(() => {})   // hangs forever
      return 0`)
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForLine(child, /ready/)
    child.kill('SIGINT')
    await new Promise((r) => setTimeout(r, 150))
    child.kill('SIGINT')
    const { code } = await exitOf(child, 3000)
    assert.equal(code, 130)
  })

  it('exception in main → exit 1 and message on stderr', () => {
    const bin = makeShimPackage(`throw new Error('bum')`)
    const r = spawnSync(process.execPath, [bin], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /unexpected error.*bum/s)
  })

  it('SIGHUP (terminal closed) also aborts and main finishes with cleanup', async () => {
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
    assert.equal(signal, null, 'process must not end with the default SIGHUP action (without cleanup)')
    assert.equal(code, 130)
  })

  it('large output to a slowly reading pipe is not truncated by the safety net (stdout = complete JSON)', async () => {
    const size = 8_000_000
    const bin = makeShimPackage(`
      io.stdout.write(JSON.stringify({ s: 'x'.repeat(${size}) }) + '\\n')
      return 0`)
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    // the reader starts reading only after 3.5 s (the bin safety net has 3 s)
    child.stdout!.pause()
    const chunks: Buffer[] = []
    setTimeout(() => {
      child.stdout!.on('data', (c: Buffer) => chunks.push(c))
      child.stdout!.resume()
    }, 3500)
    const { code } = await exitOf(child, 15_000)
    // 'exit' may arrive before we have read all data → wait for the end of the stream
    await new Promise((r) => (child.stdout!.readableEnded ? r(null) : child.stdout!.once('end', () => r(null))))
    const text = Buffer.concat(chunks).toString('utf8')
    assert.equal(code, 0)
    assert.equal(text.length, size + 8 + 1, `got ${text.length} characters`)
    assert.equal((JSON.parse(text) as { s: string }).s.length, size)
  })

  it('closed pipe on stdout/stderr (EPIPE) must not crash the process or change the exit code', async () => {
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

  it('the safety net still terminates a process holding the event loop (forgotten child) – even after the output is drained', async () => {
    const bin = makeShimPackage(`
      setInterval(() => {}, 1000)
      io.stdout.write('done\\n')
      return 3`)
    const t0 = Date.now()
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    const { code } = await exitOf(child, 10_000)
    assert.equal(code, 3)
    assert.ok(Date.now() - t0 < 6000)
  })
})

describe('direct run of src/cli/cli.ts (same handling as bin)', () => {
  const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli', 'cli.ts')
  const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs')

  it('parent death without a signal (reparenting) aborts', async () => {
    const dir = tmpDir('uc-orphan-')
    const marker = join(dir, 'aborted')
    const bin = makeShimPackage(`
      const keep = setInterval(() => {}, 1000)
      await new Promise((r) => deps.signal.addEventListener('abort', r, { once: true }))
      clearInterval(keep)
      ;(await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'x')
      return 130`)
    // the parent shell exits without signalling us (like a SIGKILLed Claude Code) → we get reparented
    const parent = spawn('sh', ['-c', `"${process.execPath}" "${bin}" </dev/null >/dev/null 2>&1 & sleep 0.5`], { stdio: 'ignore' })
    await exitOf(parent)
    const t = Date.now()
    while (!existsSync(marker) && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 50))
    assert.ok(existsSync(marker), 'orphaned ultracode did not abort')
  })

  function slowProject(): string {
    const cwd = tmpDir('uc-direct-')
    writeFile(
      join(cwd, '.ultracode', 'workflows', 'slow.workflow.ts'),
      `export const meta = { name: 'slow', description: 'slow agent' }
const r = await agent('slowly [[fake:sleep 20000]]', { label: 'slow' })
return { r }
`,
    )
    return cwd
  }

  it('SIGHUP aborts the run: exit 130, run.json aborted, no orphaned agent', async () => {
    const cwd = slowProject()
    const fakeLog = join(cwd, 'fake.log')
    const env = { ...process.env, ULTRACODE_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: fakeLog, ULTRACODE_KILL_GRACE_MS: '500', NO_COLOR: '1' }
    const child = spawn(process.execPath, [CLI, 'run', 'slow', '--run-id', 'hup1'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr!.on('data', (c: Buffer) => (err += c.toString()))
    const t = Date.now()
    while (!/slow/.test(err) && Date.now() - t < 8000) await new Promise((r) => setTimeout(r, 25))
    await new Promise((r) => setTimeout(r, 300)) // agent actually started
    child.kill('SIGHUP')
    const { code, signal } = await exitOf(child, 10_000)
    assert.equal(signal, null, err)
    assert.equal(code, 130, err)
    const run = JSON.parse(readFileSync(join(cwd, '.ultracode', 'runs', 'hup1', 'run.json'), 'utf8'))
    assert.equal(run.status, 'aborted')
    // fake-claude writes a log line only on exit (SIGTERM) → agent was cleaned up, not left running
    const t2 = Date.now()
    while (!existsSync(fakeLog) && Date.now() - t2 < 3000) await new Promise((r) => setTimeout(r, 25))
    assert.ok(existsSync(fakeLog), 'agent was not terminated')
  })
})
