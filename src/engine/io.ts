/**
 * Robust file primitives of the engine: atomic write, serialized JSONL append and a coalescing state writer.
 * None of the classes throw from their main methods — write errors are reported via `onError` so that a disk failure does not crash the run.
 */
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Atomic write: a temporary file in the same directory + rename. A reader never sees a half-written file. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Ensures that a non-empty file ends with `\n`. After a forcibly terminated process the last JSONL line may lack its
 * ending; without this step the next append would be glued onto the truncated line and corrupt the new record as well.
 */
export async function ensureTrailingNewline(path: string): Promise<void> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return // file does not exist
  }
  try {
    const { size } = await fh.stat()
    if (size === 0) return
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    if (buf[0] === 0x0a) return
  } finally {
    await fh.close()
  }
  await appendFile(path, '\n', 'utf8')
}

interface PendingLine {
  line: string
  done: () => void
}

/**
 * Append-only JSONL file. Concurrent `append()` calls are queued and written in the same order,
 * in one `appendFile` per batch. The returned Promise resolves once the line is on disk (it never rejects).
 */
export class JsonlAppender {
  private readonly path: string
  private readonly onError: (err: unknown) => void
  private pending: PendingLine[] = []
  private writing: Promise<void> | null = null
  private dirEnsured = false

  constructor(path: string, onError: (err: unknown) => void = () => {}) {
    this.path = path
    this.onError = onError
  }

  append(value: unknown): Promise<void> {
    let line: string
    try {
      line = JSON.stringify(value) + '\n'
    } catch (err) {
      this.onError(err)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.pending.push({ line, done: resolve })
      if (!this.writing) this.writing = this.drain()
    })
  }

  /** Waits until the queue is drained. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const batch = this.pending
        this.pending = []
        try {
          if (!this.dirEnsured) {
            await mkdir(dirname(this.path), { recursive: true })
            this.dirEnsured = true
          }
          await appendFile(this.path, batch.map((b) => b.line).join(''), 'utf8')
        } catch (err) {
          this.onError(err)
        }
        for (const b of batch) b.done()
      }
    } finally {
      this.writing = null
    }
  }
}

/**
 * Writer of the state file (run.json): write requests are coalesced — always the latest state is written,
 * never two writes at the same time. `request()` resolves once a write started after its call has completed.
 */
export class StateFileWriter {
  private readonly path: string
  private readonly getState: () => unknown
  private readonly onError: (err: unknown) => void
  private running: Promise<void> | null = null
  private dirty = false

  constructor(path: string, getState: () => unknown, onError: (err: unknown) => void = () => {}) {
    this.path = path
    this.getState = getState
    this.onError = onError
  }

  request(): Promise<void> {
    this.dirty = true
    if (!this.running) this.running = this.loop()
    return this.running
  }

  private async loop(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false
        try {
          await writeFileAtomic(this.path, JSON.stringify(this.getState(), null, 2) + '\n')
        } catch (err) {
          this.onError(err)
        }
      }
    } finally {
      this.running = null
    }
  }
}
