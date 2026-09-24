import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compatNotice } from '../../src/mcp/client.ts';
import { codeFingerprint, toolsFingerprint } from '../../src/mcp/fingerprint.ts';
import { PROTOCOL_VERSION } from '../../src/daemon/protocol.ts';

describe('MCP server and daemon compatibility', () => {
  const own = { tools: 'aaaa', startedAt: 1000 };

  it('says nothing when both run the same code', () => {
    expect(compatNotice({ sessionId: 's', protocol: PROTOCOL_VERSION, tools: 'aaaa', startedAt: 2000 }, own)).toBeNull();
  });

  it('asks to restart the MCP server when a newer daemon has other tools', () => {
    expect(compatNotice({ sessionId: 's', protocol: PROTOCOL_VERSION, tools: 'bbbb', startedAt: 2000 }, own)).toMatch(/restart the MCP server/);
  });

  it('points at the daemon when it is the older side', () => {
    expect(compatNotice({ sessionId: 's', protocol: PROTOCOL_VERSION, tools: 'bbbb', startedAt: 500 }, own)).toMatch(/daemon runs older code/);
    expect(compatNotice({ sessionId: 's' }, own)).toMatch(/older version/);
  });

  it('flags another protocol version even with the same tools', () => {
    expect(compatNotice({ sessionId: 's', protocol: PROTOCOL_VERSION + 1, tools: 'aaaa', startedAt: 2000 }, own)).toMatch(/restart the MCP server/);
  });

  it('fingerprints the tools the agent sees, and the code on disk', () => {
    const t = toolsFingerprint();
    expect(t).toMatch(/^[0-9a-f]{16}$/);
    expect(toolsFingerprint()).toBe(t);
    const dir = mkdtempSync(join(tmpdir(), 'jevfp-'));
    try {
      mkdirSync(join(dir, 'core'));
      writeFileSync(join(dir, 'core', 'a.ts'), 'export const a = 1;');
      const before = codeFingerprint(dir);
      expect(codeFingerprint(dir)).toBe(before);
      writeFileSync(join(dir, 'core', 'a.ts'), 'export const a = 2;');
      expect(codeFingerprint(dir)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
