import { tool } from 'langchain';
import { z } from 'zod';
import { google } from 'googleapis';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getDbRefreshToken, getValidToken } from '../oauth.js';

type GoogleAuthCredential =
  | { accessToken: string }
  | { refreshToken: string };

async function getGoogleCredential(): Promise<GoogleAuthCredential> {
  // Only use the google_docs token — never fall back to gmail's token.
  // Gmail's token only carries gmail.modify scope and will be rejected by
  // the Docs and Drive APIs with "caller does not have permission".
  const dbAccessToken = await getValidToken('google_docs');
  if (dbAccessToken) {
    return { accessToken: dbAccessToken };
  }

  const refreshToken =
    (await getDbRefreshToken('google_docs')) ??
    process.env.GOOGLE_DOCS_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error(
      'Google Docs not connected. Go to Connections → Google Docs and reconnect to grant the required scopes.',
    );
  }

  return { refreshToken };
}

function createGoogleAuth() {
  const auth = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000',
  );
  return auth;
}

async function getDriveClient() {
  const auth = createGoogleAuth();
  const credential = await getGoogleCredential();
  auth.setCredentials(
    'accessToken' in credential
      ? { access_token: credential.accessToken }
      : { refresh_token: credential.refreshToken },
  );
  return google.drive({ version: 'v3', auth });
}

async function getDocsClient() {
  const auth = createGoogleAuth();
  const credential = await getGoogleCredential();
  auth.setCredentials(
    'accessToken' in credential
      ? { access_token: credential.accessToken }
      : { refresh_token: credential.refreshToken },
  );
  return google.docs({ version: 'v1', auth });
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* ─── Read ────────────────────────────────────────────────────────────────── */

export const readDocument = tool(
  async ({ documentId }) => {
    try {
      const docs = await getDocsClient();
      const res = await docs.documents.get({ documentId });
      const doc = res.data;

      // Extract plain text from the document body
      const text = (doc.body?.content ?? [])
        .flatMap((el) => el.paragraph?.elements ?? [])
        .map((el) => el.textRun?.content ?? '')
        .join('');

      return JSON.stringify({
        documentId: doc.documentId,
        title: doc.title,
        text: text.trim(),
      });
    } catch (error) {
      logger.error('[google-docs] readDocument', error);
      return `Error reading document: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'readDocument',
    description: 'Read the full text content of a Google Doc.',
    schema: z.object({
      documentId: z.string().describe('Google Docs document ID (from the URL)'),
    }),
  },
);

export const searchDocuments = tool(
  async ({ query, limit }) => {
    try {
      const drive = await getDriveClient();
      const escapedQuery = escapeDriveQueryValue(query.trim());
      const q = [
        "mimeType='application/vnd.google-apps.document'",
        'trashed=false',
        `(${[
          `name contains '${escapedQuery}'`,
          `fullText contains '${escapedQuery}'`,
        ].join(' or ')})`,
      ].join(' and ');

      const res = await drive.files.list({
        q,
        pageSize: Math.min(Math.max(limit ?? 10, 1), 25),
        fields: 'files(id, name, webViewLink, modifiedTime, owners(displayName))',
        orderBy: 'modifiedTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = res.data.files ?? [];
      return JSON.stringify(
        files.map((file) => ({
          documentId: file.id,
          title: file.name,
          url: file.webViewLink,
          modifiedTime: file.modifiedTime,
          owner: file.owners?.[0]?.displayName,
        })),
      );
    } catch (error) {
      logger.error('[google-docs] searchDocuments', error);
      return `Error searching documents: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'searchDocuments',
    description:
      'Search Google Docs by title or document content and return matching document links.',
    schema: z.object({
      query: z.string().describe('Search text for the document title or body'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe('Maximum number of matches to return'),
    }),
  },
);

/* ─── Write helpers ───────────────────────────────────────────────────────── */

async function batchUpdate(documentId: string, requests: any[]) {
  const docs = await getDocsClient();
  const res = await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests },
  });
  return res.data;
}

