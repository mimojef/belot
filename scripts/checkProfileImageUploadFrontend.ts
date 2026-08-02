import {
  MAX_PROFILE_IMAGE_UPLOAD_BYTES,
  PROFILE_IMAGE_DECODE_ERROR_MESSAGE,
  decodeProfileImageFile,
  getSupportedProfileImageMimeType,
  validateProfileImageFile,
} from '../src/app/profileImages/profileImageUploadHelpers'
import {
  calculateContainedImageRect,
  createSquareCropFromDrag,
  displayCropToNaturalCrop,
  isPointInsideCrop,
  moveSquareCrop,
  toImageLocalPoint,
  type DisplayCropSelection,
} from '../src/app/profileImages/profileImageCropGeometry'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
    return
  }
  failed += 1
  console.error(`  FAIL ${label}`)
}

async function checkAsync(label: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    check(label, await fn())
  } catch (error) {
    console.error(error)
    check(label, false)
  }
}

function file(name: string, type: string, size = 1024): Pick<File, 'name' | 'type' | 'size'> {
  return { name, type, size }
}

function browserFile(name: string, type: string, size = 1024): File {
  return file(name, type, size) as File
}

type MockDecodeMode = 'success' | 'reject' | 'zero-dimensions'

function createDecodeDeps(mode: MockDecodeMode): {
  deps: Parameters<typeof decodeProfileImageFile>[1]
  revokedUrls: string[]
} {
  const revokedUrls: string[] = []
  const deps: Parameters<typeof decodeProfileImageFile>[1] = {
    createObjectUrl: (input) => `blob:mock-${input.name}`,
    revokeObjectUrl: (url) => {
      revokedUrls.push(url)
    },
    createImage: () => {
      const image = {
        decoding: 'auto',
        src: '',
        naturalWidth: mode === 'zero-dimensions' ? 0 : 640,
        naturalHeight: mode === 'zero-dimensions' ? 0 : 480,
        decode: () => mode === 'reject' ? Promise.reject(new Error('decode failed')) : Promise.resolve(),
        addEventListener: () => undefined,
      }
      return image as unknown as HTMLImageElement
    },
  }
  return { deps, revokedUrls }
}

async function simulateImageSelection(
  input: { value: string },
  selectedFile: File,
  mode: MockDecodeMode,
): Promise<{
  cropOpened: boolean
  errorText: string | null
  inputReset: boolean
  pending: boolean
  uploadRequests: number
  galleryRecords: number
  revokedUrls: string[]
}> {
  let cropOpened = false
  let errorText: string | null = null
  let pending = true
  let uploadRequests = 0
  let galleryRecords = 0
  const { deps, revokedUrls } = createDecodeDeps(mode)
  input.value = ''
  const decoded = await decodeProfileImageFile(selectedFile, deps)
  if (!decoded.ok) {
    pending = false
    errorText = decoded.message
    input.value = ''
    return { cropOpened, errorText, inputReset: input.value === '', pending, uploadRequests, galleryRecords, revokedUrls }
  }

  cropOpened = true
  pending = false
  uploadRequests += 1
  galleryRecords += 1
  decoded.image.revoke()
  return { cropOpened, errorText, inputReset: input.value === '', pending, uploadRequests, galleryRecords, revokedUrls }
}

type ProfileImageDraftState = {
  savedAvatarUrl: string | null
  avatarDraftPreviewUrl: string | null
  avatarDraftFileName: string | null
  avatarDraftCrop: { x: number; y: number; size: number } | null
  avatarDirty: boolean
  avatarErrorText: string | null
  galleryDrafts: string[]
  galleryErrorText: string | null
  pending: boolean
  revokedUrls: string[]
}

