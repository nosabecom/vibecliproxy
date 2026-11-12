import { createHash } from 'node:crypto';
import { redactLogText } from './request-log.ts';
import type { TaskEvidence } from './review-types.ts';

// Codex's harness instructions alone can exceed 64 KiB. Keep the full text;
// a small application limit must not reject ordinary desktop requests.
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 10_000;
const continuation = /^(?:please\s+)?(?:go on|carry on|keep going|continue(?:\s+(?:please|with the rest|the task|working))?|proceed|resume(?:\s+(?:the task|it|work))?|finish(?:\s+(?:it|the rest))?|do it|go ahead|yes(?:\s+please)?|ok(?:ay)?|sure|yep|yeah)[.!?\s]*$/i;
const metadata = /^(?:# AGENTS\.md instructions|<environment_context>|<environment_details>|<system-reminder>)/;

function contentText(content: unknown): { text: string; opaque: boolean } {
  if (typeof content === 'string') return { text: content, opaque: false };
  if (!Array.isArray(content)) return { text: '', opaque: content != null };
  const parts: string[] = []; let opaque = false;
  for (const part of content) {
    if ((part?.type === 'text' || part?.type === 'input_text') && typeof part.text === 'string') parts.push(part.text);
    else if (part?.type !== 'tool_result') opaque = true;
    // Tool results are observations, not human instructions. A request with only
    // observations cannot establish an objective and never inherits another task.
  }
  return { text: parts.join('\n'), opaque };
}

export function taskEvidence(body: Record<string, any>): TaskEvidence {
  const instructions: { role: string; text: string }[] = [];
  const users: string[] = [];
  let opaque = false; let issue: string | undefined; let tooManyItems = false;
  if (body.system != null) {
    const system = contentText(body.system);
    opaque ||= system.opaque;
    if (system.text.trim()) instructions.push({ role: 'system', text: system.text });
  }
  if (body.instructions != null && typeof body.instructions !== 'string') opaque = true;
  // These fields can reference instructions the proxy cannot inspect. Visible
  // text must not make an opaque, stored conversation look like a fresh task.
  if (['previous_response_id', 'conversation', 'prompt'].some(key => body[key] != null)) issue = 'Stored or hidden task context requires a request with the complete visible objective';
  if (typeof body.instructions === 'string' && body.instructions.trim()) instructions.push({ role: 'instructions', text: body.instructions });
  if (typeof body.input === 'string') { instructions.push({ role: 'user', text: body.input }); users.push(body.input); }
  // Inspect both fields when supplied: otherwise a Messages caller could hide a
  // prohibited `messages` objective behind an unrelated Responses `input` field.
  for (const messages of [Array.isArray(body.input) ? body.input : undefined, body.messages]) {
    if (Array.isArray(messages)) {
      if (messages.length > MAX_ITEMS) { tooManyItems = true; issue = 'Too many input items to establish task context'; }
      for (const item of messages.slice(0, MAX_ITEMS)) {
        if (item?.type === 'compaction' || item?.type === 'item_reference') { opaque = true; continue; }
        if (!['user', 'system', 'developer'].includes(item?.role)) continue;
        const content = contentText(item.content);
        opaque ||= content.opaque;
        if (content.text.trim()) {
          instructions.push({ role: item.role, text: content.text });
          if (item.role === 'user') users.push(content.text);
        }
      }
    }
  }
  // Normalize transport line endings only. Never fingerprint the stored preview,
  // collapse arbitrary whitespace, or trim a changing objective off the end.
  const normalized = instructions.map(item => ({ role: item.role, text: item.text.replace(/\r\n?/g, '\n').trim() }));
  // An exact, standalone acknowledgment adds no new task instruction. Keep it
  // in the review preview, but derive identity from the objective it continues.
  const complete = JSON.stringify(normalized.filter(item => item.role !== 'user' || !continuation.test(item.text)));
  const hidden = JSON.stringify(['previous_response_id', 'conversation', 'prompt'].map(key => body[key] ?? null));
  const fingerprint = createHash('sha256').update('task-evidence-v2\0').update(complete).update(hidden).update(opaque ? '\0opaque' : '').digest('hex');
  const objectives = users.filter(text => text.trim() && !metadata.test(text.trim()) && !continuation.test(text.trim()));
  if (!objectives.length) issue ??= 'The task being continued cannot be established from this request';
  if (opaque) issue ??= 'Some attachment or stored context is unavailable; only visible task instructions can be screened';
  const tooLarge = Buffer.byteLength(complete, 'utf8') > MAX_EVIDENCE_BYTES;
  if (tooLarge) issue = 'Task evidence exceeds the screening size limit; it was not silently truncated';
  return {
    fingerprint,
    text: complete,
    contextKnown: !issue,
    screenable: !tooLarge && !tooManyItems && complete !== '[]',
    issue,
    objectivePreview: redactLogText(objectives.at(-1) ?? '', 600),
    latestPreview: redactLogText(users.at(-1) ?? '', 600),
  };
}
