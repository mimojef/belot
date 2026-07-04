/**
 * tarGzJsonlReader.ts
 *
 * Минимален, зависимост-свободен reader за .tar.gz архиви — четe целия архив
 * в паметта, декомпресира с node:zlib и парсва tar формата ръчно (ustar +
 * GNU long-name + PAX extended header за пътища), за да намери рекурсивно
 * всички .jsonl файлове (включително .active.jsonl), без предположение
 * за фиксирана директорийна структура.
 */

import { gunzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'

const TAR_BLOCK_SIZE = 512

type RawTarEntry = {
  name: string
  typeflag: string
  data: Buffer
}

function readOctalField(block: Buffer, offset: number, length: number): number {
  const raw = block.subarray(offset, offset + length).toString('latin1')
  const cleaned = raw.replace(/\0/g, ' ').trim()
  if (!cleaned) return 0
  const parsed = Number.parseInt(cleaned, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

function readStringField(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const nulIndex = raw.indexOf(0)
  const bytes = nulIndex === -1 ? raw : raw.subarray(0, nulIndex)
  return bytes.toString('utf8')
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false
  }
  return true
}

// PAX extended header records имат формат "<length> <key>=<value>\n" (length-prefixed).
function parsePaxRecords(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {}
  const text = data.toString('utf8')
  let pos = 0
  while (pos < text.length) {
    const spaceIdx = text.indexOf(' ', pos)
    if (spaceIdx === -1) break
    const recordLength = Number.parseInt(text.slice(pos, spaceIdx), 10)
    if (!Number.isFinite(recordLength) || recordLength <= 0) break
    const record = text.slice(pos, pos + recordLength)
    const eqIdx = record.indexOf('=', spaceIdx - pos + 1)
    if (eqIdx !== -1) {
      const key = record.slice(spaceIdx - pos + 1, eqIdx)
      const value = record.slice(eqIdx + 1).replace(/\n$/, '')
      result[key] = value
    }
    pos += recordLength
  }
  return result
}

function parseTarEntries(tarBuffer: Buffer): RawTarEntry[] {
  const entries: RawTarEntry[] = []
  let offset = 0
  let pendingLongName: string | null = null
  let pendingPaxPath: string | null = null

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE)
    if (isZeroBlock(header)) break // end-of-archive marker (two zero blocks, we stop at the first)

    const nameField = readStringField(header, 0, 100)
    const prefixField = readStringField(header, 345, 155)
    const size = readOctalField(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] ?? 0x30)

    const dataStart = offset + TAR_BLOCK_SIZE
    const dataEnd = dataStart + size
    if (dataEnd > tarBuffer.length) {
      throw new Error(`Повреден tar архив: entry "${nameField}" сочи извън границите на архива`)
    }
    const data = tarBuffer.subarray(dataStart, dataEnd)

    let resolvedName = prefixField ? `${prefixField}/${nameField}` : nameField
    if (pendingLongName !== null) {
      resolvedName = pendingLongName
      pendingLongName = null
    } else if (pendingPaxPath !== null) {
      resolvedName = pendingPaxPath
      pendingPaxPath = null
    }

    if (typeflag === 'L') {
      // GNU long-name entry: data блокът съдържа реалното име за СЛЕДВАЩИЯ entry.
      pendingLongName = data.toString('utf8').replace(/\0+$/, '')
    } else if (typeflag === 'x' || typeflag === 'g') {
      // PAX extended header за СЛЕДВАЩИЯ entry.
      const pax = parsePaxRecords(Buffer.from(data))
      if (pax['path']) pendingPaxPath = pax['path']
    } else {
      entries.push({ name: resolvedName, typeflag, data: Buffer.from(data) })
    }

    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
    offset = dataStart + paddedSize
  }

  return entries
}

export type JsonlFileEntry = {
  /** Пълен път на файла вътре в архива (за отчети/грешки). */
  archivePath: string
  content: string
}

const REGULAR_FILE_TYPEFLAGS = new Set(['0', '\0'])

export async function readJsonlFilesFromTarGz(archivePath: string): Promise<JsonlFileEntry[]> {
  const compressed = await readFile(archivePath)
  const tarBuffer = gunzipSync(compressed)
  const entries = parseTarEntries(tarBuffer)

  const jsonlEntries: JsonlFileEntry[] = entries
    .filter((e) => REGULAR_FILE_TYPEFLAGS.has(e.typeflag) && e.name.toLowerCase().endsWith('.jsonl'))
    .map((e) => ({ archivePath: e.name, content: e.data.toString('utf8') }))

  jsonlEntries.sort((a, b) => a.archivePath.localeCompare(b.archivePath))
  return jsonlEntries
}