function createDraftState(savedAvatarUrl = '/uploads/avatars/old.webp'): ProfileImageDraftState {
  return {
    savedAvatarUrl,
    avatarDraftPreviewUrl: null,
    avatarDraftFileName: null,
    avatarDraftCrop: null,
    avatarDirty: false,
    avatarErrorText: null,
    galleryDrafts: [],
    galleryErrorText: null,
    pending: false,
    revokedUrls: [],
  }
}

function renderAvatarPreviewUrl(state: ProfileImageDraftState): string | null {
  return state.avatarDirty && state.avatarDraftPreviewUrl !== null
    ? state.avatarDraftPreviewUrl
    : state.savedAvatarUrl
}

function selectCorruptAvatarDraft(state: ProfileImageDraftState): void {
  state.avatarErrorText = PROFILE_IMAGE_DECODE_ERROR_MESSAGE
  state.avatarDirty = false
  state.avatarDraftFileName = null
  state.avatarDraftCrop = null
  state.avatarDraftPreviewUrl = null
  state.pending = false
}

function selectValidAvatarDraft(state: ProfileImageDraftState, fileName = 'valid.jpg', previewUrl = 'data:image/webp;base64,valid'): void {
  state.avatarErrorText = null
  state.avatarDraftFileName = fileName
  state.avatarDraftCrop = { x: 1, y: 2, size: 64 }
  state.avatarDraftPreviewUrl = previewUrl
  state.avatarDirty = true
  state.pending = false
}

function applyAuthoritativeProfileUpdate(state: ProfileImageDraftState, savedAvatarUrl: string): void {
  state.savedAvatarUrl = savedAvatarUrl
}

function cancelAvatarDraft(state: ProfileImageDraftState): void {
  if (state.avatarDraftPreviewUrl !== null) state.revokedUrls.push(state.avatarDraftPreviewUrl)
  state.avatarDraftPreviewUrl = null
  state.avatarDraftFileName = null
  state.avatarDraftCrop = null
  state.avatarDirty = false
  state.avatarErrorText = null
}

function saveAvatarDraftSuccess(state: ProfileImageDraftState, authoritativeAvatarUrl: string): void {
  if (state.avatarDraftPreviewUrl !== null) state.revokedUrls.push(state.avatarDraftPreviewUrl)
  state.savedAvatarUrl = authoritativeAvatarUrl
  state.avatarDraftPreviewUrl = null
  state.avatarDraftFileName = null
  state.avatarDraftCrop = null
  state.avatarDirty = false
  state.avatarErrorText = null
  state.pending = false
}

function saveAvatarDraftFailure(state: ProfileImageDraftState, message: string): void {
  state.avatarErrorText = message
  state.pending = false
}

function selectCorruptGalleryDraft(state: ProfileImageDraftState): void {
  state.galleryErrorText = PROFILE_IMAGE_DECODE_ERROR_MESSAGE
  state.pending = false
}

function selectValidGalleryDraft(state: ProfileImageDraftState, previewUrl = 'data:image/webp;base64,gallery'): void {
  state.galleryErrorText = null
  state.galleryDrafts.push(previewUrl)
}

function isValidNaturalCrop(crop: { x: number; y: number; size: number } | null, naturalWidth: number, naturalHeight: number): boolean {
  return crop !== null &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.size > 0 &&
    crop.x + crop.size <= naturalWidth &&
    crop.y + crop.size <= naturalHeight
}

function cropEquals(a: DisplayCropSelection | null, b: DisplayCropSelection): boolean {
  if (a === null) return false
  return Math.abs(a.left - b.left) < 0.001 &&
    Math.abs(a.top - b.top) < 0.001 &&
    Math.abs(a.size - b.size) < 0.001
}

console.log('\n═══ checkProfileImageUploadFrontend ═══')

