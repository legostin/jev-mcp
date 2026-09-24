/** Newline-delimited JSON-RPC 2.0 between the daemon and its clients (MCP proxies, CLI). */

/** Bumped when a daemon method changes incompatibly: a client speaking another version is told to restart. */
export const PROTOCOL_VERSION = 1;
export interface RpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
export interface RpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: RpcErrorBody }
export interface RpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }
export interface RpcErrorBody { code: number; message: string; data?: unknown }

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  jev: -32001,
  browser: -32002,
  notFound: -32004,
  conflict: -32009,
} as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** Splits a byte stream into JSON lines. */
export class LineDecoder {
  private buf = '';
  push(chunk: string, onLine: (line: string) => void): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) onLine(line);
    }
  }
}
