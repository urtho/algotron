import { useCallback, useEffect, useState } from 'react';
import { BootTerminal } from './components/BootTerminal.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { Leagues, VerifyPage } from './components/Leagues.tsx';
import { VERIFY_HASH } from './own.ts';
import { useFeed } from './state.ts';

const onLeagues = () => location.hash.startsWith('#leagues');
const onVerify = () => location.hash.startsWith(VERIFY_HASH);
/** Views that cover the dashboard */
const onOverlay = () => onLeagues() || onVerify();

export function App() {
  const state = useFeed();
  const [leagues, setLeagues] = useState(onLeagues);
  const [verify, setVerify] = useState(() => (onVerify() ? location.hash : ''));
  // The boot terminal plays once per page load; a later reconnect goes straight to the dashboard.
  // A visit that starts on the leagues or on a statement link skips it.
  const [booted, setBooted] = useState(onOverlay);
  const done = useCallback(() => setBooted(true), []);

  useEffect(() => {
    const change = () => {
      setLeagues(onLeagues());
      setVerify(onVerify() ? location.hash : '');
    };
    addEventListener('hashchange', change);
    return () => removeEventListener('hashchange', change);
  }, []);

  return (
    <div className="app">
      {!booted && !leagues && !verify && (
        <BootTerminal lines={state.bootLines} ready={state.ready} onDone={done} />
      )}
      {/* Mounted from the start so Three.js is ready when the terminal closes; kept mounted under the leagues */}
      <div
        className="app-dash"
        style={{ opacity: booted ? 1 : 0, display: leagues || verify ? 'none' : undefined }}
      >
        <Dashboard state={state} />
      </div>
      {leagues && <Leagues votes={!!state.config.avstream} />}
      {verify && <VerifyPage hash={verify} />}
    </div>
  );
}
