/**
 * checkFrontendDeployAtomic.ts
 *
 * Regression check за production PWA/deploy дефекта: "npm run build" директно
 * в live /var/www/belot-v2/dist empty-ва (Vite emptyOutDir default) самата
 * обслужвана директория, доказан ~60ms+ прозорец с изтрити стари hashed
 * assets и липсващ/непълен index.html, докато build-ът тече.
 *
 * Тества scripts/deployFrontendAtomic.sh реално (spawn на bash процеса,
 * реален build, реална файлова система) срещу изолиран DEPLOY_ROOT — не
 * regex/source-text проверки.
 *
 * Покрива:
 *  [1] Build-ът се случва извън live dist (изолирана temp директория)
 *  [2] Стар hashed JS asset остава достъпим (на диска) след нов release
 *  [3] Ново "отваряне" (current) реферира новия index/hash
 *  [4] Всеки release директория, чиито index.html/sw.js реферират hash,
 *      hash-ът РЕАЛНО съществува в споделения pool — никога "index сочи
 *      към несъществуващ JS"
 *  [5] Retention пази release-ите, но НИКОГА не пипа споделения assets pool
 *  [6] gc-assets premahva samo hash-ове, нереферирани от НИТО ЕДИН запазен release
 *  [7] Rollback избира правилния предишен release (target selection логика)
 *  [8] Build validation gate-овете реално fail-ват при счупен build
 *
 * Забележка за Windows dev машини: Git Bash/MSYS без administrator/Developer
 * Mode права не създава истински NTFS symlink-ове (`ln -s` fallback-ва към
 * directory copy) — "current" swap стъпката (стъпка 5 в скрипта) е
 * недоказуема end-to-end на такава машина. Тестовете тук explicit заобикалят
 * само тази конкретна ОС ограничение (не тестова на самата логика), докато
 * потвърждават всичко останало directly на файловата система. Виж финалния
 * отчет за препоръка да се направи един реален dry-run на действителния Linux
 * production host преди първо истинско използване.
 */

