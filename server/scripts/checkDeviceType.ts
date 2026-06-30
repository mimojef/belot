/**
 * Unit tests for detectDeviceType()
 *
 * [1]  iPhone / iPod → mobile
 * [2]  Android + Mobile token → mobile
 * [3]  iPad (explicit) → tablet
 * [4]  iPadOS desktop-like UA (Macintosh + Mobile) → tablet
 * [5]  Android without Mobile → tablet
 * [6]  Windows → desktop
 * [7]  macOS (without Mobile) → desktop
 * [8]  Linux → desktop
 * [9]  ChromeOS → desktop
 * [10] Unrecognised UA → unknown
 * [11] Empty / null UA → client-hints fallback
 * [12] Client hints: sec-ch-ua-mobile=?1 → mobile
 * [13] Client hints: platform android → mobile
 * [14] Client hints: platform windows → desktop
 * [15] Client hints: sec-ch-ua-mobile=?0 (no platform) → desktop
 * [16] No UA, no hints → unknown
 */

import { detectDeviceType } from '../src/utils/detectDeviceType.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function d(ua: string | null, mobile: string | null = null, platform: string | null = null) {
  return detectDeviceType({ userAgent: ua, secChUaMobile: mobile, secChUaPlatform: platform })
}

function eq(label: string, got: string, want: string) {
  check(label, () => {
    if (got !== want) throw new Error(`got=${got}, want=${want}`)
  })
}

// ─── [1] iPhone / iPod ───────────────────────────────────────────────────────

console.log('\n[1] iPhone / iPod → mobile')
eq('[1.1] iPhone UA', d('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'mobile')
eq('[1.2] iPod UA', d('Mozilla/5.0 (iPod touch; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'), 'mobile')

// ─── [2] Android + Mobile ─────────────────────────────────────────────────────

console.log('\n[2] Android + Mobile token → mobile')
eq('[2.1] Android Chrome mobile', d('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36'), 'mobile')
eq('[2.2] Android Firefox mobile', d('Mozilla/5.0 (Android 12; Mobile; rv:109.0) Gecko/109.0 Firefox/109.0'), 'mobile')

// ─── [3] iPad (explicit) ──────────────────────────────────────────────────────

console.log('\n[3] iPad (explicit) → tablet')
eq('[3.1] iPad Safari classic', d('Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'), 'tablet')
eq('[3.2] iPad Chrome', d('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/116.0.5845.90 Mobile/15E148 Safari/604.1'), 'tablet')

// ─── [4] iPadOS desktop-like UA (Macintosh + Mobile) ─────────────────────────

console.log('\n[4] iPadOS desktop-like (Macintosh + Mobile) → tablet')
eq('[4.1] iPadOS 13+ desktop-mode Safari', d('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/22B83 Safari/604.1'), 'tablet')

// ─── [5] Android without Mobile ──────────────────────────────────────────────

console.log('\n[5] Android without Mobile → tablet')
eq('[5.1] Android tablet Chrome', d('Mozilla/5.0 (Linux; Android 12; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'), 'tablet')
eq('[5.2] Android tablet Firefox', d('Mozilla/5.0 (Android 12; Tablet; rv:109.0) Gecko/109.0 Firefox/109.0'), 'tablet')

// ─── [6] Windows → desktop ───────────────────────────────────────────────────

console.log('\n[6] Windows → desktop')
eq('[6.1] Windows Chrome', d('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'), 'desktop')
eq('[6.2] Windows Firefox', d('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0'), 'desktop')

// ─── [7] macOS (no Mobile) → desktop ─────────────────────────────────────────

console.log('\n[7] macOS → desktop')
eq('[7.1] macOS Safari', d('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15'), 'desktop')
eq('[7.2] macOS Chrome', d('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'), 'desktop')

// ─── [8] Linux → desktop ─────────────────────────────────────────────────────

console.log('\n[8] Linux → desktop')
eq('[8.1] Linux Chrome', d('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'), 'desktop')
eq('[8.2] Linux Firefox', d('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/117.0'), 'desktop')

// ─── [9] ChromeOS → desktop ──────────────────────────────────────────────────

console.log('\n[9] CrOS → desktop')
eq('[9.1] Chromebook', d('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'), 'desktop')

// ─── [10] Unrecognised UA → unknown ──────────────────────────────────────────

console.log('\n[10] Unrecognised UA → unknown')
eq('[10.1] bot/custom UA', d('MyCustomBot/1.0'), 'unknown')
eq('[10.2] curl UA', d('curl/7.88.1'), 'unknown')
eq('[10.3] empty string UA', d(''), 'unknown')

// ─── [11] No UA → client-hints fallback ──────────────────────────────────────

console.log('\n[11] No UA → client-hints fallback')
eq('[11.1] null UA, mobile hint ?1 → mobile', d(null, '?1', null), 'mobile')
eq('[11.2] null UA, platform windows → desktop', d(null, null, '"Windows"'), 'desktop')
eq('[11.3] null UA, platform macos → desktop', d(null, null, '"macOS"'), 'desktop')
eq('[11.4] null UA, platform linux → desktop', d(null, null, '"Linux"'), 'desktop')
eq('[11.5] null UA, platform chromeos → desktop', d(null, null, '"ChromeOS"'), 'desktop')
// android/ios platform without ?1: could be tablet — safe fallback is unknown
eq('[11.6] null UA, platform android (no ?1) → unknown', d(null, null, '"Android"'), 'unknown')
eq('[11.7] null UA, platform ios (no ?1) → unknown', d(null, null, '"iOS"'), 'unknown')
// ?0 alone says "not mobile" but does NOT confirm desktop (tablets also send ?0)
eq('[11.8] null UA, mobile hint ?0 only → unknown', d(null, '?0', null), 'unknown')

// ─── [12] Client hints: sec-ch-ua-mobile=?1 ──────────────────────────────────

console.log('\n[12] Unknown UA + sec-ch-ua-mobile=?1 → mobile')
eq('[12.1] unknown UA + ?1 hint → mobile', d('SomeBrowser/1.0 (Unknown)', '?1', '"Android"'), 'mobile')

// ─── [13] Client hints: platform android without ?1 → unknown ────────────────

console.log('\n[13] Unrecognised UA + android platform, no ?1 → unknown')
eq('[13.1] unrecognised UA + android platform (no ?1)', d('SomeBrowser/1.0', null, '"Android"'), 'unknown')

// ─── [14] Client hints: platform windows → desktop ───────────────────────────

console.log('\n[14] Unrecognised UA + platform windows → desktop')
eq('[14.1] unrecognised UA + windows platform', d('SomeBrowser/1.0', '?0', '"Windows"'), 'desktop')

// ─── [15] mobile=?0 only — insufficient for desktop ─────────────────────────

console.log('\n[15] No UA, mobile=?0, no platform → unknown (tablets also send ?0)')
eq('[15.1] ?0 alone → unknown', d(null, '?0', null), 'unknown')

// ─── [16] No UA, no hints → unknown ──────────────────────────────────────────

console.log('\n[16] No UA, no hints → unknown')
eq('[16.1] fully empty', d(null, null, null), 'unknown')

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
