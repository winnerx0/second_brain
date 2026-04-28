import {
  listEmails,
  getEmail,
  sendEmail,
  replyToEmail,
  archiveEmail,
  markEmailRead,
  trashEmail,
  listLabels,
  applyLabel,
  getThreadEmails,
} from '../tools/gmail';
import { getCurrentDateTime } from '../tools/miscellaneous';
import { register } from './registry';

register({
  name: 'gmail',
  description: 'Read, search, send, reply, archive, and manage Gmail emails.',
  systemPrompt: `You are an Email Assistant with access to the user's Gmail inbox.

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
- Never fabricate email content; always read with get_email first`,
  createTools: () => [
    listEmails,
    getEmail,
    sendEmail,
    replyToEmail,
    archiveEmail,
    markEmailRead,
    trashEmail,
    listLabels,
    applyLabel,
    getThreadEmails,
    getCurrentDateTime,
  ],
});
