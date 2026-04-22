import { tool } from 'langchain';
import { z } from 'zod';
import { google } from 'googleapis';
import { config } from '../config.ts';
import { logger } from '../logger.ts';

function getDocsClient() {
  const auth = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000',
  );
  // Reuse the same refresh token flow already used by Gmail
  const refreshToken =
    process.env.GOOGLE_DOCS_REFRESH_TOKEN ?? config.GMAIL_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      'Google Docs not configured: GOOGLE_DOCS_REFRESH_TOKEN (or GMAIL_REFRESH_TOKEN) is missing.',
    );
  }
  auth.setCredentials({ refresh_token: refreshToken });
  return google.docs({ version: 'v1', auth });
}

/* ─── Read ────────────────────────────────────────────────────────────────── */

export const readDocument = tool(
  async ({ documentId }) => {
    try {
      const docs = getDocsClient();
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

/* ─── Write helpers ───────────────────────────────────────────────────────── */

async function batchUpdate(documentId: string, requests: unknown[]) {
  const docs = getDocsClient();
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
      const docs = getDocsClient();
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
      const docs = getDocsClient();
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

export const googleDocTools = [
  readDocument,
  appendText,
  insertText,
  findAndReplace,
  deleteRange,
  appendMarkdown,
];
