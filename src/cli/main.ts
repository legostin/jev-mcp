import { connectDaemon } from '../daemon/client.ts';
import { coerceValue } from '../core/config/store.ts';

const HELP = `jev — browser control for AI agents, driven by JEV decisions

Usage:
  jev mcp                          Run the MCP server (stdio); used by Claude Code, Codex and other clients
  jev daemon [--foreground]        Run the daemon (normally started automatically)
  jev stop                         Stop the daemon
  jev doctor                       Check key, JEV latency, Chrome and extension
  jev settings get [path]          Show settings (keys masked)
  jev settings set <path> <value>  Change a setting; use "-" to read the value from stdin (for API keys)
  jev tabs                         List tabs
  jev open <url> [--driver d]      Open a tab and print the page overview
  jev observe [view] [target]      Print a page view (overview|region|element|diff|full)
  jev find <query>                 Rank elements matching a description
  jev call <method> [json]         Raw daemon call (task.create, task.answer, page.observe, …)
  jev watch <task> [--until question|done|any] [--timeout s]
                                   Wait for a task event, print it as JSON, exit (for background use)
  jev pair                         Show a pairing code for the Chrome extension
  jev ui                           Print the debug UI address
  jev calibrate [--template t]     Reliability of JEV confidence per template, with threshold advice
  jev install | uninstall          Register/unregister the MCP server, skill and CLI link
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function daemonCall<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const c = await connectDaemon({ autostart: true });
  try {
    await c.call('session.hello', { client: 'cli', pid: process.pid, sessionId: process.env.JEV_SESSION || undefined });
    return await c.call<T>(method, params, { timeoutMs });
  } finally { c.close(); }
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'mcp': {
        const { runMcpServer } = await import('../mcp/main.ts');
        await runMcpServer();
        return;
      }
      case 'daemon': {
        const { startDaemon } = await import('../daemon/main.ts');
        const { registerStage2 } = await import('../daemon/extend.ts');
        const handle = await startDaemon({ logToStderr: args.includes('--foreground'), reloadOnChange: true });
        await registerStage2(handle);
        return;
      }
      case 'stop': await daemonCall('daemon.stop'); console.log('daemon stopping'); return;
      case 'doctor': {
        const r = await daemonCall('doctor', {}, 60_000);
        for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
      case 'settings': {
        const [sub, path, value] = args;
        if (sub === 'set') {
          if (!path) throw new Error('usage: jev settings set <path> <value|->');
          const raw = value === '-' || value === undefined ? await readStdin() : value;
          const r = await daemonCall('settings.set', { path, value: path.endsWith('apiKey') ? raw : coerceValue(raw) });
          console.log(`${r.path} = ${JSON.stringify(r.value)}`);
        } else {
          const r = await daemonCall('settings.get', { path: sub === 'get' ? path : sub });
          console.log(JSON.stringify(r.value, null, 2));
        }
        return;
      }
      case 'tabs': {
        const r = await daemonCall('tabs.list');
        for (const t of r.tabs) console.log(`${t.current ? '*' : ' '} ${t.id} [${t.driver}] ${t.title} ${t.url}`);
        return;
      }
      case 'open': {
        const r = await daemonCall('tabs.open', { url: args[0], driver: flag(args, 'driver') });
        console.log(`opened ${r.tab} (${r.driver})\n${r.overview}`);
        return;
      }
      case 'observe': {
        const r = await daemonCall('page.observe', { view: args[0] ?? 'overview', target: args[1], tab: flag(args, 'tab') });
        console.log(r.text);
        return;
      }
      case 'find': {
        const r = await daemonCall('page.find', { query: args.filter((a) => !a.startsWith('--')).join(' '), tab: flag(args, 'tab') });
        console.log(`best ${r.best} confidence ${r.confidence.toFixed(2)} exists ${r.exists.toFixed(2)} (${r.decision})`);
        for (const m of r.matches) console.log(`  ${m.ref} p=${m.p.toFixed(2)} ${m.desc}`);
        return;
      }
      case 'call': {
        // Raw daemon RPC for agents without MCP and for debugging: jev call <method> [json-params]
        if (!args[0]) throw new Error('usage: jev call <method> [json-params]');
        const params = args[1] ? JSON.parse(args[1] === '-' ? await readStdin() : args[1]) : {};
        const r = await daemonCall(args[0], params, Number(flag(args, 'timeout') ?? 120) * 1000);
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      case 'watch': {
        const { watch } = await import('./watch.ts');
        process.exitCode = await watch(args);
        return;
      }
      case 'pair': {
        const r = await daemonCall('ext.pairingCode');
        console.log(`Pairing code: ${r.code} (valid ${r.validMinutes} min). Enter it in the jev extension side panel.`);
        return;
      }
      case 'ui': {
        const r = await daemonCall('ui.url');
        console.log(r.url);
        return;
      }
      case 'calibrate': {
        const r = await daemonCall('trace.calibration', { template: flag(args, 'template'), targetPrecision: Number(flag(args, 'precision') ?? 0.95) });
        const { printCalibration } = await import('./calibrate.ts');
        printCalibration(r);
        return;
      }
      case 'install': {
        const { install } = await import('./install.ts');
        await install(args);
        return;
      }
      case 'uninstall': {
        const { uninstall } = await import('./install.ts');
        await uninstall();
        return;
      }
      case undefined: case 'help': case '--help': case '-h':
        console.log(HELP);
        return;
      default:
        console.error(`Unknown command "${cmd}".\n${HELP}`);
        process.exitCode = 2;
    }
  } catch (e) {
    console.error(`jev: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
