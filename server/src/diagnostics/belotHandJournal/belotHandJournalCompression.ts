// Компресия на архивите на belot hand журнала.
//
// Предпочитан формат: Zstandard (.zst) — същият формат като бекъпите на
// Pika.bg (ops/pikabg-backup ползва `zstd` CLI). Backend-ите по ред:
//   1. node-zstd  — вграденият zlib ZSTD в Node (>= 22.15 / 23.8). Без
//                   външни зависимости; работи в libuv threadpool, т.е. не
//                   блокира event loop-а на игровия сървър.
//   2. zstd-cli   — системният `zstd` (apt install zstd), ако Node няма ZSTD.
//   3. node-gzip  — безопасен резервен вариант (.gz), ако няма нито едното;
//                   журналът записва предупреждение, архивите остават четими.
// Всички архиви носят ZSTD content checksum (`zstd -t` го проверява).

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { PassThrough, Readable, Transform, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as zlib from 'node:zlib'

export type BelotJournalCompressionBackend = 'node-zstd' | 'zstd-cli' | 'node-gzip'

export type BelotJournalCompressionOptions = {
  zstdLevel: number
  // Само за тестове: имитира липсващ вграден ZSTD / липсващ CLI.
  disableNodeZstd?: boolean
  disableZstdCli?: boolean
}

export const DEFAULT_BELOT_JOURNAL_ZSTD_LEVEL = 6

export function clampZstdLevel(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_BELOT_JOURNAL_ZSTD_LEVEL
  return Math.min(19, Math.max(1, Math.round(level)))
}

type ZstdZlib = typeof zlib & {
  createZstdCompress?: (options?: { params?: Record<number, number> }) => Transform
  createZstdDecompress?: () => Transform
}
const zlibWithZstd = zlib as ZstdZlib

export function isNodeZstdAvailable(): boolean {
  return typeof zlibWithZstd.createZstdCompress === 'function' && typeof zlibWithZstd.createZstdDecompress === 'function'
}

let zstdCliAvailableCache: boolean | null = null
export function isZstdCliAvailable(): boolean {
  if (zstdCliAvailableCache === null) {
    try {
      const result = spawnSync('zstd', ['--version'], { stdio: 'ignore', timeout: 5000 })
      zstdCliAvailableCache = result.status === 0
    } catch {
      zstdCliAvailableCache = false
    }
  }
  return zstdCliAvailableCache
}

export function selectBelotJournalCompressionBackend(options: BelotJournalCompressionOptions): BelotJournalCompressionBackend {
  if (!options.disableNodeZstd && isNodeZstdAvailable()) return 'node-zstd'
  if (!options.disableZstdCli && isZstdCliAvailable()) return 'zstd-cli'
  return 'node-gzip'
}

export function getArchiveExtensionForBackend(backend: BelotJournalCompressionBackend): '.jsonl.zst' | '.jsonl.gz' {
  return backend === 'node-gzip' ? '.jsonl.gz' : '.jsonl.zst'
}

// Обвива външен процес като Transform-подобен Duplex: пише в stdin, чете от
// stdout; ненулев exit code = грешка в pipeline-а.
function createCliTransform(command: string, args: string[]): Transform {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.on('error', rejectExit)
    child.on('close', (code) => {
      if (code === 0) resolveExit()
      else rejectExit(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))
    })
  })
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      if (!child.stdin.write(chunk)) {
        child.stdin.once('drain', () => callback())
      } else {
        callback()
      }
    },
    flush(callback) {
      child.stdin.end()
      exited.then(() => callback(), (error: Error) => callback(error))
    },
  })
  child.stdout.on('data', (chunk: Buffer) => {
    transform.push(chunk)
  })
  child.stdin.on('error', (error) => transform.destroy(error))
  transform.on('close', () => {
    if (child.exitCode === null) child.kill()
  })
  return transform
}

function createCompressor(backend: BelotJournalCompressionBackend, level: number): Transform {
  if (backend === 'node-zstd') {
    return zlibWithZstd.createZstdCompress!({
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: clampZstdLevel(level),
        [zlib.constants.ZSTD_c_checksumFlag]: 1,
      },
    })
  }
  if (backend === 'zstd-cli') {
    return createCliTransform('zstd', ['-q', `-${clampZstdLevel(level)}`, '--check', '-c', '-'])
  }
  return zlib.createGzip({ level: 6 })
}

export function createBelotJournalDecompressor(filePath: string, options: Pick<BelotJournalCompressionOptions, 'disableNodeZstd' | 'disableZstdCli'> = {}): Transform {
  // Временните (.tmp) и карантинните (.corrupt) файлове носят формата преди
  // наставката.
  const formatPath = filePath.replace(/\.(tmp|corrupt)$/, '')
  if (formatPath.endsWith('.gz')) return zlib.createGunzip()
  if (formatPath.endsWith('.zst')) {
    if (!options.disableNodeZstd && isNodeZstdAvailable()) return zlibWithZstd.createZstdDecompress!()
    if (!options.disableZstdCli && isZstdCliAvailable()) return createCliTransform('zstd', ['-q', '-d', '-c', '-'])
    throw new Error(
      `Няма ZSTD декомпресор за ${filePath}: нужен е Node с вграден zlib ZSTD (>= 22.15) или системен \`zstd\` (apt install zstd).`,
    )
  }
  throw new Error(`Непознат формат на архив: ${filePath}`)
}

