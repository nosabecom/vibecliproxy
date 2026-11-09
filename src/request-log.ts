const MAX_PREVIEW = 600;
const MAX_INSPECTED_TEXT = 12_000;

export function redactLogText(text: string, limit = MAX_PREVIEW): string {
  return text.slice(0, MAX_INSPECTED_TEXT)
    .replace(/\bBearer\s+[A-Za-z0-9_.~+\/=\-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:vcp_|sk-)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .trim().slice(0, limit);
}

function visibleText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, MAX_INSPECTED_TEXT);
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if ((block?.type === 'input_text' || block?.type === 'text') && typeof block.text === 'string') {
      text += `${text ? '\n' : ''}${block.text.slice(0, MAX_INSPECTED_TEXT - text.length)}`;
      if (text.length >= MAX_INSPECTED_TEXT) break;
    }
  }
  return text;
}

export function promptPreview(body: Record<string, any>): string {
  if (typeof body.input === 'string') return redactLogText(body.input);
  const messages = Array.isArray(body.input) ? body.input : body.messages;
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'user') return redactLogText(visibleText(message.content));
  }
  return '';
}