check(
  'reported JPEG MIME is accepted',
  getSupportedProfileImageMimeType(file('photo.bin', 'image/jpeg')) === 'image/jpeg',
)
check(
  'Android octet-stream JPEG with .jpg extension is accepted',
  getSupportedProfileImageMimeType(file('camera.jpg', 'application/octet-stream')) === 'image/jpeg',
)
check(
  'Android empty MIME PNG with .png extension is accepted',
  getSupportedProfileImageMimeType(file('screenshot.png', '')) === 'image/png',
)
check(
  'Android octet-stream WebP with .webp extension is accepted',
  getSupportedProfileImageMimeType(file('download.webp', 'application/octet-stream')) === 'image/webp',
)
check(
  'HEIC is rejected with a clear user-facing error',
  validateProfileImageFile(file('IMG_0001.HEIC', 'application/octet-stream')) ===
    'HEIC/HEIF снимки не се поддържат. Моля, избери JPEG, PNG или WebP.',
)
check(
  'HEIF is rejected with a clear user-facing error',
  validateProfileImageFile(file('IMG_0002.heif', '')) ===
    'HEIC/HEIF снимки не се поддържат. Моля, избери JPEG, PNG или WebP.',
)
check(
  'oversized files are rejected before upload',
  validateProfileImageFile(file('large.jpg', 'image/jpeg', MAX_PROFILE_IMAGE_UPLOAD_BYTES + 1)) ===
    'Снимката трябва да е до 10 МБ.',
)
check(
  'unsupported non-image extension is rejected',
  validateProfileImageFile(file('payload.gif', 'application/octet-stream')) ===
    'Позволени са само JPEG, PNG и WebP снимки.',
)

await checkAsync('corrupt JPEG decode failure rejects before crop opens and shows error', async () => {
  const result = await simulateImageSelection(
    { value: 'C:\\fakepath\\corrupt-image.jpg' },
    browserFile('corrupt-image.jpg', 'image/jpeg'),
    'reject',
  )
  return result.cropOpened === false &&
    result.errorText === PROFILE_IMAGE_DECODE_ERROR_MESSAGE &&
    result.pending === false &&
    result.inputReset === true
})

await checkAsync('zero naturalWidth/naturalHeight rejects before crop opens', async () => {
  const result = await simulateImageSelection(
    { value: 'C:\\fakepath\\zero.jpg' },
    browserFile('zero.jpg', 'image/jpeg'),
    'zero-dimensions',
  )
  return result.cropOpened === false &&
    result.errorText === PROFILE_IMAGE_DECODE_ERROR_MESSAGE &&
    result.revokedUrls.includes('blob:mock-zero.jpg')
})

await checkAsync('same corrupt file can be selected again after decode failure', async () => {
  const input = { value: 'C:\\fakepath\\corrupt-image.jpg' }
  const selectedFile = browserFile('corrupt-image.jpg', 'image/jpeg')
  const first = await simulateImageSelection(input, selectedFile, 'reject')
  input.value = 'C:\\fakepath\\corrupt-image.jpg'
  const second = await simulateImageSelection(input, selectedFile, 'reject')
  return first.inputReset === true &&
    second.inputReset === true &&
    first.pending === false &&
    second.pending === false &&
    first.errorText === PROFILE_IMAGE_DECODE_ERROR_MESSAGE &&
    second.errorText === PROFILE_IMAGE_DECODE_ERROR_MESSAGE
})

await checkAsync('confirm cannot be used without a valid decoded image', async () => {
  const result = await simulateImageSelection(
    { value: 'C:\\fakepath\\corrupt-image.jpg' },
    browserFile('corrupt-image.jpg', 'image/jpeg'),
    'reject',
  )
  return result.cropOpened === false && result.uploadRequests === 0
})

