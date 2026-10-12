#!/usr/bin/env node
// Tenký shim: načte přeložené CLI z dist/, jinak (vývoj) přímo TypeScript přes Node type-stripping.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  process.stderr.write(`ultracode: vyžaduje Node.js >= 22.18 (máš ${process.versions.node}).\n`)
  process.exit(1)
}

// Zavřená rourou (`| head`, `| true`) nesmí shodit běh ani změnit exit kód: EPIPE/EIO na stdout/stderr
// se ignoruje (průběh jen přestane být vidět), jiné chyby zápisu se vyhodí jako dřív.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => {
    if (e && (e.code === 'EPIPE' || e.code === 'EIO' || e.code === 'ECONNRESET')) return
    throw e
  })
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = join(root, 'dist', 'cli', 'cli.js')
const srcEntry = join(root, 'src', 'cli', 'cli.ts')
// ULTRACODE_FORCE_SRC=1 vynutí spuštění ze zdrojů (vývoj/testy), i když existuje starší dist/.
const forceSrc = process.env.ULTRACODE_FORCE_SRC === '1' && existsSync(srcEntry)
const entry = !forceSrc && existsSync(distEntry) ? distEntry : srcEntry

let main
try {
  ;({ main } = await import(pathToFileURL(entry).href))
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e)
  const hint = entry === srcEntry ? ' (chybí dist/, spusť „npm run build“)' : ''
  process.stderr.write(`ultracode: nelze načíst ${entry}${hint}: ${detail}\n`)
  process.exit(1)
}

// SIGINT/SIGTERM/SIGHUP → AbortController; druhý SIGINT = okamžitý konec.
const controller = new AbortController()
let interrupts = 0
process.on('SIGINT', () => {
  interrupts++
  if (interrupts >= 2) process.exit(130)
  process.stderr.write('\nultracode: přerušuji běh (dalším Ctrl+C skončím okamžitě)…\n')
  controller.abort()
})
process.on('SIGTERM', () => {
  controller.abort()
})
// SIGHUP (zavření terminálu, pád SSH): bez handleru by proces skončil bez úklidu a agenti (detached) by
// běželi osiřele. Nic nepíšeme na stderr – terminál už je pryč.
process.on('SIGHUP', () => {
  controller.abort()
})

let code = 1
try {
  code = await main(
    process.argv.slice(2),
    {
      stdout: process.stdout,
      stderr: process.stderr,
      isTTY: Boolean(process.stderr.isTTY),
      stdoutIsTTY: Boolean(process.stdout.isTTY),
      env: process.env,
      cwd: process.cwd(),
    },
    { signal: controller.signal },
  )
} catch (e) {
  process.stderr.write(`ultracode: neočekávaná chyba: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  code = 1
}

process.exitCode = code
// pojistka: kdyby něco drželo event loop (zapomenutý potomek), nenech proces viset. Ale až po vyprázdnění
// stdout/stderr: zápis do roury je asynchronní a pomalý odběratel by jinak dostal useknutý výstup.
setTimeout(() => {
  const exit = () => process.exit(code)
  if (process.stdout.writableLength === 0 && process.stderr.writableLength === 0) exit()
  else process.stdout.write('', () => process.stderr.write('', exit))
}, 3000).unref()
