import { createAgent, tool } from "langchain";
import z from "zod";
import { model } from "../shared";
import {
  listEmails, getEmail, sendEmail, replyToEmail,
  archiveEmail, markEmailRead, trashEmail,
  listLabels, applyLabel, getThreadEmails,
} from "../tools/gmail";
import { getCurrentDateTime } from "../tools/miscellaneous";

const GMAIL_SYSTEM_PROMPT = `You are an Email Assistant with access to the user's Gmail inbox.

You can:
- List and search emails using Gmail search syntax (from:, to:, is:unread, subject:, etc.)
- Read full email content
- Send new emails and reply to existing threads
- Archive emails and mark them as read

When helping:
- Always use list_emails first to find messages before reading or acting on them
- For send/reply, confirm the recipient and subject before sending
- When archiving or marking read, confirm you have the correct message ID from list_emails
- Summarize emails concisely — subject, sender, date, and key points only
- Never fabricate email content; always read with get_email first`;

const gmailAgent = createAgent({
  model,
  tools: [
    listEmails, getEmail, sendEmail, replyToEmail,
    archiveEmail, markEmailRead, trashEmail,
    listLabels, applyLabel, getThreadEmails,
    getCurrentDateTime,
  ],
});

export const gmailTool = tool(
  async ({ query }) => {
    const response = await gmailAgent.invoke({
      messages: [
        { role: "system", content: GMAIL_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
  },
  {
    name: "gmail",
    description: "Read, search, send, reply, archive, and manage Gmail emails.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for Gmail operations (e.g., 'Show unread emails from Alice', 'Send an email to bob@example.com about the Q2 report', 'Reply to the last email from Carol saying I'll be there')",
        ),
    }),
  },
);