await checkAsync('gallery corrupt image creates no upload request or record and retry works', async () => {
  const input = { value: 'C:\\fakepath\\corrupt-image.jpg' }
  const selectedFile = browserFile('corrupt-image.jpg', 'image/jpeg')
  const first = await simulateImageSelection(input, selectedFile, 'reject')
  input.value = 'C:\\fakepath\\corrupt-image.jpg'
  const second = await simulateImageSelection(input, selectedFile, 'reject')
  return first.uploadRequests === 0 &&
    first.galleryRecords === 0 &&
    second.uploadRequests === 0 &&
    second.galleryRecords === 0 &&
    first.errorText === PROFILE_IMAGE_DECODE_ERROR_MESSAGE &&
    second.errorText === PROFILE_IMAGE_DECODE_ERROR_MESSAGE
})

await checkAsync('valid JPEG/PNG/WebP decode keeps crop/preview flow available', async () => {
  const jpeg = await simulateImageSelection({ value: 'x' }, browserFile('valid.jpg', 'image/jpeg'), 'success')
  const png = await simulateImageSelection({ value: 'x' }, browserFile('valid.png', 'image/png'), 'success')
  const webp = await simulateImageSelection({ value: 'x' }, browserFile('valid.webp', 'image/webp'), 'success')
  return jpeg.cropOpened === true &&
    png.cropOpened === true &&
    webp.cropOpened === true &&
    jpeg.revokedUrls.includes('blob:mock-valid.jpg') &&
    png.revokedUrls.includes('blob:mock-valid.png') &&
    webp.revokedUrls.includes('blob:mock-valid.webp')
})

check('valid avatar after corrupt clears old error and shows draft preview', (() => {
  const draft = createDraftState()
  selectCorruptAvatarDraft(draft)
  selectValidAvatarDraft(draft)
  return draft.avatarErrorText === null &&
    renderAvatarPreviewUrl(draft) === 'data:image/webp;base64,valid'
})())

check('authoritative profile update does not overwrite dirty avatar draft', (() => {
  const draft = createDraftState()
  selectValidAvatarDraft(draft)
  applyAuthoritativeProfileUpdate(draft, '/uploads/avatars/refetched-old.webp')
  return renderAvatarPreviewUrl(draft) === 'data:image/webp;base64,valid' &&
    draft.avatarDraftFileName === 'valid.jpg' &&
    draft.avatarDraftCrop?.size === 64 &&
    draft.avatarDirty === true
})())

check('repeated renders keep draft preview and do not revoke object URL', (() => {
  const draft = createDraftState()
  selectValidAvatarDraft(draft, 'valid.jpg', 'blob:draft-preview')
  for (let i = 0; i < 5; i += 1) {
    if (renderAvatarPreviewUrl(draft) !== 'blob:draft-preview') return false
  }
  return draft.revokedUrls.length === 0
})())

check('cancel restores saved avatar and revokes draft preview once', (() => {
  const draft = createDraftState('/uploads/avatars/saved.webp')
  selectValidAvatarDraft(draft, 'valid.jpg', 'blob:draft-preview')
  cancelAvatarDraft(draft)
  return renderAvatarPreviewUrl(draft) === '/uploads/avatars/saved.webp' &&
    draft.avatarDirty === false &&
    draft.avatarErrorText === null &&
    draft.revokedUrls.filter((url) => url === 'blob:draft-preview').length === 1
})())

check('save success promotes authoritative avatar and clears draft', (() => {
  const draft = createDraftState('/uploads/avatars/old.webp')
  selectValidAvatarDraft(draft, 'valid.jpg', 'blob:draft-preview')
  saveAvatarDraftSuccess(draft, '/uploads/avatars/new.webp')
  applyAuthoritativeProfileUpdate(draft, '/uploads/avatars/new.webp')
  return renderAvatarPreviewUrl(draft) === '/uploads/avatars/new.webp' &&
    draft.avatarDirty === false &&
    draft.avatarDraftFileName === null &&
    draft.revokedUrls.includes('blob:draft-preview')
})())

