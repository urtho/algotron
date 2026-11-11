import { useCallback, useState } from 'react';
import { BootTerminal } from './components/BootTerminal.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { useFeed } from './state.ts';

export function App() {
  const state = useFeed();
  // The boot terminal plays once per page load; a later reconnect goes straight to the dashboard
  const [booted, setBooted] = useState(false);
  const done = useCallback(() => setBooted(true), []);

  return (
    <div className="app">
      {!booted && <BootTerminal lines={state.bootLines} ready={state.ready} onDone={done} />}
      {/* Mounted from the start so Three.js is ready when the terminal closes */}
      <div className="app-dash" style={{ opacity: booted ? 1 : 0 }}>
        <Dashboard state={state} />
      </div>
    </div>
  );
}
