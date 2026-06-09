import { tool } from 'langchain';
import { z } from 'zod';
import { sendTelegramMessage } from '../delivery/telegram.js';
import { logger } from '../logger.js';

export const sendTelegramBotMessage = tool(
  async ({ message }) => {
    try {
      await sendTelegramMessage(message);
      return 'Telegram message sent.';
    } catch (error) {
      logger.error('[telegram] sendTelegramBotMessage', error);
      return `Error sending Telegram message: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'send_telegram_message',
    description:
      'Send a message through the configured Telegram bot to the configured Telegram chat. Use only after the user has confirmed the final message text.',
    schema: z.object({
      message: z
        .string()
        .describe('The message text to send through Telegram.'),
    }),
  },
);
