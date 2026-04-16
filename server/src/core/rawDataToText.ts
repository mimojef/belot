import { Buffer } from 'node:buffer'
import type { RawData } from 'ws'

export function rawDataToText(raw: RawData): string {
  if (typeof raw === 'string') {
    return raw
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8')
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8')
  }

  return raw.toString('utf8')
}
