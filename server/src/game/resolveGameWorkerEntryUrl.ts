import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolveGameWorkerEntryUrl(): Promise<URL> {
  // dirname(dirname(dirname(fileURLToPath(import.meta.url)))) дава server/,
  // защото helper-ът е в server/src/game/ при development и в server/dist/game/ след компилация.
  const serverRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

  const sourceDir = resolve(serverRoot, 'src', 'game')
  const compiledDir = resolve(serverRoot, 'dist', 'game')

  const threadSrc = resolve(sourceDir, 'gameWorkerThread.ts')
  const threadJs = resolve(compiledDir, 'gameWorkerThread.js')
  const protocolSrc = resolve(sourceDir, 'workerProtocol.ts')
  const protocolJs = resolve(compiledDir, 'workerProtocol.js')

  // ─── Existence check ──────────────────────────────────────────────────────────

  const [threadJsStat, protocolJsStat] = await Promise.all([
    stat(threadJs).catch(() => null),
    stat(protocolJs).catch(() => null),
  ])

  if (threadJsStat === null) {
    throw new Error(
      `[resolveGameWorkerEntryUrl] Compiled worker not found: ${threadJs}\nRun: npm run build`,
    )
  }

  if (protocolJsStat === null) {
    throw new Error(
      `[resolveGameWorkerEntryUrl] Compiled protocol not found: ${protocolJs}\nRun: npm run build`,
    )
  }

  // ─── Stale check ─────────────────────────────────────────────────────────────

  const [threadSrcStat, protocolSrcStat] = await Promise.all([
    stat(threadSrc),
    stat(protocolSrc),
  ])

  if (threadSrcStat.mtimeMs > threadJsStat.mtimeMs) {
    throw new Error(
      `[resolveGameWorkerEntryUrl] Compiled game worker is stale.\n` +
        `  source:   ${threadSrc}\n` +
        `  compiled: ${threadJs}\n` +
        `Run: npm run build`,
    )
  }

  if (protocolSrcStat.mtimeMs > protocolJsStat.mtimeMs) {
    throw new Error(
      `[resolveGameWorkerEntryUrl] Compiled game worker is stale.\n` +
        `  source:   ${protocolSrc}\n` +
        `  compiled: ${protocolJs}\n` +
        `Run: npm run build`,
    )
  }

  return pathToFileURL(threadJs)
}
