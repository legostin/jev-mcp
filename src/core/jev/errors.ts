export type JevErrorKind =
  | 'auth' | 'validation' | 'rate_limit' | 'overloaded' | 'network' | 'timeout' | 'server' | 'config' | 'aborted';

/** Kinds worth retrying on the same provider, and worth failing over to another one. */
export const RETRYABLE: ReadonlySet<JevErrorKind> = new Set(['rate_limit', 'overloaded', 'network', 'timeout', 'server']);

export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;
  readonly body?: string;
  readonly provider?: string;

  constructor(kind: JevErrorKind, message: string, extra: { status?: number; body?: string; provider?: string } = {}) {
    super(message);
    this.name = 'JevError';
    this.kind = kind;
    this.status = extra.status;
    this.body = extra.body;
    this.provider = extra.provider;
  }
}

export function kindForStatus(status: number): JevErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 404 || status === 422) return 'validation';
  if (status === 402) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 529 || status === 503) return 'overloaded';
  return 'server';
}
