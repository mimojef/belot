import { randomUUID } from 'node:crypto';

import type { GuestContactMessage } from '../contact/guestContactValidation.js';

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>;

export type GuestContactEmailDeliveryStatus = 'pending' | 'sent' | 'failed';

export type CreateGuestContactMessageInput = GuestContactMessage & {
  ipAddress: string | null;
  userAgent: string | null;
};

export type GuestContactMessageSnapshot = {
  messageId: string;
  name: string;
  email: string;
  subject: string;
  body: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  readByAdmin: boolean;
  readAt: string | null;
  archivedAt: string | null;
  emailDeliveryStatus: GuestContactEmailDeliveryStatus;
  emailSentAt: string | null;
  emailError: string | null;
};

export type GuestContactMessageListItem = {
  messageId: string;
  name: string;
  email: string;
  subject: string;
  createdAt: string;
  readByAdmin: boolean;
  emailDeliveryStatus: GuestContactEmailDeliveryStatus;
  preview: string;
};

export type GuestContactStore = {
  createGuestContactMessage(input: CreateGuestContactMessageInput): GuestContactMessageSnapshot;
  markGuestContactEmailSent(messageId: string): void;
  markGuestContactEmailFailed(messageId: string, error: string): void;
  getUnreadCount(): number;
  listMessages(): GuestContactMessageListItem[];
  getMessageById(messageId: string): GuestContactMessageSnapshot | null;
  markMessageRead(messageId: string): GuestContactMessageSnapshot | null;
};

type GuestContactMessageRow = {
  message_id: string;
  name: string;
  email: string;
  subject: string;
  body: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  read_by_admin: number;
  read_at: string | null;
  archived_at: string | null;
  email_delivery_status: GuestContactEmailDeliveryStatus;
  email_sent_at: string | null;
  email_error: string | null;
};

function normalizeEmailError(error: string): string {
  const trimmed = error.trim();
  if (!trimmed) {
    return 'Unknown error';
  }

  return trimmed.slice(0, 500);
}

function createPreview(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function toMessageSnapshot(row: GuestContactMessageRow): GuestContactMessageSnapshot {
  return {
    messageId: row.message_id,
    name: row.name,
    email: row.email,
    subject: row.subject,
    body: row.body,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    readByAdmin: row.read_by_admin === 1,
    readAt: row.read_at,
    archivedAt: row.archived_at,
    emailDeliveryStatus: row.email_delivery_status,
    emailSentAt: row.email_sent_at,
    emailError: row.email_error,
  };
}

function toListItem(row: GuestContactMessageRow): GuestContactMessageListItem {
  return {
    messageId: row.message_id,
    name: row.name,
    email: row.email,
    subject: row.subject,
    createdAt: row.created_at,
    readByAdmin: row.read_by_admin === 1,
    emailDeliveryStatus: row.email_delivery_status,
    preview: createPreview(row.body),
  };
}

export async function createGuestContactStore(databaseFilePath: string): Promise<GuestContactStore> {
  const sqliteModule = await import('node:sqlite');
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath);
  db.exec('PRAGMA journal_mode = WAL;');

  const insertMessage = db.prepare(`
    INSERT INTO guest_contact_messages (
      message_id,
      name,
      email,
      subject,
      body,
      ip_address,
      user_agent,
      created_at,
      read_by_admin,
      read_at,
      archived_at,
      email_delivery_status,
      email_sent_at,
      email_error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 'pending', NULL, NULL)
  `);

  const markEmailSent = db.prepare(`
    UPDATE guest_contact_messages
    SET email_delivery_status = 'sent',
        email_sent_at = ?,
        email_error = NULL
    WHERE message_id = ?
  `);

  const markEmailFailed = db.prepare(`
    UPDATE guest_contact_messages
    SET email_delivery_status = 'failed',
        email_error = ?
    WHERE message_id = ?
  `);

  const countUnreadMessages = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM guest_contact_messages
    WHERE read_by_admin = 0
      AND archived_at IS NULL
  `);

  const selectMessages = db.prepare(`
    SELECT
      message_id,
      name,
      email,
      subject,
      body,
      ip_address,
      user_agent,
      created_at,
      read_by_admin,
      read_at,
      archived_at,
      email_delivery_status,
      email_sent_at,
      email_error
    FROM guest_contact_messages
    WHERE archived_at IS NULL
    ORDER BY created_at DESC
  `);

  const selectMessageById = db.prepare(`
    SELECT
      message_id,
      name,
      email,
      subject,
      body,
      ip_address,
      user_agent,
      created_at,
      read_by_admin,
      read_at,
      archived_at,
      email_delivery_status,
      email_sent_at,
      email_error
    FROM guest_contact_messages
    WHERE message_id = ?
      AND archived_at IS NULL
  `);

  const markRead = db.prepare(`
    UPDATE guest_contact_messages
    SET read_by_admin = 1,
        read_at = COALESCE(read_at, ?)
    WHERE message_id = ?
      AND archived_at IS NULL
  `);

  return {
    createGuestContactMessage(input) {
      const now = new Date().toISOString();
      const messageId = randomUUID();

      insertMessage.run(
        messageId,
        input.name,
        input.email,
        input.subject,
        input.message,
        input.ipAddress,
        input.userAgent,
        now,
      );

      return {
        messageId,
        name: input.name,
        email: input.email,
        subject: input.subject,
        body: input.message,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        createdAt: now,
        readByAdmin: false,
        readAt: null,
        archivedAt: null,
        emailDeliveryStatus: 'pending',
        emailSentAt: null,
        emailError: null,
      };
    },
    markGuestContactEmailSent(messageId) {
      markEmailSent.run(new Date().toISOString(), messageId);
    },
    markGuestContactEmailFailed(messageId, error) {
      markEmailFailed.run(normalizeEmailError(error), messageId);
    },
    getUnreadCount() {
      const row = countUnreadMessages.get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    },
    listMessages() {
      const rows = selectMessages.all() as GuestContactMessageRow[];
      return rows.map(toListItem);
    },
    getMessageById(messageId) {
      const row = selectMessageById.get(messageId) as GuestContactMessageRow | undefined;
      return row ? toMessageSnapshot(row) : null;
    },
    markMessageRead(messageId) {
      const message = selectMessageById.get(messageId) as GuestContactMessageRow | undefined;
      if (!message) {
        return null;
      }

      markRead.run(new Date().toISOString(), messageId);
      const updated = selectMessageById.get(messageId) as GuestContactMessageRow | undefined;
      return updated ? toMessageSnapshot(updated) : null;
    },
  };
}