import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Probe: Windows Git Bash/MSYS без elevated права fallback-ва `ln -s` към
// directory copy вместо истински symlink → `mv -Tf` в deploy скрипта коректно
// отказва да презапише non-empty directory при следващ deploy. Това е
// ограничение на локалната dev машина, не бъг в скрипта (Linux production
// хостът създава истински symlink файлове, за които mv -Tf работи атомарно
// точно както е документирано). Detect-ваме тук и, само ако липсва
// поддръжка, разчистваме "current"/"current.tmp" между тестовите deploy
// извиквания — единствено за да можем да продължим да тестваме
// retention/gc-assets/rollback логиката въпреки тази ОС бариера.
async function detectRealSymlinkSupport(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-symlink-probe-'))
  try {
    await mkdir(join(dir, 'target'))
    await symlink(join(dir, 'target'), join(dir, 'link'))
    const st = await (await import('node:fs/promises')).lstat(join(dir, 'link'))
    return st.isSymbolicLink()
  } catch {
    return false
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const HAS_REAL_SYMLINKS = await detectRealSymlinkSupport()
if (!HAS_REAL_SYMLINKS) {
  console.warn(
    '\n[WARN] Тази машина не поддържа истински symlink-ове без elevated права ' +
    '(Windows Git Bash/MSYS fallback). "current" atomic-swap стъпката ще бъде ' +
    'workaround-ната само за да продължат останалите тестове — самата symlink ' +
    'атомарност трябва да се потвърди с dry-run на реалния Linux production host.\n',
  )
}

let passed = 0
let failed = 0
let skipped = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function skip(label: string, reason: string): void {
  skipped++
  console.log(`  SKIP  ${label}: ${reason}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}

const PROJECT_ROOT = resolve(process.cwd())
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'deployFrontendAtomic.sh')

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function runDeployScript(deployRoot: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  // Workaround само за средата (виж HAS_REAL_SYMLINKS коментара по-горе) —
  // премахва "current"/"current.tmp", ако не са истински symlink-ове, за да
  // може mv -Tf в скрипта да успее (иначе коректно отказва да презапише
  // непразна директория, което е точно очакваното поведение на Linux, при
  // истински symlink target).
  if (!HAS_REAL_SYMLINKS && (args[0] !== '--rollback' && args[0] !== '--list' && args[0] !== '--gc-assets')) {
    await rm(join(deployRoot, 'current'), { recursive: true, force: true }).catch(() => {})
    await rm(join(deployRoot, 'current.tmp'), { recursive: true, force: true }).catch(() => {})
  }

  return new Promise((resolveRun) => {
    const child = spawn('bash', [SCRIPT_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PROJECT_ROOT, DEPLOY_ROOT: deployRoot, ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }))
  })
}

function listReleases(deployRoot: string): string[] {
  const dir = join(deployRoot, 'releases')
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort()
}

function referencedHashesFromRelease(deployRoot: string, releaseId: string): string[] {
  const indexHtml = readFileSync(join(deployRoot, 'releases', releaseId, 'index.html'), 'utf8')
  const swJs = readFileSync(join(deployRoot, 'releases', releaseId, 'sw.js'), 'utf8')
  const matches = new Set<string>()
  for (const src of [indexHtml, swJs]) {
    const m = src.match(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g) ?? []
    for (const entry of m) matches.add(entry.replace(/^assets\//, ''))
  }
  return [...matches]
}

console.log('\ncheckFrontendDeployAtomic\n')

let deployRoot = ''

try {
  deployRoot = await mkdtemp(join(tmpdir(), 'belot-deploy-atomic-check-'))

  // ─── [1] Първи деплой — build изолация + структура ────────────────────
  console.log('Deploy #1 (build marker: check-a)...')
  const r1 = await runDeployScript(deployRoot, [], { VITE_BUILD_ID: 'check-a' })

  await check('[1] Deploy #1 завършва успешно (exit code 0)', () => {
    if (r1.code !== 0) throw new Error(`exit=${r1.code}\nstdout tail:\n${r1.stdout.slice(-500)}\nstderr tail:\n${r1.stderr.slice(-500)}`)
  })
  await check('[1b] Build-ът се случва в изолирана temp директория (лог потвърждава "НЕ в live dist")', () => {
    if (!r1.stdout.includes('НЕ в live dist')) throw new Error('Логът не потвърждава build изолация')
  })

  const releasesAfter1 = listReleases(deployRoot)
  await check('[1c] Точно 1 release директория след Deploy #1', () => {
    if (releasesAfter1.length !== 1) throw new Error(`releases=${JSON.stringify(releasesAfter1)}`)
  })

  const release1 = releasesAfter1[0]
  await check('[1d] Release #1 съдържа index.html, sw.js, manifest.webmanifest', () => {
    for (const f of ['index.html', 'sw.js', 'manifest.webmanifest']) {
      if (!existsSync(join(deployRoot, 'releases', release1, f))) throw new Error(`липсва ${f}`)
    }
  })
  await check('[1e] Release #1/assets/ съдържа mutable файлове, но НИТО ЕДИН hashed файл (тези живеят само в споделения pool)', () => {
    const releaseAssetsDir = join(deployRoot, 'releases', release1, 'assets')
    if (!existsSync(releaseAssetsDir)) throw new Error('release/assets/ липсва — mutable съдържанието (avatars, изображения) няма къде да живее')
    const hashedPattern = /-[0-9A-Za-z_-]{8,10}\.(?:js|mjs|css)$/
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      return e.isDirectory() ? walk(full) : [full]
    })
    const hashedInRelease = walk(releaseAssetsDir).filter((f) => hashedPattern.test(f))
    if (hashedInRelease.length > 0) {
      throw new Error(`hashed файл(ове) погрешно копирани в release/assets/: ${hashedInRelease.join(', ')}`)
    }
  })

  const hashesRelease1 = referencedHashesFromRelease(deployRoot, release1)
  await check('[1f] index.html/sw.js на Release #1 реферират поне 1 hashed JS asset', () => {
    if (!hashesRelease1.some((h) => h.endsWith('.js'))) throw new Error(`hashes=${JSON.stringify(hashesRelease1)}`)
  })
  await check('[1g] Всички hash-ове, реферирани от Release #1, реално съществуват в споделения assets pool', () => {
    for (const h of hashesRelease1) {
      const p = join(deployRoot, 'assets', h)
      if (!existsSync(p)) throw new Error(`Липсва ${h} в assets pool-а — index сочи към несъществуващ файл`)
    }
  })

  // ─── [2]/[3] Втори деплой с РЕАЛНО различен build marker (различен hash) ──
  console.log('Deploy #2 (build marker: check-b, различен от check-a)...')
  await new Promise((r) => setTimeout(r, 1100)) // гарантира различен release-id timestamp
  const r2 = await runDeployScript(deployRoot, [], { VITE_BUILD_ID: 'check-b' })

  await check('[2a] Deploy #2 завършва успешно', () => {
    if (r2.code !== 0) throw new Error(`exit=${r2.code}\nstdout tail:\n${r2.stdout.slice(-500)}\nstderr tail:\n${r2.stderr.slice(-500)}`)
  })

  const releasesAfter2 = listReleases(deployRoot)
  const release2 = releasesAfter2.find((r) => r !== release1)!
  await check('[2b] Има нов, различен release след Deploy #2', () => {
    if (!release2) throw new Error(`releases=${JSON.stringify(releasesAfter2)}`)
  })

  const hashesRelease2 = referencedHashesFromRelease(deployRoot, release2)
  await check('[2c] Release #2 реферира ДРУГ hash от Release #1 (реално различно съдържание)', () => {
    const jsHash1 = hashesRelease1.find((h) => h.endsWith('.js'))
    const jsHash2 = hashesRelease2.find((h) => h.endsWith('.js'))
    if (jsHash1 === jsHash2) throw new Error(`Двата release-а реферират еднакъв hash (${jsHash1}) — тестът не доказва нищо`)
  })

  await check('[3] СТАРИЯТ hash (от Release #1) остава физически наличен в assets pool СЛЕД Deploy #2', () => {
    for (const h of hashesRelease1) {
      if (h.endsWith('.js') || h.endsWith('.css')) {
        const p = join(deployRoot, 'assets', h)
        if (!existsSync(p)) throw new Error(`${h} е изчезнал след Deploy #2 — старите tabs/PWA биха 404-нали`)
      }
    }
  })
  await check('[3b] НОВИЯТ hash (Release #2) също е наличен в assets pool', () => {
    for (const h of hashesRelease2) {
      const p = join(deployRoot, 'assets', h)
      if (!existsSync(p)) throw new Error(`Липсва нов hash ${h}`)
    }
  })
  await check('[3c] Release #2-ите hash-ове съществуват в pool-а (index никога не сочи към липсващ файл)', () => {
    for (const h of hashesRelease2) {
      if (!existsSync(join(deployRoot, 'assets', h))) throw new Error(`Липсва ${h}`)
    }
  })

  // ─── [4] Инварианта важи за ВСИЧКИ запазени release-и, не само последния ──
  await check('[4] За всеки запазен release, ВСИЧКИ реферирани hash-ове съществуват в pool-а', () => {
    for (const rel of listReleases(deployRoot)) {
      const hashes = referencedHashesFromRelease(deployRoot, rel)
      for (const h of hashes) {
        if (!existsSync(join(deployRoot, 'assets', h))) {
          throw new Error(`Release ${rel} реферира липсващ hash ${h}`)
        }
      }
    }
  })

  // ─── [5] Retention: пази release директориите, НИКОГА не пипа pool-а ────
  console.log('Deploy #3, #4 (за да предизвикам retention cleanup, KEEP=2)...')
  await new Promise((r) => setTimeout(r, 1100))
  await runDeployScript(deployRoot, ['--keep', '2'], { VITE_BUILD_ID: 'check-c' })
  await new Promise((r) => setTimeout(r, 1100))
  await runDeployScript(deployRoot, ['--keep', '2'], { VITE_BUILD_ID: 'check-d' })

  const releasesAfterRetention = listReleases(deployRoot)
  await check('[5a] Retention пази точно KEEP_RELEASES=2 release директории', () => {
    if (releasesAfterRetention.length !== 2) throw new Error(`releases=${JSON.stringify(releasesAfterRetention)}`)
  })
  await check('[5b] Release #1 (най-стар) е премахнат от releases/, но НЕГОВИЯТ hash все още е в assets pool', () => {
    if (releasesAfterRetention.includes(release1)) throw new Error('Release #1 не е бил премахнат от retention-а')
    for (const h of hashesRelease1) {
      if ((h.endsWith('.js') || h.endsWith('.css')) && !existsSync(join(deployRoot, 'assets', h))) {
        throw new Error(`${h} е изтрит от pool-а — retention не трябва да пипа споделения assets pool`)
      }
    }
  })

  // ─── [6] gc-assets: премахва само нереферирани hash-ове ─────────────────
  const gcDry = await runDeployScript(deployRoot, ['--gc-assets', '--dry-run'])
  await check('[6a] gc-assets --dry-run завършва успешно', () => {
    if (gcDry.code !== 0) throw new Error(`exit=${gcDry.code}\n${gcDry.stdout}\n${gcDry.stderr}`)
  })
  await check('[6b] gc-assets flag-ва hash-а на Release #1 (вече не се реферира от нито един запазен release)', () => {
    const jsHash1 = hashesRelease1.find((h) => h.endsWith('.js'))!
    if (!gcDry.stdout.includes(jsHash1)) {
      throw new Error(`gc-assets не флагна ${jsHash1} за премахване, въпреки че Release #1 вече не е запазен\n${gcDry.stdout}`)
    }
  })
  await check('[6c] gc-assets --dry-run НЕ трие нищо реално (dry-run е спазен)', () => {
    const jsHash1 = hashesRelease1.find((h) => h.endsWith('.js'))!
    if (!existsSync(join(deployRoot, 'assets', jsHash1))) {
      throw new Error('--dry-run е изтрил файл въпреки флага')
    }
  })
  await check('[6d] gc-assets НЕ флагва hash-ове, реферирани от текущо запазени release-и', () => {
    for (const rel of releasesAfterRetention) {
      const hashes = referencedHashesFromRelease(deployRoot, rel)
      for (const h of hashes) {
        if (gcDry.stdout.includes(h)) throw new Error(`gc-assets погрешно флагна ${h}, реферирано от запазен release ${rel}`)
      }
    }
  })

  // ─── [7] Rollback: избира правилния предишен release (target selection) ──
  // Изисква истински symlink за "current", за да resolve-не readlink -f
  // коректно — недоказуемо на Windows fallback средата (виж HAS_REAL_SYMLINKS).
  if (HAS_REAL_SYMLINKS) {
    const rollbackDry = await runDeployScript(deployRoot, ['--rollback', '--dry-run'])
    await check('[7] Rollback --dry-run избира точно втория-най-нов release (правилният "предишен")', () => {
      const sorted = [...releasesAfterRetention].sort()
      const expectedPrev = sorted[sorted.length - 2]
      if (!rollbackDry.stdout.includes(`-> ${expectedPrev}`)) {
        throw new Error(`Очаквах rollback target ${expectedPrev} в лога:\n${rollbackDry.stdout}`)
      }
    })
  } else {
    skip('[7] Rollback target selection', 'изисква истински symlink за "current" — недоказуемо на тази машина, виж бележката в началото на файла')
  }

  // ─── [8] Build validation gate — счупен build трябва да fail-не рано ────
  console.log('Тествам validation gate със счупен index.html (симулирано)...')
  const brokenProjectRoot = await mkdtemp(join(tmpdir(), 'belot-broken-project-'))
  try {
    // Копираме само package.json структурата достатъчно, за да достигнем
    // build стъпката, после подменяме index.html с невалиден stub — ще
    // предизвика "не съдържа module script tag" fail-а.
    await cp(join(PROJECT_ROOT, 'package.json'), join(brokenProjectRoot, 'package.json'))
    await cp(join(PROJECT_ROOT, 'vite.config.ts'), join(brokenProjectRoot, 'vite.config.ts'))
    await cp(join(PROJECT_ROOT, 'tsconfig.json'), join(brokenProjectRoot, 'tsconfig.json'))
    await mkdir(join(brokenProjectRoot, 'node_modules'), { recursive: true })
    await rm(join(brokenProjectRoot, 'node_modules'), { recursive: true, force: true })
    // Symlink node_modules вместо копиране (голяма директория).
    const { symlink } = await import('node:fs/promises')
    await symlink(join(PROJECT_ROOT, 'node_modules'), join(brokenProjectRoot, 'node_modules'), 'junction')
    await cp(join(PROJECT_ROOT, 'src'), join(brokenProjectRoot, 'src'), { recursive: true })
    await cp(join(PROJECT_ROOT, 'public'), join(brokenProjectRoot, 'public'), { recursive: true }).catch(() => {})
    // Невалиден index.html — без module script tag.
    await writeFile(join(brokenProjectRoot, 'index.html'), '<!doctype html><html><body>broken, no module script</body></html>')

    const brokenDeployRoot = await mkdtemp(join(tmpdir(), 'belot-deploy-broken-'))
    const rBroken = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
      const child = spawn('bash', [SCRIPT_PATH], {
        cwd: brokenProjectRoot,
        env: { ...process.env, PROJECT_ROOT: brokenProjectRoot, DEPLOY_ROOT: brokenDeployRoot },
      })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }))
    })

    await check('[8a] Deploy със счупен index.html (без module script) fail-ва (exit != 0)', () => {
      if (rBroken.code === 0) throw new Error('Скриптът е върнал success за счупен build')
    })
    await check('[8b] Fail съобщението идентифицира точно проблема (module script tag)', () => {
      if (!rBroken.stderr.includes('module script tag')) throw new Error(`stderr:\n${rBroken.stderr}`)
    })
    await check('[8c] При fail-нал build, НИЩО не се публикува (releases/ остава празна)', () => {
      const rels = listReleases(brokenDeployRoot)
      if (rels.length !== 0) throw new Error(`releases=${JSON.stringify(rels)} — не биваше да се публикува нищо`)
    })
    await rm(brokenDeployRoot, { recursive: true, force: true })
  } finally {
    await rm(brokenProjectRoot, { recursive: true, force: true })
  }

  // ─── [9] Precache closure gate — умишлено липсващ precache ресурс ───────
  console.log('\nТествам precache closure gate (умишлено липсващ ресурс в манифеста)...')
  const pcProjectRoot = await mkdtemp(join(tmpdir(), 'belot-precache-project-'))
  const pcDeployRoot = await mkdtemp(join(tmpdir(), 'belot-precache-deploy-'))
  try {
    const { symlink } = await import('node:fs/promises')
    await cp(join(PROJECT_ROOT, 'package.json'), join(pcProjectRoot, 'package.json'))
    await cp(join(PROJECT_ROOT, 'tsconfig.json'), join(pcProjectRoot, 'tsconfig.json'))
    await cp(join(PROJECT_ROOT, 'index.html'), join(pcProjectRoot, 'index.html'))
    await symlink(join(PROJECT_ROOT, 'node_modules'), join(pcProjectRoot, 'node_modules'), 'junction')
    await cp(join(PROJECT_ROOT, 'src'), join(pcProjectRoot, 'src'), { recursive: true })
    await cp(join(PROJECT_ROOT, 'public'), join(pcProjectRoot, 'public'), { recursive: true }).catch(() => {})
    await mkdir(join(pcProjectRoot, 'scripts'), { recursive: true })
    await cp(join(PROJECT_ROOT, 'scripts', 'validatePrecacheClosure.mjs'), join(pcProjectRoot, 'scripts', 'validatePrecacheClosure.mjs'))

    const originalViteConfig = await readFile(join(PROJECT_ROOT, 'vite.config.ts'), 'utf8')

    // Стъпка А: нормален (валиден) vite.config.ts → едно УСПЕШНО deploy, за
    // да имаме реален "предишен release", чиято непроменимост ще проверим.
    await writeFile(join(pcProjectRoot, 'vite.config.ts'), originalViteConfig)
    const rGood = await runDeployScript(pcDeployRoot, [], { PROJECT_ROOT: pcProjectRoot, VITE_BUILD_ID: 'precache-good' })
    await check('[9a] Първоначален валиден deploy (baseline "предишен release") завършва успешно', () => {
      if (rGood.code !== 0) throw new Error(`exit=${rGood.code}\n${rGood.stdout.slice(-500)}\n${rGood.stderr.slice(-500)}`)
    })
    const releaseBeforeFailure = listReleases(pcDeployRoot)[0]

    // Стъпка Б: инжектирай vite-plugin-pwa additionalManifestEntries сочещ
    // към файл, който НИКОГА няма да съществува в build изхода — реалистична
    // симулация на "sw.js реферира ресурс, който publish стъпката пропуска".
    const brokenViteConfig = originalViteConfig.replace(
      "injectManifest: {",
      "injectManifest: {\n        additionalManifestEntries: [{ url: 'this-file-does-not-exist-anywhere.txt', revision: 'test-marker' }],",
    )
    if (brokenViteConfig === originalViteConfig) {
      throw new Error('vite.config.ts patch не съвпадна — очакван "injectManifest: {" низ не е намерен')
    }
    await writeFile(join(pcProjectRoot, 'vite.config.ts'), brokenViteConfig)

    const rBad = await runDeployScript(pcDeployRoot, [], { PROJECT_ROOT: pcProjectRoot, VITE_BUILD_ID: 'precache-bad' })

    await check('[9b] Deploy с липсващ precache ресурс fail-ва (exit != 0)', () => {
      if (rBad.code === 0) throw new Error('Скриптът е върнал success въпреки липсващия precache ресурс')
    })
    // Забележка: validation-ът има 2 gate-а — self-check срещу самия
    // BUILD_DIR (стъпка 2b, преди каквото и да е публикуване) и пълна
    // проверка срещу реалната publish структура (стъпка 4b). При липсващ
    // ресурс, self-check-ът хваща проблема ПЪРВИ (по-рано, преди дори
    // assets/release copy стъпките) — и двата пътя използват validator-a
    // със същия "ЛИПСВАЩИ precache ресурси" формат, значи проверката тук е
    // валидна независимо кой от двата гейта реално е спрял deploy-а.
    await check('[9c] Fail съобщението идентифицира precache closure проблема', () => {
      if (!rBad.stderr.includes('ЛИПСВАЩИ precache ресурси') && !rBad.stderr.includes('Precache closure непълна')) {
        throw new Error(`stderr:\n${rBad.stderr}`)
      }
    })
    await check('[9d] Fail изходът споменава точно липсващия файл', () => {
      if (!rBad.stderr.includes('this-file-does-not-exist-anywhere.txt')) {
        throw new Error(`stderr не споменава липсващия файл:\n${rBad.stderr.slice(-800)}`)
      }
    })
    await check('[9e] След failure, releases/ съдържа САМО baseline release-а (нищо ново не е публикувано)', () => {
      const releasesNow = listReleases(pcDeployRoot)
      if (releasesNow.length !== 1 || releasesNow[0] !== releaseBeforeFailure) {
        throw new Error(`releases=${JSON.stringify(releasesNow)}, очаквах само [${releaseBeforeFailure}]`)
      }
    })
    // Изисква истински symlink за "current" (виж HAS_REAL_SYMLINKS) — на
    // Windows fallback средата runDeployScript премахва "current" ПРЕДИ
    // всеки deploy опит (workaround за mv -Tf), значи "current остана
    // непроменен" не е доказуемо там по конструкция на самия workaround.
    if (HAS_REAL_SYMLINKS) {
      await check('[9f] "current" остава непроменен — все още сочи към baseline release-а', () => {
        const indexHtml = readFileSync(join(pcDeployRoot, 'current', 'index.html'), 'utf8')
        const goodIndexHtml = readFileSync(join(pcDeployRoot, 'releases', releaseBeforeFailure, 'index.html'), 'utf8')
        if (indexHtml !== goodIndexHtml) throw new Error('current/index.html се различава от baseline release-а — current е бил пипнат въпреки failure-а')
      })
    } else {
      skip('[9f] "current" остава непроменен при failure', 'изисква истински symlink — недоказуемо на тази машина, виж бележката в началото на файла')
    }
  } finally {
    await rm(pcProjectRoot, { recursive: true, force: true })
    await rm(pcDeployRoot, { recursive: true, force: true })
  }

  // ─── [10]/[11] Mutable asset update + rollback ────────────────────────────
  console.log('\nТествам mutable asset update между releases + rollback...')
  const mutProjectRoot = await mkdtemp(join(tmpdir(), 'belot-mutable-project-'))
  const mutDeployRoot = await mkdtemp(join(tmpdir(), 'belot-mutable-deploy-'))
  try {
    const { symlink } = await import('node:fs/promises')
    await cp(join(PROJECT_ROOT, 'package.json'), join(mutProjectRoot, 'package.json'))
    await cp(join(PROJECT_ROOT, 'vite.config.ts'), join(mutProjectRoot, 'vite.config.ts'))
    await cp(join(PROJECT_ROOT, 'tsconfig.json'), join(mutProjectRoot, 'tsconfig.json'))
    await cp(join(PROJECT_ROOT, 'index.html'), join(mutProjectRoot, 'index.html'))
    await symlink(join(PROJECT_ROOT, 'node_modules'), join(mutProjectRoot, 'node_modules'), 'junction')
    await cp(join(PROJECT_ROOT, 'src'), join(mutProjectRoot, 'src'), { recursive: true })
    await cp(join(PROJECT_ROOT, 'public'), join(mutProjectRoot, 'public'), { recursive: true }).catch(() => {})
    await mkdir(join(mutProjectRoot, 'scripts'), { recursive: true })
    await cp(join(PROJECT_ROOT, 'scripts', 'validatePrecacheClosure.mjs'), join(mutProjectRoot, 'scripts', 'validatePrecacheClosure.mjs'))

    // Нов mutable static file — стабилно име, съдържанието му ще се смени
    // между два deploy-а, за да докаже release-specific update поведението.
    await mkdir(join(mutProjectRoot, 'public', 'assets', 'testdir'), { recursive: true })
    await writeFile(join(mutProjectRoot, 'public', 'assets', 'testdir', 'marker.png'), 'MUTABLE-CONTENT-V1')

    const rV1 = await runDeployScript(mutDeployRoot, [], { PROJECT_ROOT: mutProjectRoot, VITE_BUILD_ID: 'mut-v1' })
    await check('[10a] Deploy #1 (marker.png = V1) завършва успешно', () => {
      if (rV1.code !== 0) throw new Error(`exit=${rV1.code}\n${rV1.stdout.slice(-500)}\n${rV1.stderr.slice(-500)}`)
    })
    const releaseV1 = listReleases(mutDeployRoot)[0]
    await check('[10b] marker.png (V1) е в release/assets/testdir/, НЕ в shared hashed pool', () => {
      const inRelease = existsSync(join(mutDeployRoot, 'releases', releaseV1, 'assets', 'testdir', 'marker.png'))
      const inPool = existsSync(join(mutDeployRoot, 'assets', 'testdir', 'marker.png'))
      if (!inRelease) throw new Error('marker.png липсва от release/assets/testdir/')
      if (inPool) throw new Error('marker.png погрешно е публикуван в споделения hashed pool')
    })

    await sleep(1100)
    await writeFile(join(mutProjectRoot, 'public', 'assets', 'testdir', 'marker.png'), 'MUTABLE-CONTENT-V2')
    const rV2 = await runDeployScript(mutDeployRoot, [], { PROJECT_ROOT: mutProjectRoot, VITE_BUILD_ID: 'mut-v2' })
    await check('[10c] Deploy #2 (marker.png = V2, ново съдържание, СЪЩОТО име) завършва успешно', () => {
      if (rV2.code !== 0) throw new Error(`exit=${rV2.code}\n${rV2.stdout.slice(-500)}\n${rV2.stderr.slice(-500)}`)
    })
    const releaseV2 = listReleases(mutDeployRoot).find((r) => r !== releaseV1)!

    await check('[10d] Новият release съдържа V2 съдържанието на marker.png (mutable update отразен)', () => {
      const content = readFileSync(join(mutDeployRoot, 'releases', releaseV2, 'assets', 'testdir', 'marker.png'), 'utf8')
      if (content !== 'MUTABLE-CONTENT-V2') throw new Error(`съдържание=${content}, очаквах MUTABLE-CONTENT-V2`)
    })
    await check('[10e] Старият release (V1) остава НЕПРОМЕНЕН — все още съдържа V1 (release isolation)', () => {
      const content = readFileSync(join(mutDeployRoot, 'releases', releaseV1, 'assets', 'testdir', 'marker.png'), 'utf8')
      if (content !== 'MUTABLE-CONTENT-V1') throw new Error(`съдържание=${content}, очаквах MUTABLE-CONTENT-V1 (старият release не бива да се презаписва)`)
    })

    if (HAS_REAL_SYMLINKS) {
      const rollback = await runDeployScript(mutDeployRoot, ['--rollback'])
      await check('[11a] Rollback завършва успешно', () => {
        if (rollback.code !== 0) throw new Error(`exit=${rollback.code}\n${rollback.stdout}\n${rollback.stderr}`)
      })
      await check('[11b] Rollback връща СТАРАТА (V1) версия на mutable marker.png през "current"', () => {
        const content = readFileSync(join(mutDeployRoot, 'current', 'assets', 'testdir', 'marker.png'), 'utf8')
        if (content !== 'MUTABLE-CONTENT-V1') throw new Error(`current съдържание=${content}, очаквах MUTABLE-CONTENT-V1 след rollback`)
      })
    } else {
      skip('[11] Rollback връща старата версия на mutable asset', 'изисква истински symlink за "current" — недоказуемо на тази машина, виж бележката в началото на файла')
    }
  } finally {
    await rm(mutProjectRoot, { recursive: true, force: true })
    await rm(mutDeployRoot, { recursive: true, force: true })
  }

  // ─── [12]/[13] nginx конфигурация — структурни проверки (без реален nginx) ──
  // Реалният location precedence е емпирично доказан отделно (реален
  // nginx 1.26.2, локален тест, виж diagnostic отчета) — тук проверяваме
  // само че PUBLISHED конфигурационният файл продължава да отразява тези
  // изисквания текстово (regression срещу случайна бъдеща промяна).
  console.log('\nПроверявам nginx конфигурационния fragment (структурни проверки)...')
  const nginxConfPath = join(PROJECT_ROOT, 'deploy', 'nginx-frontend-cache-headers.conf.example')
  const nginxConf = await readFile(nginxConfPath, 'utf8')

  await check('[12a] Hashed regex location е В КАВИЧКИ (заради {n,m} quantifier — иначе nginx -t fail-ва)', () => {
    if (!nginxConf.includes('location ~ "^/assets/')) throw new Error('Regex location-ът не е quoted')
  })
  await check('[12b] Hashed regex location получава immutable Cache-Control', () => {
    // Матчваме до края на quoted низа ПЪРВО (той сам съдържа { от {n,m}
    // quantifier-а) — иначе "стигни до първата {" грешно спира вътре в
    // самия regex pattern, преди да достигне истинското тяло на блока.
    const m = nginxConf.match(/location ~ "[^"]*"\s*\{[\s\S]*?\n {4}\}/)
    if (!m || !m[0].includes('immutable')) throw new Error(`Hashed location блокът не съдържа immutable. Матч:\n${m?.[0]}`)
  })
  await check('[12c] Plain-prefix /assets/ location НЕ използва ^~ (иначе блокира regex-а изцяло)', () => {
    if (nginxConf.includes('location ^~ /assets/')) throw new Error('Открит е ^~ /assets/ — би блокирал hashed regex location-а от изобщо да бъде проверен')
    if (!nginxConf.includes('location /assets/ {')) throw new Error('Липсва plain-prefix location /assets/ fallback')
  })
  await check('[12d] Plain-prefix /assets/ (mutable) location НЕ получава immutable — умерен max-age', () => {
    const m = nginxConf.match(/location \/assets\/ \{[\s\S]*?\}/)
    if (!m) throw new Error('Не намерих location /assets/ блока')
    if (m[0].includes('immutable')) throw new Error('Mutable /assets/ location погрешно получава immutable')
    if (!m[0].includes('max-age=86400')) throw new Error('Mutable /assets/ location няма очаквания умерен max-age=86400')
  })
  await check('[13] index.html/sw.js/manifest.webmanifest получават no-cache, must-revalidate', () => {
    for (const name of ['/index.html', '/sw.js', '/manifest.webmanifest']) {
      const re = new RegExp(`location = ${name.replace('.', '\\.')} \\{[\\s\\S]*?\\}`)
      const m = nginxConf.match(re)
      if (!m || !m[0].includes('no-cache, must-revalidate')) throw new Error(`${name} location не съдържа no-cache, must-revalidate`)
    }
  })

  // ─── [14] Missing SHARED HASHED ресурс блокира swap (различно от [9] mutable) ──
  console.log('\nТествам precache closure gate за липсващ HASHED ресурс (различно от mutable в [9])...')
  const hProjectRoot = await mkdtemp(join(tmpdir(), 'belot-hashed-missing-project-'))
  const hDeployRoot = await mkdtemp(join(tmpdir(), 'belot-hashed-missing-deploy-'))
  try {
    const { symlink } = await import('node:fs/promises')
    await cp(join(PROJECT_ROOT, 'package.json'), join(hProjectRoot, 'package.json'))
    await cp(join(PROJECT_ROOT, 'tsconfig.json'), join(hProjectRoot, 'tsconfig.json'))
    await cp(join(PROJECT_ROOT, 'index.html'), join(hProjectRoot, 'index.html'))
    await symlink(join(PROJECT_ROOT, 'node_modules'), join(hProjectRoot, 'node_modules'), 'junction')
    await cp(join(PROJECT_ROOT, 'src'), join(hProjectRoot, 'src'), { recursive: true })
    await cp(join(PROJECT_ROOT, 'public'), join(hProjectRoot, 'public'), { recursive: true }).catch(() => {})
    await mkdir(join(hProjectRoot, 'scripts'), { recursive: true })
    await cp(join(PROJECT_ROOT, 'scripts', 'validatePrecacheClosure.mjs'), join(hProjectRoot, 'scripts', 'validatePrecacheClosure.mjs'))

    const originalViteConfig = await readFile(join(PROJECT_ROOT, 'vite.config.ts'), 'utf8')
    // Phantom hashed URL: матчва hash-pattern-а (8 главни букви + .js), но
    // файлът никога няма да съществува никъде — трябва да бъде класифициран
    // като HASHED (не mutable, за разлика от [9]) и да блокира swap-а.
    const brokenViteConfig = originalViteConfig.replace(
      'injectManifest: {',
      "injectManifest: {\n        additionalManifestEntries: [{ url: 'assets/phantom-name-ABCDEFGH.js', revision: 'test-marker' }],",
    )
    if (brokenViteConfig === originalViteConfig) {
      throw new Error('vite.config.ts patch не съвпадна')
    }
    await writeFile(join(hProjectRoot, 'vite.config.ts'), brokenViteConfig)

    const rBad = await runDeployScript(hDeployRoot, [], { PROJECT_ROOT: hProjectRoot, VITE_BUILD_ID: 'hashed-missing' })
    await check('[14a] Deploy с липсващ HASHED precache ресурс fail-ва (exit != 0)', () => {
      if (rBad.code === 0) throw new Error('Скриптът е върнал success въпреки липсващия hashed ресурс')
    })
    await check('[14b] Fail изходът категоризира ресурса като "shared hashed pool"', () => {
      if (!rBad.stderr.includes('shared hashed pool')) throw new Error(`stderr:\n${rBad.stderr.slice(-1000)}`)
    })
    await check('[14c] Fail изходът споменава точно phantom hashed файла', () => {
      if (!rBad.stderr.includes('phantom-name-ABCDEFGH.js')) throw new Error(`stderr:\n${rBad.stderr.slice(-1000)}`)
    })
    await check('[14d] releases/ остава празна (нищо не е публикувано)', () => {
      const releasesNow = listReleases(hDeployRoot)
      if (releasesNow.length !== 0) throw new Error(`releases=${JSON.stringify(releasesNow)}`)
    })
  } finally {
    await rm(hProjectRoot, { recursive: true, force: true })
    await rm(hDeployRoot, { recursive: true, force: true })
  }

  // ─── [15] --adopt baseline миграция + валиден rollback target след нов deploy ──
  console.log('\nТествам --adopt baseline миграция (без build) + следващ нормален deploy...')
  const adoptDeployRoot = await mkdtemp(join(tmpdir(), 'belot-adopt-deploy-'))
  try {
    const realDistPath = join(PROJECT_ROOT, 'dist')
    if (!existsSync(join(realDistPath, 'index.html'))) {
      throw new Error(`dist/ липсва или е непълен — очаквах вече build-нат dist от предходна стъпка: ${realDistPath}`)
    }

    const rAdopt = await runDeployScript(adoptDeployRoot, ['--adopt', realDistPath])
    await check('[15a] --adopt завършва успешно, БЕЗ да build-ва (само копира съществуващия dist)', () => {
      if (rAdopt.code !== 0) throw new Error(`exit=${rAdopt.code}\n${rAdopt.stdout.slice(-500)}\n${rAdopt.stderr.slice(-500)}`)
      if (rAdopt.stdout.includes('building client environment for production')) {
        throw new Error('--adopt погрешно е задействал реален vite build — трябваше само да копира')
      }
      if (!rAdopt.stdout.includes('Adopt режим')) throw new Error('Логът не потвърждава adopt режима')
    })
    const baselineRelease = listReleases(adoptDeployRoot)[0]
    await check('[15b] Baseline release id съдържа "baseline" маркера', () => {
      if (!baselineRelease.includes('baseline')) throw new Error(`release id=${baselineRelease}`)
    })
    await check('[15c] Baseline "current" е готов ЛОКАЛНО (index.html + hashed pool + mutable assets всички налични)', () => {
      if (!existsSync(join(adoptDeployRoot, 'current', 'index.html'))) throw new Error('current/index.html липсва')
      const poolFiles = existsSync(join(adoptDeployRoot, 'assets')) ? readdirSync(join(adoptDeployRoot, 'assets')) : []
      if (poolFiles.length === 0) throw new Error('shared hashed pool е празен след adopt')
    })

    // Нов, реален deploy (build) върху вече мигрирания baseline.
    await sleep(1100)
    const rSecond = await runDeployScript(adoptDeployRoot, [], { VITE_BUILD_ID: 'post-adopt-real' })
    await check('[15d] Следващ нормален (реален build) deploy след --adopt завършва успешно', () => {
      if (rSecond.code !== 0) throw new Error(`exit=${rSecond.code}\n${rSecond.stdout.slice(-500)}\n${rSecond.stderr.slice(-500)}`)
    })
    const releasesAfterSecond = listReleases(adoptDeployRoot)
    await check('[15e] След първия нов deploy има точно 2 release-а (baseline + новия)', () => {
      if (releasesAfterSecond.length !== 2) throw new Error(`releases=${JSON.stringify(releasesAfterSecond)}`)
    })

    if (HAS_REAL_SYMLINKS) {
      const rollbackDry = await runDeployScript(adoptDeployRoot, ['--rollback', '--dry-run'])
      await check('[15f] Валиден rollback target съществува — сочи към baseline release-а', () => {
        if (!rollbackDry.stdout.includes(`-> ${baselineRelease}`)) {
          throw new Error(`Очаквах rollback target ${baselineRelease}:\n${rollbackDry.stdout}`)
        }
      })
    } else {
      skip('[15f] Валиден rollback target след --adopt', 'изисква истински symlink за "current" — недоказуемо на тази машина')
    }
  } finally {
    await rm(adoptDeployRoot, { recursive: true, force: true })
  }
} finally {
  if (deployRoot) await rm(deployRoot, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}`)
if (failed > 0) process.exit(1)
