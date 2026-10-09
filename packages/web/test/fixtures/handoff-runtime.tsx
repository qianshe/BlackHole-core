// Browser-only synthetic fixture for the real Web HandoffBar and modal interactions.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type SessionView } from '../../src/api';
import { HandoffBar } from '../../src/console/HandoffBar';
import { ToastProvider } from '../../src/console/common';
import '../../src/global.css';

type TestCase = Pick<SessionView, 'id' | 'status' | 'pending_handoff'>;
const cases: TestCase[] = [
  { id: 'session-a', status: 'active', pending_handoff: { id: 'handoff-a', created_at: 123456789 } },
  { id: 'session-b', status: 'active', pending_handoff: { id: 'handoff-b', created_at: 123456790 } },
  { id: 'session-b', status: 'active', pending_handoff: { id: 'handoff-b2', created_at: 123456791 } },
  { id: 'session-b', status: 'paused', pending_handoff: { id: 'handoff-b2', created_at: 123456791 } },
];
let selected = 0;
type TestWindow = Window & { setCase?: (index: number) => void; copied?: string };
const testWindow = window as TestWindow;
(api as unknown as { handoff: (id: string) => Promise<unknown> }).handoff = async (id: string) => {
  const current = cases[selected]!;
  if (id !== current.id) throw Error('Synthetic session changed');
  return {
    available: true,
    session: { id: current.id, session_id: '000000000000000000000000000000000000123', status: current.status },
    handoff: { id: current.pending_handoff?.id, created_at: Date.now(), content: '合成内容 ' + current.id + ' ' + current.pending_handoff?.id },
    mcp_url: 'https://example.invalid/bridge/mcp/token',
  };
};

function App() {
  const [index, setIndex] = useState(0);
  testWindow.setCase = (next: number) => { selected = next; setIndex(next); };
  const session = cases[index]!;
  return <ToastProvider>
    <div id="fixture-workspace">
      <h1 data-current>{session.id}:{session.pending_handoff?.id}</h1>
      <header className="fixture-header">
        <HandoffBar key={session.id + ':' + (session.pending_handoff?.id ?? '')}
          session={session as SessionView} connectorName="BlackHole" now={Date.now()} />
      </header>
    </div>
  </ToastProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