export const appendText = tool(
  async ({ documentId, text }) => {
    try {
      // Insert at end — index 1 is the very beginning; we need the doc length
      const docs = await getDocsClient();
      const doc = await docs.documents.get({ documentId });
      const endIndex = doc.data.body?.content?.slice(-1)[0]?.endIndex ?? 1;
      // Insert before the final newline
      const insertIndex = Math.max(1, endIndex - 1);

      await batchUpdate(documentId, [
        {
          insertText: {
            location: {
              index: insertIndex,
            },
            text: `\n${text}`,
          },
        },
      ]);
      return `Text appended to document ${documentId}.`;
    } catch (error) {
      logger.error('[google-docs] appendText', error);
      return `Error appending text: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'appendText',
    description: 'Append text to the end of a Google Doc.',
    schema: z.object({
      documentId: z.string().describe('Google Docs document ID'),
      text: z.string().describe('Text to append'),
    }),
  },
);

export const insertText = tool(
  async ({ documentId, text, index }) => {
    try {
      await batchUpdate(documentId, [
        { insertText: { location: { index }, text } },
      ]);
      return `Text inserted at index ${index} in document ${documentId}.`;
    } catch (error) {
      logger.error('[google-docs] insertText', error);
      return `Error inserting text: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'insertText',
    description: 'Insert text at a specific character index in a Google Doc.',
    schema: z.object({
      documentId: z.string().describe('Google Docs document ID'),
      text: z.string().describe('Text to insert'),
      index: z.number().describe('Character index to insert at (1-based)'),
    }),
  },
);

export const findAndReplace = tool(
  async ({ documentId, find, replaceWith }) => {
    try {
      await batchUpdate(documentId, [
        {
          replaceAllText: {
            containsText: {
              text: find,
              matchCase: true,
            },
            replaceText: replaceWith,
          },
        },
      ]);
      return `Replaced all occurrences of "${find}" with "${replaceWith}" in document ${documentId}.`;
    } catch (error) {
      logger.error('[google-docs] findAndReplace', error);
      return `Error replacing text: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'findAndReplace',
    description:
      'Find and replace all occurrences of a string in a Google Doc.',
    schema: z.object({
      documentId: z.string().describe('Google Docs document ID'),
      find: z.string().describe('Text to find'),
      replaceWith: z.string().describe('Replacement text'),
    }),
  },
);

export const deleteRange = tool(
  async ({ documentId, startIndex, endIndex }) => {
    try {
      await batchUpdate(documentId, [
        {
          deleteContentRange: {
            range: { startIndex, endIndex },
          },
        },
      ]);
      return `Deleted content from index ${startIndex} to ${endIndex} in document ${documentId}.`;
    } catch (error) {
      logger.error('[google-docs] deleteRange', error);
      return `Error deleting range: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'deleteRange',
    description:
      'Delete a range of content in a Google Doc by character indices.',
    schema: z.object({
      documentId: z.string().describe('Google Docs document ID'),
      startIndex: z.number().describe('Start index (inclusive)'),
      endIndex: z.number().describe('End index (exclusive)'),
    }),
  },
);

export const appendMarkdown = tool(
  async ({ documentId, markdown }) => {
    // Convert basic markdown to plain text for insertion
    const plain = markdown
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1');

    try {
      const docs = await getDocsClient();
      const doc = await docs.documents.get({ documentId });
      const endIndex = doc.data.body?.content?.slice(-1)[0]?.endIndex ?? 1;
      const insertIndex = Math.max(1, endIndex - 1);

      await batchUpdate(documentId, [
        {
          insertText: {
            location: {
              index: insertIndex,
            },
            text: `\n${plain}`,
          },
        },
      ]);
      return `Markdown appended to document ${documentId}.`;
    } catch (error) {
      logger.error('[google-docs] appendMarkdown', error);
      return `Error appending markdown: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'appendMarkdown',
    description:
      'Append markdown-formatted text to the end of a Google Doc (converted to plain text).',
    schema: z.object({
      documentId: z.string().describe('Google Docs document ID'),
      markdown: z.string().describe('Markdown text to append'),
    }),
  },
);

export const createDocument = tool(
  async ({ title, content }) => {
    try {
      const docs = await getDocsClient();
      const created = await docs.documents.create({
        requestBody: { title },
      });
      const documentId = created.data.documentId!;

      if (content && content.length > 0) {
        await batchUpdate(documentId, [
          { insertText: { location: { index: 1 }, text: content } },
        ]);
      }

      return JSON.stringify({
        documentId,
        title: created.data.title,
        url: `https://docs.google.com/document/d/${documentId}/edit`,
      });
    } catch (error) {
      logger.error('[google-docs] createDocument', error);
      return `Error creating document: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'createDocument',
    description:
      'Create a new Google Doc with the given title and optional initial content.',
    schema: z.object({
      title: z.string().describe('Title of the new document'),
      content: z
        .string()
        .optional()
        .describe('Optional initial text content for the document'),
    }),
  },
);

export const trashDocument = tool(
  async ({ documentId }) => {
    try {
      const drive = await getDriveClient();
      await drive.files.update({
        fileId: documentId,
        requestBody: { trashed: true },
      });
      return `Document ${documentId} moved to trash.`;
    } catch (error) {
      logger.error('[google-docs] trashDocument', error);
      return `Error trashing document: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'trashDocument',
    description:
      'Move a Google Doc to the trash (equivalent to deleting it). The file can be restored from Trash within 30 days.',
    schema: z.object({
      documentId: z.string().describe('Google Docs document ID (from the URL)'),
    }),
  },
);

export const googleDocTools = [
  searchDocuments,
  readDocument,
  createDocument,
  appendText,
  insertText,
  findAndReplace,
  deleteRange,
  appendMarkdown,
  trashDocument,
];
