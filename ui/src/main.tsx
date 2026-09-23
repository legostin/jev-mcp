import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from './api.ts';
import { Tasks } from './views/Tasks.tsx';
import { TaskView } from './views/TaskView.tsx';
import { Inspector } from './views/Inspector.tsx';
import { Replay } from './views/Replay.tsx';
import { Inbox } from './views/Inbox.tsx';
import { Settings } from './views/Settings.tsx';
import { Memory } from './views/Memory.tsx';
import { Calibration } from './views/Calibration.tsx';

function useHash(): string {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

const NAV: Array<[string, string]> = [
  ['#/', 'Tasks'], ['#/inbox', 'Questions'], ['#/inspect', 'Inspector'], ['#/replay', 'Replay'],
  ['#/calibration', 'Calibration'], ['#/memory', 'Site memory'], ['#/settings', 'Settings'],
];

function App() {
  const hash = useHash();
  const [info, setInfo] = useState<any>(null);
  useEffect(() => { api('/info').then(setInfo).catch(() => {}); }, []);
  const [path, query] = hash.slice(1).split('?');
  const params = new URLSearchParams(query ?? '');
  const parts = path.split('/').filter(Boolean);
  let view;
  switch (parts[0]) {
    case 'task': view = <TaskView id={parts[1]} />; break;
    case 'inbox': view = <Inbox />; break;
    case 'inspect': view = <Inspector tab={parts[1]} />; break;
    case 'replay': view = <Replay callId={params.get('call') ?? undefined} />; break;
    case 'calibration': view = <Calibration />; break;
    case 'memory': view = <Memory />; break;
    case 'settings': view = <Settings />; break;
    default: view = <Tasks />;
  }
  const active = `#/${parts[0] ?? ''}`;
  return (
    <div class="shell">
      <nav>
        <div class="brand">JEV Debug</div>
        {NAV.map(([href, label]) => (
          <a href={href} class={active === href || (href === '#/' && parts[0] === 'task') ? 'active' : ''}>{label}</a>
        ))}
        {info && (
          <div class="meta">
            v{info.version} · {info.provider}<br />{info.model}<br />
            extension: {info.extensionConnected ? 'connected' : 'off'}<br />chromium: {info.chromiumRunning ? 'running' : 'idle'}
          </div>
        )}
      </nav>
      <main>{view}</main>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
