import { tool } from 'langchain';
import { z } from 'zod';
import { google } from 'googleapis';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { getDbRefreshToken } from '../oauth.ts';

async function getGmailClient() {
  const dbRefreshToken = await getDbRefreshToken('gmail');
  const refreshToken = dbRefreshToken ?? config.GMAIL_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      'Gmail not configured: connect Gmail in Connections or set GMAIL_REFRESH_TOKEN.',
    );
  }
  const auth = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000',
  );
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth });
}

function getHeader(
  headers: { name?: string | null; value?: string | null }[],
  name: string,
): string {
  return (
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    ''
  );
}

function decodeBody(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: Array<{
    mimeType?: string | null;
    body?: { data?: string | null } | null;
  }> | null;
}): string {
  const tryDecode = (data: string) =>
    Buffer.from(data, 'base64').toString('utf-8');
  if (payload.body?.data) return tryDecode(payload.body.data);
  for (const part of payload.parts ?? []) {
    if (part.mimeType === 'text/plain' && part.body?.data)
      return tryDecode(part.body.data);
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === 'text/html' && part.body?.data)
      return tryDecode(part.body.data);
  }
  return '(no body)';
}

function buildRaw(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  replyHeaders?: { messageId: string; references: string },
): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
  ];
  if (cc) lines.push(`Cc: ${cc}`);
  if (replyHeaders) {
    lines.push(`In-Reply-To: ${replyHeaders.messageId}`);
    lines.push(`References: ${replyHeaders.references}`);
  }
  lines.push('', body);
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}


export const listEmails = tool(
  async ({ query, maxResults }) => {
    try {
      const gmail = await getGmailClient();
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: maxResults ?? 10,
      });
      const messages = listRes.data.messages ?? [];
      if (messages.length === 0) return 'No messages found.';
      const details = await Promise.all(
        messages.map((m) =>
          gmail.users.messages.get({
            userId: 'me',
            id: m.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          }),
        ),
      );
      return JSON.stringify(
        details.map((d) => {
          const hdrs = d.data.payload?.headers ?? [];
          return {
            id: d.data.id,
            from: getHeader(hdrs, 'from'),
            subject: getHeader(hdrs, 'subject'),
            date: getHeader(hdrs, 'date'),
            snippet: d.data.snippet ?? '',
          };
        }),
      );
    } catch (error) {
      logger.error('[gmail] listEmails', error);
      return `Error listing emails: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'list_emails',
    description:
      "List or search emails in Gmail. Supports Gmail search syntax (e.g. 'is:unread from:alice@example.com label:inbox').",
    schema: z.object({
      query: z
        .string()
        .optional()
        .describe('Gmail search query. Omit to list recent inbox messages.'),
      maxResults: z
        .number()
        .optional()
        .describe('Max number of results (default 10).'),
    }),
  },
);

export const getEmail = tool(
  async ({ messageId }) => {
    try {
      const gmail = await getGmailClient();
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const payload = res.data.payload;
      const hdrs = payload?.headers ?? [];
      const body = payload
        ? decodeBody(payload as Parameters<typeof decodeBody>[0])
        : '(no body)';
      return JSON.stringify({
        id: res.data.id,
        threadId: res.data.threadId,
        from: getHeader(hdrs, 'from'),
        to: getHeader(hdrs, 'to'),
        subject: getHeader(hdrs, 'subject'),
        date: getHeader(hdrs, 'date'),
        messageId: getHeader(hdrs, 'message-id'),
        body,
      });
    } catch (error) {
      logger.error('[gmail] getEmail', error);
      return `Error fetching email: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_email',
    description: 'Fetch the full content of an email by its message ID.',
    schema: z.object({
      messageId: z.string().describe('Gmail message ID (from list_emails).'),
    }),
  },
);

