import { describe, it, expect } from 'vitest';
import { stripCodexBlock } from '../../src/cli/install.ts';

describe('codex config editing', () => {
  it('removes only the jev-browser tables', () => {
    const toml = `[a]\nx = 1\n\n[mcp_servers.jev-browser]\ncommand = "node"\n\n[mcp_servers.jev-browser.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "x"\n`;
    const out = stripCodexBlock(toml);
    expect(out).not.toContain('jev-browser');
    expect(out).toContain('[mcp_servers.other]');
    expect(out).toContain('[a]');
  });
});
