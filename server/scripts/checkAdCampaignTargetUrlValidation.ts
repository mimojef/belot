/**
 * checkAdCampaignTargetUrlValidation.ts
 *
 * Чист unit тест (без spawn на сървър) за isSafeAdCampaignTargetUrl —
 * positive allowlist: relative SPA path ИЛИ https://pika.bg/*.pika.bg.
 * Плюс normalizeAdCampaignTargetUrl — target е optional (missing/null/празен
 * string нормализира до null "без target", само непразен string се валидира).
 */

import { isSafeAdCampaignTargetUrl, normalizeAdCampaignTargetUrl } from '../src/adCampaigns/validateAdCampaignTargetUrl.js'

let passed = 0
let failed = 0

function check(label: string, actual: boolean, expected: boolean): void {
  if (actual === expected) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.error(`  FAIL  ${label}: got ${actual}, expected ${expected}`)
  }
}

function checkNormalization(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.error(`  FAIL  ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

console.log('\n=== isSafeAdCampaignTargetUrl ===\n')

check('relative path /tournaments е позволен', isSafeAdCampaignTargetUrl('/tournaments'), true)
check('relative path с query/hash е позволен', isSafeAdCampaignTargetUrl('/tournaments?ref=ad#top'), true)
check('https://pika.bg/tournaments е позволен', isSafeAdCampaignTargetUrl('https://pika.bg/tournaments'), true)
check('https://www.pika.bg/x (subdomain) е позволен', isSafeAdCampaignTargetUrl('https://www.pika.bg/x'), true)
check('https://pika.bg (без path) е позволен', isSafeAdCampaignTargetUrl('https://pika.bg'), true)

check('празен string се отхвърля', isSafeAdCampaignTargetUrl(''), false)
check('само whitespace се отхвърля', isSafeAdCampaignTargetUrl('   '), false)
check('javascript: се отхвърля', isSafeAdCampaignTargetUrl('javascript:alert(1)'), false)
check('data: се отхвърля', isSafeAdCampaignTargetUrl('data:text/html,<script>alert(1)</script>'), false)
check('vbscript: се отхвърля', isSafeAdCampaignTargetUrl('vbscript:msgbox(1)'), false)
check('// protocol-relative се отхвърля', isSafeAdCampaignTargetUrl('//evil.com/phish'), false)
check('relative path с backslash се отхвърля', isSafeAdCampaignTargetUrl('/\\evil.com'), false)
check('http:// (не https) на pika.bg се отхвърля', isSafeAdCampaignTargetUrl('http://pika.bg/x'), false)
check('https://evil.com се отхвърля', isSafeAdCampaignTargetUrl('https://evil.com/x'), false)
check('https://notpika.bg се отхвърля (не suffix match на pika.bg)', isSafeAdCampaignTargetUrl('https://notpika.bg/x'), false)
check('https://pika.bg.evil.com се отхвърля (suffix trick)', isSafeAdCampaignTargetUrl('https://pika.bg.evil.com/x'), false)
check('невалиден URL string се отхвърля', isSafeAdCampaignTargetUrl('not a url at all'), false)
check('прекалено дълъг string (>2048) се отхвърля', isSafeAdCampaignTargetUrl(`/${'a'.repeat(2100)}`), false)
check('control characters в relative path се отхвърлят', isSafeAdCampaignTargetUrl('/tournaments\x00'), false)

console.log('\n=== normalizeAdCampaignTargetUrl (target е optional) ===\n')

checkNormalization('missing (undefined) -> ok:true, targetUrl:null ("без target")', normalizeAdCampaignTargetUrl(undefined), { ok: true, targetUrl: null })
checkNormalization('null -> ok:true, targetUrl:null', normalizeAdCampaignTargetUrl(null), { ok: true, targetUrl: null })
checkNormalization('празен string -> ok:true, targetUrl:null (empty нормализира до null)', normalizeAdCampaignTargetUrl(''), { ok: true, targetUrl: null })
checkNormalization('само whitespace -> ok:true, targetUrl:null', normalizeAdCampaignTargetUrl('   '), { ok: true, targetUrl: null })
checkNormalization('валиден relative path -> ok:true, trimmed стойност', normalizeAdCampaignTargetUrl('  /tournaments  '), { ok: true, targetUrl: '/tournaments' })
checkNormalization('валиден https://pika.bg -> ok:true, стойност запазена', normalizeAdCampaignTargetUrl('https://pika.bg/tournaments'), { ok: true, targetUrl: 'https://pika.bg/tournaments' })
checkNormalization(
  'unsafe non-empty target (javascript:) -> ok:false, все още отхвърлен',
  normalizeAdCampaignTargetUrl('javascript:alert(1)'),
  { ok: false, message: 'Невалиден адрес. Разрешени са само вътрешни адреси или https://pika.bg линкове.' },
)
checkNormalization(
  'unsafe non-empty target (https://evil.com) -> ok:false',
  normalizeAdCampaignTargetUrl('https://evil.com/x'),
  { ok: false, message: 'Невалиден адрес. Разрешени са само вътрешни адреси или https://pika.bg линкове.' },
)
checkNormalization('non-string тип (число) -> ok:false, не хвърля exception', normalizeAdCampaignTargetUrl(42), { ok: false, message: 'Невалиден адрес.' })

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}