export const sendEmail = tool(
  async ({ to, subject, body, cc }) => {
    try {
      const gmail = await getGmailClient();
      const raw = buildRaw(to, subject, body, cc);
      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });
      return `Email sent. Message ID: ${res.data.id}`;
    } catch (error) {
      logger.error('[gmail] sendEmail', error);
      return `Error sending email: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'send_email',
    description: 'Compose and send a new email.',
    schema: z.object({
      to: z.string().describe('Recipient email address.'),
      subject: z.string().describe('Email subject.'),
      body: z.string().describe('Plain text email body.'),
      cc: z.string().optional().describe('CC email address.'),
    }),
  },
);

export const replyToEmail = tool(
  async ({ messageId, body }) => {
    try {
      const gmail = await getGmailClient();
      const original = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const hdrs = original.data.payload?.headers ?? [];
      const to = getHeader(hdrs, 'from');
      const subject = `Re: ${getHeader(hdrs, 'subject').replace(/^Re:\s*/i, '')}`;
      const origMessageId = getHeader(hdrs, 'message-id');
      const references = [getHeader(hdrs, 'references'), origMessageId]
        .filter(Boolean)
        .join(' ');
      const raw = buildRaw(to, subject, body, undefined, {
        messageId: origMessageId,
        references,
      });
      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw,
          threadId: original.data.threadId!,
        },
      });
      return `Reply sent. Message ID: ${res.data.id}`;
    } catch (error) {
      logger.error('[gmail] replyToEmail', error);
      return `Error replying: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'reply_to_email',
    description: 'Reply to an existing email thread.',
    schema: z.object({
      messageId: z
        .string()
        .describe('Gmail message ID of the email to reply to.'),
      body: z.string().describe('Reply body text.'),
    }),
  },
);

export const archiveEmail = tool(
  async ({ messageId }) => {
    try {
      const gmail = await getGmailClient();
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['INBOX'] },
      });
      return `Email ${messageId} archived.`;
    } catch (error) {
      logger.error('[gmail] archiveEmail', error);
      return `Error archiving: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'archive_email',
    description: 'Archive an email (remove from inbox without deleting).',
    schema: z.object({
      messageId: z.string().describe('Gmail message ID to archive.'),
    }),
  },
);

export const markEmailRead = tool(
  async ({ messageId }) => {
    try {
      const gmail = await getGmailClient();
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
      return `Email ${messageId} marked as read.`;
    } catch (error) {
      logger.error('[gmail] markEmailRead', error);
      return `Error marking as read: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'mark_email_read',
    description: 'Mark an email as read.',
    schema: z.object({
      messageId: z.string().describe('Gmail message ID to mark as read.'),
    }),
  },
);

export const trashEmail = tool(
  async ({ messageId }) => {
    try {
      const gmail = await getGmailClient();
      await gmail.users.messages.trash({
        userId: 'me',
        id: messageId,
      });
      return `Email ${messageId} moved to trash.`;
    } catch (error) {
      logger.error('[gmail] trashEmail', error);
      return `Error trashing email: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'trash_email',
    description: 'Move an email to trash.',
    schema: z.object({
      messageId: z.string().describe('Gmail message ID to trash.'),
    }),
  },
);

export const listLabels = tool(
  async () => {
    try {
      const gmail = await getGmailClient();
      const res = await gmail.users.labels.list({
        userId: 'me',
      });
      const labels = (res.data.labels ?? []).map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
      }));
      return JSON.stringify(labels);
    } catch (error) {
      logger.error('[gmail] listLabels', error);
      return `Error listing labels: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'list_gmail_labels',
    description: 'List all Gmail labels (inbox, sent, custom labels, etc).',
    schema: z.object({}),
  },
);

export const applyLabel = tool(
  async ({ messageId, addLabelIds, removeLabelIds }) => {
    try {
      const gmail = await getGmailClient();
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          ...(addLabelIds?.length ? { addLabelIds } : {}),
          ...(removeLabelIds?.length ? { removeLabelIds } : {}),
        },
      });
      return `Labels updated on message ${messageId}.`;
    } catch (error) {
      logger.error('[gmail] applyLabel', error);
      return `Error updating labels: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'apply_gmail_label',
    description:
      'Add or remove labels on an email. Use list_gmail_labels to get label IDs.',
    schema: z.object({
      messageId: z.string().describe('Gmail message ID.'),
      addLabelIds: z.array(z.string()).optional().describe('Label IDs to add.'),
      removeLabelIds: z
        .array(z.string())
        .optional()
        .describe('Label IDs to remove.'),
    }),
  },
);

export const getThreadEmails = tool(
  async ({ threadId }) => {
    try {
      const gmail = await getGmailClient();
      const res = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
      });
      const messages = (res.data.messages ?? []).map((m) => {
        const hdrs = m.payload?.headers ?? [];
        return {
          id: m.id,
          from: getHeader(hdrs, 'from'),
          subject: getHeader(hdrs, 'subject'),
          date: getHeader(hdrs, 'date'),
          snippet: m.snippet,
        };
      });
      return JSON.stringify({
        threadId,
        messageCount: messages.length,
        messages,
      });
    } catch (error) {
      logger.error('[gmail] getThreadEmails', error);
      return `Error fetching thread: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_email_thread',
    description: 'Fetch all messages in an email thread.',
    schema: z.object({
      threadId: z
        .string()
        .describe("Gmail thread ID (from get_email's threadId field)."),
    }),
  },
);
