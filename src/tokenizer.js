import { Tiktoken } from 'js-tiktoken';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

const encoder = new Tiktoken(o200kBase);

export function countTokens(text) {
  if (!text) return 0;
  return encoder.encode(text).length;
}

export function countChatCompletionTokens(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let total = 0;

  for (const message of messages) {
    if (typeof message?.content === 'string') {
      total += countTokens(message.content);
    } else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === 'string') total += countTokens(part.text);
      }
    }

    if (typeof message?.name === 'string') total += countTokens(message.name);
    if (typeof message?.role === 'string') total += countTokens(message.role);
  }

  if (typeof body?.system === 'string') total += countTokens(body.system);
  if (typeof body?.prompt === 'string') total += countTokens(body.prompt);

  return total + messages.length * 4 + 2;
}
