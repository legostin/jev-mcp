import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { ERR, LineDecoder, RpcError, type RpcRequest } from './protocol.ts';
import { logger } from '../core/util/log.ts';

const log = logger('rpc');

export interface Connection {
  id: string;
  sessionId: string | null;
  client: string;
  notify(method: string, params: unknown): void;
  socket: Socket;
}

export type Handler = (params: any, conn: Connection) => Promise<unknown> | unknown;

/** JSON-RPC server on a unix socket (owner-only permissions). */
export class RpcServer {
  private server: Server;
  private handlers = new Map<string, Handler>();
  readonly connections = new Set<Connection>();
  private seq = 0;
  /** Requests being handled right now (a restart waits for none). */
  inFlight = 0;
  onDisconnect: (conn: Connection) => void = () => {};
  onActivity: () => void = () => {};

  constructor() {
    this.server = createServer((socket) => this.accept(socket));
  }

  register(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  listen(path: string): Promise<void> {
    if (existsSync(path)) rmSync(path, { force: true });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(path, () => {
        chmodSync(path, 0o600);
        resolve();
      });
    });
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8');
    const conn: Connection = {
      id: `k${++this.seq}`, sessionId: null, client: 'unknown', socket,
      notify: (method, params) => {
        if (!socket.destroyed) socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
      },
    };
    this.connections.add(conn);
    const decoder = new LineDecoder();
    socket.on('data', (chunk: string) => decoder.push(chunk, (line) => { void this.handle(line, conn); }));
    socket.on('close', () => { this.connections.delete(conn); this.onDisconnect(conn); });
    socket.on('error', () => {});
  }

  private async handle(line: string, conn: Connection): Promise<void> {
    let req: RpcRequest;
    try { req = JSON.parse(line); } catch {
      conn.socket.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ERR.parse, message: 'Parse error' } }) + '\n');
      return;
    }
    this.onActivity();
    const reply = (body: Record<string, unknown>) => {
      if (!conn.socket.destroyed) conn.socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }) + '\n');
    };
    const handler = this.handlers.get(req.method);
    if (!handler) return reply({ error: { code: ERR.methodNotFound, message: `Unknown method ${req.method}` } });
    this.inFlight++;
    try {
      const result = await handler(req.params ?? {}, conn);
      reply({ result: result ?? null });
    } catch (e) {
      if (e instanceof RpcError) return reply({ error: { code: e.code, message: e.message, data: e.data } });
      const err = e as Error & { kind?: string };
      log.warn(`${req.method} failed: ${err.message}`);
      reply({ error: { code: err.kind ? ERR.jev : ERR.internal, message: err.message, data: err.kind ? { kind: err.kind } : undefined } });
    } finally {
      this.inFlight--;
    }
  }

  broadcast(method: string, params: unknown, filter?: (c: Connection) => boolean): void {
    for (const c of this.connections) if (!filter || filter(c)) c.notify(method, params);
  }

  close(): Promise<void> {
    for (const c of this.connections) c.socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