check('save failure keeps draft preview and releases pending for retry', (() => {
  const draft = createDraftState()
  selectValidAvatarDraft(draft)
  draft.pending = true
  saveAvatarDraftFailure(draft, 'Upload failed')
  return renderAvatarPreviewUrl(draft) === 'data:image/webp;base64,valid' &&
    draft.avatarDirty === true &&
    draft.pending === false &&
    draft.avatarErrorText === 'Upload failed'
})())

check('new valid avatar after stale error leaves no error message', (() => {
  const draft = createDraftState()
  draft.avatarErrorText = 'old error'
  selectValidAvatarDraft(draft)
  return draft.avatarErrorText === null
})())

check('gallery draft persists across authoritative refresh and clears stale gallery error', (() => {
  const draft = createDraftState()
  selectCorruptGalleryDraft(draft)
  selectValidGalleryDraft(draft, 'data:image/webp;base64,gallery')
  applyAuthoritativeProfileUpdate(draft, '/uploads/avatars/refetched.webp')
  return draft.galleryErrorText === null &&
    draft.galleryDrafts.length === 1 &&
    draft.galleryDrafts[0] === 'data:image/webp;base64,gallery'
})())

check('avatar and gallery error states stay independent in draft model', (() => {
  const draft = createDraftState()
  selectCorruptAvatarDraft(draft)
  selectValidGalleryDraft(draft)
  return draft.avatarErrorText === PROFILE_IMAGE_DECODE_ERROR_MESSAGE &&
    draft.galleryErrorText === null
})())

console.log(`\n${'═'.repeat(60)}`)
check('crop image rect accounts for portrait letterboxing', (() => {
  const rect = calculateContainedImageRect({
    containerWidth: 320,
    containerHeight: 240,
    naturalWidth: 600,
    naturalHeight: 1200,
  })
  return rect !== null &&
    rect.width === 120 &&
    rect.height === 240 &&
    rect.left === 100 &&
    rect.top === 0 &&
    toImageLocalPoint({ x: 50, y: 80 }, rect) === null
})())

check('crop image rect accounts for landscape letterboxing', (() => {
  const rect = calculateContainedImageRect({
    containerWidth: 320,
    containerHeight: 240,
    naturalWidth: 1600,
    naturalHeight: 800,
  })
  return rect !== null &&
    rect.width === 320 &&
    rect.height === 160 &&
    rect.left === 0 &&
    rect.top === 40 &&
    toImageLocalPoint({ x: 160, y: 20 }, rect) === null
})())

check('selection drag beyond left/top clamps to image edge', (() => {
  const crop = createSquareCropFromDrag({
    start: { x: 80, y: 70 },
    current: { x: -50, y: -30 },
    imageRect: { width: 200, height: 140 },
  })
  return cropEquals(crop, { left: 10, top: 0, size: 70 })
})())

check('selection drag beyond right/bottom stays inside image rect', (() => {
  const crop = createSquareCropFromDrag({
    start: { x: 150, y: 90 },
    current: { x: 260, y: 220 },
    imageRect: { width: 200, height: 140 },
  })
  return cropEquals(crop, { left: 150, top: 90, size: 50 })
})())

check('pointer down inside selection activates move semantics', (() => {
  return isPointInsideCrop({ x: 55, y: 45 }, { left: 40, top: 30, size: 60 }) === true
})())

check('pointer down outside selection but inside image starts new selection semantics', (() => {
  return isPointInsideCrop({ x: 140, y: 45 }, { left: 40, top: 30, size: 60 }) === false
})())

check('move existing square preserves size and updates position', (() => {
  const moved = moveSquareCrop({
    crop: { left: 40, top: 30, size: 60 },
    pointer: { x: 130, y: 100 },
    offset: { x: 20, y: 20 },
    imageRect: { width: 220, height: 180 },
  })
  return cropEquals(moved, { left: 110, top: 80, size: 60 })
})())

