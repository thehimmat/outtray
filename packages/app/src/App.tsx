/**
 * The app shell's one screen for now: choose a folder, see its proposed
 * action queue, settle questioned types, and plan the same folder again to
 * see the result. The host behind `api` is the demo until the Tauri adapters
 * land (ADR-0013).
 */

import { FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { OuttrayApi, PlannedFolder } from './api.js';
import { QueueView } from './QueueView.js';

type State =
  | { kind: 'idle' }
  | { kind: 'planning'; folder: string }
  | { kind: 'planned'; result: PlannedFolder; run: number }
  | { kind: 'failed'; message: string };

export function App({ api }: { api: OuttrayApi }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [runs, setRuns] = useState(0);

  const plan = async (folder: string) => {
    setState({ kind: 'planning', folder });
    const result = await api.planFolder(folder);
    setRuns((n) => n + 1);
    setState({ kind: 'planned', result, run: runs + 1 });
  };
  const run = async (pick: () => Promise<string | null>) => {
    try {
      const folder = await pick();
      if (folder !== null) await plan(folder);
    } catch (error) {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  };
  const choose = () => run(() => api.chooseFolder());
  const lastFolder = state.kind === 'planned' ? state.result.folder : null;
  const again = () => run(async () => lastFolder);

  return (
    <main className="app">
      <header>
        <h1>Outtray</h1>
        <div className="header-actions">
          <button type="button" onClick={choose} disabled={state.kind === 'planning'}>
            <FolderOpen aria-hidden="true" size={18} /> Choose a folder
          </button>
          {lastFolder !== null ? (
            <button type="button" onClick={again}>
              <RefreshCw aria-hidden="true" size={18} /> Plan again
            </button>
          ) : null}
        </div>
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
          <QueueView
            // A fresh queue per plan, so its ticks start from what the host saved.
            key={state.run}
            queue={state.result.queue}
            initialReviewed={state.result.reviewed}
            onReviewedChange={(id, reviewed) => api.setReviewed(id, reviewed)}
            onTypeChange={(id, type) => api.setDocumentType(id, type)}
          />
        </>
      ) : null}
    </main>
  );
}
