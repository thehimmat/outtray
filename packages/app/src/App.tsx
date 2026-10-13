/**
 * The app shell's one screen for now: choose a folder, see its proposed
 * action queue. The host behind `api` is the demo until the Tauri adapters
 * land (ADR-0013).
 */

import { FolderOpen, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import type { OuttrayApi, PlannedFolder } from './api.js';
import { QueueView } from './QueueView.js';

type State =
  | { kind: 'idle' }
  | { kind: 'planning'; folder: string }
  | { kind: 'planned'; result: PlannedFolder }
  | { kind: 'failed'; message: string };

export function App({ api }: { api: OuttrayApi }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const choose = async () => {
    try {
      const folder = await api.chooseFolder();
      if (folder === null) return;
      setState({ kind: 'planning', folder });
      setState({ kind: 'planned', result: await api.planFolder(folder) });
    } catch (error) {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <main className="app">
      <header>
        <h1>Outtray</h1>
        <button type="button" onClick={choose} disabled={state.kind === 'planning'}>
          <FolderOpen aria-hidden="true" size={18} /> Choose a folder
        </button>
      </header>
      {state.kind === 'idle' ? (
        <p className="intro">
          Point Outtray at a folder of documents. It reads them on this computer and proposes what
          needs doing; nothing is changed or deleted.
        </p>
      ) : null}
      {state.kind === 'planning' ? (
        <p className="status" role="status">
          <LoaderCircle aria-hidden="true" size={18} className="spin" /> Reading {state.folder}...
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p className="error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'planned' ? (
        <>
          <h1 className="folder">{state.result.folder}</h1>
          <p className="meta">
            {state.result.scanned} documents read
            {state.result.skipped.length > 0
              ? `, ${state.result.skipped.length} other files not looked at`
              : ''}
            .
          </p>
          {state.result.notes.map((note) => (
            <p key={note} className="note">
              {note}
            </p>
          ))}
          <QueueView queue={state.result.queue} />
        </>
      ) : null}
    </main>
  );
}