export type BelotJournalCompressResult = {
  backend: BelotJournalCompressionBackend
  lineCount: number
  uncompressedBytes: number
  uncompressedSha256: string
  compressedBytes: number
}

export type BelotJournalCompressHooks = {
  // Тестове: хвърля посред компресията (имитира прекъсване).
  failAfterLines?: number
}

// Компресира поток от редове (всеки ред БЕЗ '\n') в targetPath (временният
// файл на архива). Хешира некомпресираното съдържание, за да може
// verifyBelotJournalArchive да докаже, че декомпресираното е идентично.
// Накрая fsync-ва файла, за да е на диска преди атомарното преименуване.
export async function compressBelotJournalLines(params: {
  lines: AsyncIterable<string>
  targetPath: string
  backend: BelotJournalCompressionBackend
  zstdLevel: number
  hooks?: BelotJournalCompressHooks
}): Promise<BelotJournalCompressResult> {
  const hash = createHash('sha256')
  let lineCount = 0
  let uncompressedBytes = 0
  const failAfterLines = params.hooks?.failAfterLines
  async function* encode(): AsyncGenerator<Buffer> {
    for await (const line of params.lines) {
      if (failAfterLines !== undefined && lineCount >= failAfterLines) {
        throw new Error('injected compression failure (test hook)')
      }
      const buffer = Buffer.from(`${line}\n`, 'utf8')
      hash.update(buffer)
      lineCount += 1
      uncompressedBytes += buffer.length
      yield buffer
    }
  }
  const output: Writable = createWriteStream(params.targetPath, { flags: 'wx' })
  await pipeline(Readable.from(encode()), createCompressor(params.backend, params.zstdLevel), output)
  const handle = await open(params.targetPath, 'r+')
  let compressedBytes = 0
  try {
    await handle.sync()
    compressedBytes = (await handle.stat()).size
  } finally {
    await handle.close()
  }
  return {
    backend: params.backend,
    lineCount,
    uncompressedBytes,
    uncompressedSha256: hash.digest('hex'),
    compressedBytes,
  }
}

export type BelotJournalArchiveDigest = {
  lineCount: number
  uncompressedBytes: number
  uncompressedSha256: string
}

// Пълна проверка: декомпресира целия файл (проверява и ZSTD/GZIP checksum-а)
// и изчислява SHA-256 и броя редове на съдържанието.
export async function digestBelotJournalArchive(
  filePath: string,
  options: Pick<BelotJournalCompressionOptions, 'disableNodeZstd' | 'disableZstdCli'> = {},
): Promise<BelotJournalArchiveDigest> {
  const hash = createHash('sha256')
  let lineCount = 0
  let uncompressedBytes = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      uncompressedBytes += chunk.length
      for (const byte of chunk) if (byte === 10) lineCount += 1
      callback()
    },
  })
  await pipeline(createReadStream(filePath), createBelotJournalDecompressor(filePath, options), counter)
  return { lineCount, uncompressedBytes, uncompressedSha256: hash.digest('hex') }
}

export async function verifyBelotJournalArchive(
  filePath: string,
  expected: { lineCount: number; uncompressedSha256: string },
  options: Pick<BelotJournalCompressionOptions, 'disableNodeZstd' | 'disableZstdCli'> = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const digest = await digestBelotJournalArchive(filePath, options)
    if (digest.lineCount !== expected.lineCount) {
      return { ok: false, reason: `line count ${digest.lineCount} != ${expected.lineCount}` }
    }
    if (digest.uncompressedSha256 !== expected.uncompressedSha256) {
      return { ok: false, reason: 'sha256 of decompressed content differs' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Поточно четене ред по ред (без да зарежда целия архив в паметта).
export async function* readBelotJournalArchiveLines(
  filePath: string,
  options: Pick<BelotJournalCompressionOptions, 'disableNodeZstd' | 'disableZstdCli'> = {},
): AsyncGenerator<string> {
  const decompressed = new PassThrough()
  const source = createReadStream(filePath)
  const decompressor = createBelotJournalDecompressor(filePath, options)
  const piping = pipeline(source, decompressor, decompressed)
  let pipeError: unknown = null
  piping.catch((error: unknown) => {
    pipeError = error
    decompressed.destroy(error instanceof Error ? error : new Error(String(error)))
  })
  const lines = createInterface({ input: decompressed, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (line !== '') yield line
    }
  } finally {
    lines.close()
  }
  await piping.catch(() => undefined)
  if (pipeError) throw pipeError
}
