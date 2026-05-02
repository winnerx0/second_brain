type AgentResponse = {
  messages?: Array<{
    content?: unknown;
    text?: unknown;
  }>;
};

const CONFIRMATION_RE =
  /\b(confirm(?:ed)?|yes|yep|go ahead|do it|send it|delete it|trash it|proceed)\b/i;

export function getFinalText(response: AgentResponse): string {
  const finalMessage = response.messages?.[response.messages.length - 1];
  if (!finalMessage) return '';

  const { content } = finalMessage;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text);
        }
        return '';
      })
      .join('');
  }

  if (typeof finalMessage.text === 'string') return finalMessage.text;
  return content == null ? '' : String(content);
}

export function requireConfirmation(
  query: string,
  riskPattern: RegExp,
  actionSummary: string,
): string | null {
  if (!riskPattern.test(query)) return null;
  if (CONFIRMATION_RE.test(query)) return null;

  return [
    `I need confirmation before I ${actionSummary}.`,
    'Reply with a clear confirmation and include the target/action again.',
  ].join(' ');
}
