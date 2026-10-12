/**
 * Robustní souborové primitivy enginu: atomický zápis, serializovaný append JSONL a slučující se zapisovač stavu.
 * Žádná z tříd nehází z hlavních metod — chyby zápisu se hlásí přes `onError`, aby výpadek disku neshodil běh.
 */
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Atomický zápis: dočasný soubor ve stejném adresáři + rename. Čtenář nikdy neuvidí napůl zapsaný soubor. */
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
 * Zajistí, že neprázdný soubor končí `\n`. Po násilně ukončeném procesu může poslední JSONL řádek chybět
 * konec; bez tohoto kroku by se další append slepil s useknutým řádkem a poškodil i nový záznam.
 */
export async function ensureTrailingNewline(path: string): Promise<void> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return // soubor neexistuje
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
 * Append-only JSONL soubor. Souběžná volání `append()` se řadí do fronty a zapisují se ve stejném pořadí,
 * v jednom `appendFile` na dávku. Vrácený Promise se splní, až je řádek na disku (nikdy neodmítne).
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

  /** Počká, až se vyprázdní fronta. */
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
 * Zapisovač stavového souboru (run.json): žádosti o zápis se slučují — zapisuje se vždy nejnovější stav,
 * nikdy dva zápisy souběžně. `request()` se splní, až proběhl zápis započatý po jeho zavolání.
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
