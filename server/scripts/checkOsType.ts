/**
 * Unit tests for detectOsType()
 *
 * [1]  Windows UA → windows
 * [2]  Android UA → android
 * [3]  iPhone UA → ios
 * [4]  iPad UA → ios
 * [5]  macOS UA → macos
 * [6]  Linux desktop UA → linux
 * [7]  ChromeOS UA → chromeos
 * [8]  Empty / missing UA → unknown
 * [9]  Android is never classified as linux (priority order)
 * [10] ChromeOS is never classified as linux (priority order)
 */

import { detectOsType } from '../src/utils/detectOsType.js'

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

function eq(label: string, got: string, want: string) {
  check(label, () => {
    if (got !== want) throw new Error(`got=${got}, want=${want}`)
  })
}

const WINDOWS_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
const ANDROID_UA  = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36'
const IPHONE_UA   = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IPAD_UA     = 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
const MACOS_UA    = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15'
const LINUX_UA    = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
const CHROMEOS_UA = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'

console.log('\n[1] Windows UA → windows')
eq('[1.1] Windows Chrome', detectOsType(WINDOWS_UA), 'windows')

console.log('\n[2] Android UA → android')
eq('[2.1] Android Chrome (phone)', detectOsType(ANDROID_UA), 'android')
eq('[2.2] Android tablet UA (no Mobile token)', detectOsType('Mozilla/5.0 (Linux; Android 12; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'), 'android')

console.log('\n[3] iPhone UA → ios')
eq('[3.1] iPhone Safari', detectOsType(IPHONE_UA), 'ios')
eq('[3.2] iPod', detectOsType('Mozilla/5.0 (iPod touch; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'), 'ios')

console.log('\n[4] iPad UA → ios')
eq('[4.1] iPad Safari', detectOsType(IPAD_UA), 'ios')

console.log('\n[5] macOS UA → macos')
eq('[5.1] macOS Safari', detectOsType(MACOS_UA), 'macos')
eq('[5.2] macOS Chrome', detectOsType('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'), 'macos')

console.log('\n[6] Linux desktop UA → linux')
eq('[6.1] Linux Chrome', detectOsType(LINUX_UA), 'linux')
eq('[6.2] Linux Firefox', detectOsType('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/117.0'), 'linux')

console.log('\n[7] ChromeOS UA → chromeos')
eq('[7.1] Chromebook', detectOsType(CHROMEOS_UA), 'chromeos')

console.log('\n[8] Empty / missing UA → unknown')
eq('[8.1] empty string', detectOsType(''), 'unknown')
eq('[8.2] null', detectOsType(null), 'unknown')
eq('[8.3] undefined', detectOsType(undefined), 'unknown')
eq('[8.4] unrecognised bot UA', detectOsType('MyCustomBot/1.0'), 'unknown')

console.log('\n[9] Android is never classified as linux')
eq('[9.1] Android UA contains "Linux" token but must resolve to android', detectOsType(ANDROID_UA), 'android')
check('[9.2] Android UA classification is not linux', () => {
  if (detectOsType(ANDROID_UA) === 'linux') throw new Error('Android UA misclassified as linux')
})

console.log('\n[10] ChromeOS is never classified as linux')
eq('[10.1] CrOS UA resolves to chromeos', detectOsType(CHROMEOS_UA), 'chromeos')
check('[10.2] CrOS UA classification is not linux', () => {
  if (detectOsType(CHROMEOS_UA) === 'linux') throw new Error('ChromeOS UA misclassified as linux')
})

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
