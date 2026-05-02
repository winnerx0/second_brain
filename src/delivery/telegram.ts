import { config } from '../config.ts';

const TELEGRAM_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
const MAX_LENGTH = 4096;

async function sendMessage(text: string): Promise<void> {
  let res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });

  // Telegram v1 Markdown is strict — retry as plain text on parse errors
  if (res.status === 400) {
    res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text,
      }),
    });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const paragraph of text.split('\n\n')) {
    if (paragraph.length > MAX_LENGTH) {
      if (current) chunks.push(current.trim());
      current = '';
      for (const line of paragraph.split('\n')) {
        if ((current + '\n' + line).length > MAX_LENGTH) {
          if (current) chunks.push(current.trim());
          current = line;
        } else {
          current = current ? current + '\n' + line : line;
        }
      }
    } else if ((current + '\n\n' + paragraph).length > MAX_LENGTH) {
      if (current) chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current ? current + '\n\n' + paragraph : paragraph;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks;
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await sendMessage(chunk);
  }
}
