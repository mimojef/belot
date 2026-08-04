import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE,
  validateProfileDisplayName,
} from '../../src/app/lobby/profileDisplayNameValidation.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS ${label}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function getSlice(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle)
  assert(start !== -1, `Missing start marker: ${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert(end !== -1, `Missing end marker: ${endNeedle}`)
  return source.slice(start, end)
}

function assertHintImmediatelyAfterInput(markup: string, inputSelector: string, hintSelector: string): void {
  const inputIndex = markup.indexOf(inputSelector)
  assert(inputIndex !== -1, `Missing input selector ${inputSelector}`)
  const hintIndex = markup.indexOf(hintSelector, inputIndex)
  assert(hintIndex !== -1, `Missing hint selector ${hintSelector} after input`)
  const between = markup.slice(inputIndex, hintIndex)
  assert(between.includes('</span>'), `${hintSelector} is not rendered after the input wrapper`)
  assert(!between.includes('position:absolute;right:10px'), `${hintSelector} still appears to be inside/right of the input`)
}

async function main(): Promise<void> {
  const renderSource = await readFile(
    resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'),
    'utf8',
  )
  const mainSource = await readFile(resolve(projectRoot, 'src/main.ts'), 'utf8')

  await check('[1] frontend validator returns exact mixed-script message', () => {
    const result = validateProfileDisplayName('\u041Cilen')
    assert(result.ok === false, 'frontend accepted mixed-script input')
    if (!result.ok) {
      assert(result.code === 'MIXED_ALPHABETS', `code=${result.code}`)
      assert(result.message === PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE, `message=${result.message}`)
    }
  })

  await check('[2] registration live validation selector renders hint immediately under field', () => {
    const markup = getSlice(renderSource, 'data-lobby-auth-form=', 'function renderProfileEditModal')
    assertHintImmediatelyAfterInput(
      markup,
      'data-name-check-input="register"',
      'data-name-hint="register"',
    )
  })

  await check('[3] self/admin rename live validation selector renders hint immediately under field', () => {
    const markup = getSlice(renderSource, 'function renderProfileEditModal', 'function renderMissionsPopup')
    assertHintImmediatelyAfterInput(
      markup,
      'data-name-check-input="namechange"',
      'data-name-hint="namechange"',
    )
    assert(markup.includes('const isAdminTargetEdit = state.profileEditorTargetProfileId !== null && state.isAdmin'), 'admin target edit detection missing')
    assert(markup.includes('? (state.profileEditorTargetProfile ?? state.profile)'), 'admin edit does not use target profile context')
  })

  await check('[4] live validation attaches to registration and namechange without full render/focus/caret churn', () => {
    const body = getSlice(renderSource, 'function attachNameAvailabilityCheck(', 'function showAuthError(')
    assert(body.includes('validateProfileDisplayName(input.value, validationOptions)'), 'live validator does not use shared validator options')
    assert(body.includes("setHint(validation.message, '#f87171')"), 'live validator does not show validator message under field')
    assert(!body.includes('render()'), 'live validation should not trigger full render on input')
    assert(!body.includes('replaceWith('), 'live validation should not replace the input element')
    assert(!body.includes('outerHTML'), 'live validation should not rewrite the input element')
    assert(!body.includes('input.focus()'), 'live validation should not move focus')
    assert(!body.includes('setSelectionRange'), 'live validation should not move caret')

    const wiring = getSlice(renderSource, ";(['register', 'namechange'] as const).forEach", 'data-lobby-auth-modal-close')
    assert(wiring.includes('attachNameAvailabilityCheck(input, hint, key === \'namechange\' ? profileNameValidationOptions : {})'), 'registration/namechange live validation wiring missing')
  })

  await check('[5] client submit guards block invalid names before API calls', () => {
    assert(mainSource.includes('const validation = validateProfileDisplayName(displayName, {'), 'profile rename submit guard missing validator context')
    assert(/if \(!validation\.ok\) \{\s+return validation\.message\s+\}/.test(mainSource), 'profile rename submit guard does not return validator message')
    assert(mainSource.includes('const validation = validateProfileDisplayName(displayName)'), 'registration submit guard missing validator')
  })

  console.log(`\nProfile name frontend live-validation checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