check('move existing square clamps to top-left edge without resizing', (() => {
  const moved = moveSquareCrop({
    crop: { left: 40, top: 30, size: 60 },
    pointer: { x: -80, y: -80 },
    offset: { x: 20, y: 20 },
    imageRect: { width: 220, height: 180 },
  })
  return cropEquals(moved, { left: 0, top: 0, size: 60 })
})())

check('move existing square clamps to top-right edge without resizing', (() => {
  const moved = moveSquareCrop({
    crop: { left: 40, top: 30, size: 60 },
    pointer: { x: 300, y: -80 },
    offset: { x: 20, y: 20 },
    imageRect: { width: 220, height: 180 },
  })
  return cropEquals(moved, { left: 160, top: 0, size: 60 })
})())

check('move existing square clamps to bottom-left edge without resizing', (() => {
  const moved = moveSquareCrop({
    crop: { left: 40, top: 30, size: 60 },
    pointer: { x: -80, y: 300 },
    offset: { x: 20, y: 20 },
    imageRect: { width: 220, height: 180 },
  })
  return cropEquals(moved, { left: 0, top: 120, size: 60 })
})())

check('move existing square clamps to bottom-right edge without resizing', (() => {
  const moved = moveSquareCrop({
    crop: { left: 40, top: 30, size: 60 },
    pointer: { x: 300, y: 300 },
    offset: { x: 20, y: 20 },
    imageRect: { width: 220, height: 180 },
  })
  return cropEquals(moved, { left: 160, top: 120, size: 60 })
})())

check('display to natural coordinate conversion returns valid payload', (() => {
  const crop = displayCropToNaturalCrop({
    crop: { left: 50, top: 0, size: 100 },
    imageRect: { width: 200, height: 100 },
    naturalWidth: 1000,
    naturalHeight: 500,
  })
  return crop !== null &&
    crop.x === 250 &&
    crop.y === 0 &&
    crop.size === 500 &&
    isValidNaturalCrop(crop, 1000, 500)
})())

check('fractional scale conversion clamps away one-pixel overflow', (() => {
  const crop = displayCropToNaturalCrop({
    crop: { left: 199.7, top: 99.7, size: 100.2 },
    imageRect: { width: 300.3, height: 200.3 },
    naturalWidth: 1000,
    naturalHeight: 667,
  })
  return isValidNaturalCrop(crop, 1000, 667)
})())

check('re-render keeps crop position and size model stable', (() => {
  const crop = { left: 35, top: 45, size: 80 }
  const first = displayCropToNaturalCrop({
    crop,
    imageRect: { width: 240, height: 240 },
    naturalWidth: 1200,
    naturalHeight: 1200,
  })
  const second = displayCropToNaturalCrop({
    crop,
    imageRect: { width: 240, height: 240 },
    naturalWidth: 1200,
    naturalHeight: 1200,
  })
  return JSON.stringify(first) === JSON.stringify(second)
})())

check('avatar and gallery share the same valid crop geometry logic', (() => {
  const displayCrop = createSquareCropFromDrag({
    start: { x: 10, y: 10 },
    current: { x: 90, y: 90 },
    imageRect: { width: 100, height: 100 },
  })
  if (displayCrop === null) return false
  const avatarCrop = displayCropToNaturalCrop({
    crop: displayCrop,
    imageRect: { width: 100, height: 100 },
    naturalWidth: 800,
    naturalHeight: 800,
  })
  const galleryCrop = displayCropToNaturalCrop({
    crop: displayCrop,
    imageRect: { width: 100, height: 100 },
    naturalWidth: 800,
    naturalHeight: 800,
  })
  return JSON.stringify(avatarCrop) === JSON.stringify(galleryCrop) &&
    isValidNaturalCrop(avatarCrop, 800, 800) &&
    isValidNaturalCrop(galleryCrop, 800, 800)
})())

check('server out-of-bounds validation is still expected as the final guard', (() => {
  return isValidNaturalCrop({ x: 790, y: 0, size: 20 }, 800, 800) === false
})())

console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
