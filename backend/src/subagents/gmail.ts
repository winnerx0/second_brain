import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import { gmailTools } from '../tools/gmail.js';
import { streamSubAgent } from './utils.js';
import { workflowPolicy } from '../workflows/policy.js';

const GMAIL_SYSTEM_PROMPT = `You are an Email Assistant with access to the user's Gmail inbox.

You can:
- List and search emails using Gmail search syntax (from:, to:, is:unread, subject:, etc.)
- Read full email content
- Send new emails and reply to existing threads
- Archive emails and mark them as read

When helping:
- Always use list_emails first to find messages before reading or acting on them
- For send/reply/trash, draft or identify the target first and ask for confirmation before sending or trashing
- When archiving or marking read, find the correct message ID from list_emails then act
- Summarize emails concisely — subject, sender, date, and key points only
- Never fabricate email content; always read with get_email first
- If a tool returns an Error/Failed result, report that failure instead of treating it as success`;

const gmailAgent = createAgent({
  model,
  middleware: [workflowPolicy],
  tools: [...gmailTools],
});

export const gmailTool = tool(
  async ({ query }) => {
    return streamSubAgent(
      gmailAgent,
      [
        { role: 'system', content: GMAIL_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      'gmail',
    );
  },
  {
    name: 'gmail',
    description: 'Read, search, send, reply, archive, and manage Gmail emails.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for Gmail operations (e.g., 'Show my unread emails', 'Send an email to alice@example.com about the meeting', 'Archive the email from Bob')",
        ),
    }),
  },
);
