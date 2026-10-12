/** Férový (FIFO) semafor pro omezení souběžnosti agentů; čekání jde přerušit přes AbortSignal. */
import { AbortedError } from '../errors.ts'

export class Semaphore {
  readonly limit: number
  private active = 0
  private maxActive = 0
  private waiters: Array<() => void> = []

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`Limit semaforu musí být celé číslo >= 1, dostal jsem ${limit}.`)
    this.limit = limit
  }

  /** Aktuálně držené sloty. */
  get inUse(): number {
    return this.active
  }

  /** Nejvyšší dosažená souběžnost (pro diagnostiku/testy). */
  get peak(): number {
    return this.maxActive
  }

  get waiting(): number {
    return this.waiters.length
  }

  /**
   * Získá slot; vrací funkci `release` (idempotentní). Při abortu čekání odmítne `AbortedError`
   * a slot se nezíská.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new AbortedError())
    if (this.active < this.limit) return Promise.resolve(this.take())
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(grant)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new AbortedError())
      }
      const grant = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(this.take())
      }
      this.waiters.push(grant)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private take(): () => void {
    this.active++
    if (this.active > this.maxActive) this.maxActive = this.active
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const next = this.waiters.shift()
      if (next) next()
    }
  }
}
