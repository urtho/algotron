import { useCallback, useEffect, useState } from 'react';
import { BootTerminal } from './components/BootTerminal.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { Leagues } from './components/Leagues.tsx';
import { useFeed } from './state.ts';

const onLeagues = () => location.hash.startsWith('#leagues');

export function App() {
  const state = useFeed();
  const [leagues, setLeagues] = useState(onLeagues);
  // The boot terminal plays once per page load; a later reconnect goes straight to the dashboard.
  // A visit that starts on the leagues skips it.
  const [booted, setBooted] = useState(onLeagues);
  const done = useCallback(() => setBooted(true), []);

  useEffect(() => {
    const change = () => setLeagues(onLeagues());
    addEventListener('hashchange', change);
    return () => removeEventListener('hashchange', change);
  }, []);

  return (
    <div className="app">
      {!booted && !leagues && <BootTerminal lines={state.bootLines} ready={state.ready} onDone={done} />}
      {/* Mounted from the start so Three.js is ready when the terminal closes; kept mounted under the leagues */}
      <div className="app-dash" style={{ opacity: booted ? 1 : 0, display: leagues ? 'none' : undefined }}>
        <Dashboard state={state} />
      </div>
      {leagues && <Leagues />}
    </div>
  );
}
