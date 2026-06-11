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

export type GuestContactStore = {
  createGuestContactMessage(input: CreateGuestContactMessageInput): GuestContactMessageSnapshot;
  markGuestContactEmailSent(messageId: string): void;
  markGuestContactEmailFailed(messageId: string, error: string): void;
};

function normalizeEmailError(error: string): string {
  const trimmed = error.trim();
  if (!trimmed) {
    return 'Unknown error';
  }

  return trimmed.slice(0, 500);
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
  };
}
