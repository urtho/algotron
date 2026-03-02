import { useAppWebSocket } from './hooks/useAppWebSocket.js';
import { BootTerminal } from './components/BootTerminal.js';
import { Dashboard } from './components/Dashboard.js';

export function App() {
  const state = useAppWebSocket();

  return (
    <div className="app">
      {/* Show boot terminal during connection / booting phases */}
      {(state.phase === 'connecting' || state.phase === 'booting') && (
        <BootTerminal logs={state.bootLogs} />
      )}

      {/* Dashboard is always mounted so Three.js initialises early, but
          it's invisible until boot completes to avoid layout flash */}
      <div style={{ opacity: state.phase === 'running' ? 1 : 0, transition: 'opacity 0.8s' }}>
        <Dashboard state={state} />
      </div>

      {/* Reconnecting banner */}
      {state.phase === 'connecting' && state.bootLogs.length === 0 && (
        <div className="connecting-banner">
          Connecting to Algotron backend<span className="ellipsis" />
        </div>
      )}
    </div>
  );
}
