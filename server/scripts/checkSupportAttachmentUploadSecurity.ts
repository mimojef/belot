import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  decodeImageAttachmentDataUrl,
  IMAGE_ATTACHMENT_MAX_SOURCE_DIMENSION_PX,
  processImageAttachmentToWebp,
} from '../src/uploads/imageAttachments.js'
import { createSupportStore } from '../src/db/supportStore.js'
import {
  renderAdminSupportPage,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = resolve(SERVER_ROOT, '..')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function dataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

async function createImage(format: 'jpeg' | 'png' | 'webp', width = 32, height = 24): Promise<Buffer> {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 32, g: 120, b: 220 },
    },
  })

  if (format === 'jpeg') return await pipeline.jpeg().toBuffer()
  if (format === 'png') return await pipeline.png().toBuffer()
  return await pipeline.webp().toBuffer()
}

function prepareSupportSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE support_messages (
      message_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      body TEXT NOT NULL,
      is_from_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_by_user INTEGER NOT NULL DEFAULT 0,
      read_by_admin INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE support_archived (
      profile_id TEXT PRIMARY KEY,
      archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE support_message_attachments (
      message_id TEXT PRIMARY KEY,
      storage_filename TEXT NOT NULL,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      byte_size INTEGER NOT NULL CHECK (byte_size > 0),
      content_type TEXT NOT NULL DEFAULT 'image/webp',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES support_messages(message_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX idx_support_message_attachments_filename
      ON support_message_attachments(storage_filename);

    CREATE TABLE support_message_attachment_deletions (
      event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      storage_filename TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        cleanup_status IN ('pending', 'done', 'failed')
      )
    );
  `)
}

function makeAttachment(filename: string) {
  return {
    storageFilename: filename,
    width: 32,
    height: 24,
    byteSize: 128,
    contentType: 'image/webp',
  }
}

function makeAdminState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    adminSupportConversations: [{
      profileId: 'user-profile',
      displayName: 'Support User',
      avatarUrl: null,
      lastMessageBody: '[Снимка]',
      lastMessageIsFromAdmin: false,
      unreadByAdmin: 1,
      updatedAt: new Date('2026-08-03T10:00:00Z').toISOString(),
    }],
    adminSupportConversationsLoading: false,
    adminSupportSelectedProfileId: 'user-profile',
    adminSupportMessages: [{
      messageId: 'message-1',
      profileId: 'user-profile',
      body: '',
      isFromAdmin: false,
      createdAt: new Date('2026-08-03T10:00:00Z').toISOString(),
      attachment: {
        attachmentId: '11111111-1111-4111-8111-111111111111.webp',
        width: 32,
        height: 24,
        byteSize: 128,
        viewUrl: '/api/support/attachments/11111111-1111-4111-8111-111111111111.webp',
        downloadUrl: '/api/support/attachments/11111111-1111-4111-8111-111111111111.webp?download=1',
      },
    }],
    adminSupportMessagesLoading: false,
    adminSupportReplyLoading: false,
    adminSupportReplyErrorText: null,
    adminSupportReplyDraftByProfileId: {},
    adminSupportPendingImageByProfileId: {},
    adminSupportDeleteConfirmProfileId: null,
    adminSupportDeleteLoading: false,
    adminSupportMobileConversationOpen: true,
    ...overrides,
  } as unknown as LobbyScreenState
}

async function main(): Promise<void> {
  await check('JPEG, PNG and WebP data URLs decode and convert to metadata-stripped WebP <= 1920px', async () => {
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const original = await createImage(format, 2400, 1600)
      const decoded = decodeImageAttachmentDataUrl(dataUrl(format === 'jpeg' ? 'image/jpeg' : `image/${format}`, original))
      assert(decoded !== null, `${format} data URL should decode`)
      const processed = await processImageAttachmentToWebp(decoded, { enforceSourcePixelLimit: true })
      assert(processed !== null, `${format} should process`)
      const metadata = await sharp(processed.buffer).metadata()
      assert(metadata.format === 'webp', `${format} should be stored as WebP`)
      assert((metadata.width ?? 0) <= 1920 && (metadata.height ?? 0) <= 1920, `${format} should be resized inside 1920px`)
      assert(metadata.exif === undefined && metadata.icc === undefined && metadata.xmp === undefined, `${format} should not keep extra metadata`)
    }
  })

  await check('forged MIME, GIF, BMP, TIFF, HEIC/HEIF, corrupt and oversized payloads are rejected', async () => {
    const png = await createImage('png')
    const gifHeader = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex')
    const bmpHeader = Buffer.from('424d4600000000000000360000002800000001000000010000000100180000000000100000000000000000000000000000000000000000', 'hex')
    const tiffHeader = Buffer.from('49492a000800000000000000', 'hex')
    const heicHeader = Buffer.from('00000018667479706865696300000000686569636d696631', 'hex')
    const corrupt = Buffer.from('not-an-image')

    assert(decodeImageAttachmentDataUrl(dataUrl('image/gif', gifHeader)) === null, 'GIF MIME should not decode')
    assert(decodeImageAttachmentDataUrl(dataUrl('image/bmp', bmpHeader)) === null, 'BMP MIME should not decode')
    assert(decodeImageAttachmentDataUrl(dataUrl('image/tiff', tiffHeader)) === null, 'TIFF MIME should not decode')
    assert(decodeImageAttachmentDataUrl(dataUrl('image/heic', heicHeader)) === null, 'HEIC MIME should not decode')
    assert(decodeImageAttachmentDataUrl(dataUrl('image/heif', heicHeader)) === null, 'HEIF MIME should not decode')
    assert(decodeImageAttachmentDataUrl(dataUrl('image/png', Buffer.alloc(10_000_001, 1))) === null, '>10MB payload should not decode')
    assert(await processImageAttachmentToWebp(gifHeader, { enforceSourcePixelLimit: true }) === null, 'forged GIF content should not process')
    assert(await processImageAttachmentToWebp(bmpHeader, { enforceSourcePixelLimit: true }) === null, 'BMP content should not process')
    assert(await processImageAttachmentToWebp(tiffHeader, { enforceSourcePixelLimit: true }) === null, 'TIFF content should not process')
    assert(await processImageAttachmentToWebp(heicHeader, { enforceSourcePixelLimit: true }) === null, 'HEIC/HEIF content should not process')
    assert(await processImageAttachmentToWebp(corrupt, { enforceSourcePixelLimit: true }) === null, 'corrupt content should not process')

    const excessive = await createImage('png', IMAGE_ATTACHMENT_MAX_SOURCE_DIMENSION_PX + 1, 1)
    assert(await processImageAttachmentToWebp(excessive, { enforceSourcePixelLimit: true }) === null, 'excessive dimensions should not process')
    assert(await processImageAttachmentToWebp(png, { enforceSourcePixelLimit: true }) !== null, 'valid PNG control should process')
  })

  await check('support store allows owner/full admin attachment access and denies foreign profile', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'belot-support-attachments-'))
    try {
      const dbPath = join(tempDir, 'support.sqlite')
      const sqliteModule = await import('node:sqlite')
      const db = new sqliteModule.DatabaseSync(dbPath)
      try {
        prepareSupportSchema(db)
      } finally {
        db.close()
      }

      const store = await createSupportStore(dbPath)
      const userImage = makeAttachment('11111111-1111-4111-8111-111111111111.webp')
      const adminImage = makeAttachment('22222222-2222-4222-8222-222222222222.webp')
      const userMessage = store.sendUserMessage('user-profile', '', userImage)
      const adminMessage = store.sendAdminReply('user-profile', 'admin text', adminImage)

      assert(userMessage.attachment?.viewUrl === '/api/support/attachments/11111111-1111-4111-8111-111111111111.webp', 'user attachment view URL should be protected support endpoint')
      assert(adminMessage?.attachment?.downloadUrl.endsWith('?download=1') === true, 'admin attachment should expose download URL')
      assert(store.getAttachmentForDownload('user-profile', false, userImage.storageFilename) !== null, 'owner can download')
      assert(store.getAttachmentForDownload('other-profile', false, userImage.storageFilename) === null, 'foreign user cannot download')
      assert(store.getAttachmentForDownload('admin-profile', true, userImage.storageFilename) !== null, 'full admin can download')
      assert(store.getAllConversations(() => ({ displayName: 'Support User', avatarUrl: null }))[0]?.lastMessageBody === 'admin text', 'text preview should remain text when present')

      store.deleteConversation('user-profile')
      assert(store.getMessages('user-profile').length === 0, 'deleteConversation should delete messages')
      const pending = store.listPendingAttachmentDeletions(10).map((entry) => entry.storageFilename).sort()
      assert(pending.includes(userImage.storageFilename) && pending.includes(adminImage.storageFilename), 'deleteConversation should enqueue removed attachments')
      assert(store.attachmentExistsForFilename(userImage.storageFilename) === false, 'deleted attachment should not remain referenced')
      store.close()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  await check('support UI renders protected image view/download and admin desktop/mobile image controls', () => {
    const desktopHtml = renderAdminSupportPage(makeAdminState({ adminSupportMobileConversationOpen: false }))
    const mobileHtml = renderAdminSupportPage(makeAdminState(), true)

    assert(desktopHtml.includes('/api/support/attachments/11111111-1111-4111-8111-111111111111.webp'), 'desktop should render protected support attachment URL')
    assert(mobileHtml.includes('data-admin-support-image-pick='), 'mobile admin detail should render image picker')
    assert(mobileHtml.includes('data-admin-support-image-input='), 'mobile admin detail should render file input')
    assert(mobileHtml.includes('download'), 'mobile attachment should render download link')
  })

  await check('source keeps guest contact text-only, guest support upload rejected server-side, and support uploads non-public', async () => {
    const serverSource = await readFile(join(SERVER_ROOT, 'src', 'index.ts'), 'utf8')
    const renderSource = await readFile(join(PROJECT_ROOT, 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')

    assert(serverSource.includes("'/api/contact/guest'") && !serverSource.includes('/api/contact/guest/attachments'), 'guest contact endpoint should remain text-only')
    assert(serverSource.includes("pathname === '/api/support/messages' && req.method === 'POST'") && serverSource.includes('session.profile.profileId === null'), 'support upload path should require registered session/profile')
    assert(serverSource.includes('supportAttachmentMatch') && serverSource.includes('supportStore.getAttachmentForDownload'), 'support attachment download should use protected store lookup')
    assert(!serverSource.includes("support-attachments'") || !serverSource.includes('PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS = [SUPPORT_ATTACHMENT_UPLOADS_PATH'), 'support attachment directory should not be public uploads root')
    assert(renderSource.includes('data-support-image-pick="1"'), 'registered support popup should render image picker')
    assert(!renderSource.includes('data-guest-contact-image'), 'guest contact should not render image picker')
  })

  console.log(`\n${passed} passed, ${failed} failed`)

  if (failed > 0) {
    process.exitCode = 1
  }
}

void main()
