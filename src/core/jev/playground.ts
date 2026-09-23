import LZString from 'lz-string';
import type { Json, Question } from './types.ts';

/** Link that opens the same state and questions in the TypeSafe console playground. */
export function playgroundUrl(state: Json, questions: Record<string, Question>, model = 'jev-latest'): string {
  const documentText = typeof state === 'string' ? state : JSON.stringify(state, null, 2);
  const payload = { apiVersion: 'v1', documentText, promptsText: JSON.stringify(questions, null, 2), selectedModels: [model] };
  return 'https://console.typesafe.ai/decode#share/' + LZString.compressToEncodedURIComponent(JSON.stringify(payload));
}

export function decodePlayground(url: string): unknown {
  const encoded = url.split('#share/')[1] ?? '';
  return JSON.parse(LZString.decompressFromEncodedURIComponent(encoded) ?? 'null');
}
