import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared';
import { gmailTools } from '../tools/gmail';
import { getCurrentDateTime } from '../tools/miscellaneous';

const GMAIL_SYSTEM_PROMPT = `You are an Email Assistant with access to the user's Gmail inbox.

You can:
- List and search emails using Gmail search syntax (from:, to:, is:unread, subject:, etc.)
- Read full email content
- Send new emails and reply to existing threads
- Archive emails and mark them as read

When helping:
- Always use list_emails first to find messages before reading or acting on them
- For send/reply, execute immediately — do not ask for confirmation
- When archiving or marking read, find the correct message ID from list_emails then act
- Summarize emails concisely — subject, sender, date, and key points only
- Never fabricate email content; always read with get_email first`;

const gmailAgent = createAgent({
  model,
  tools: [...gmailTools, getCurrentDateTime],
});

export const gmailTool = tool(
  async ({ query }) => {
    const response = await gmailAgent.invoke({
      messages: [
        { role: 'system', content: GMAIL_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
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
