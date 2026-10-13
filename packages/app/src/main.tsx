import { invoke } from '@tauri-apps/api/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { demoApi } from './demo-api.js';
import { tauriApi } from './tauri-api.js';
import './styles.css';

// Inside the desktop shell, run against the real host; in a plain browser
// (`pnpm --filter @outtray/app dev`), against the demo.
const inTauri = '__TAURI_INTERNALS__' in window;
const api = inTauri
  ? tauriApi({
      invoke,
      // The shell shows the picker and allows only what is picked there (#123).
      pickFolder: () => invoke<string | null>('pick_folder'),
    })
  : demoApi();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>,
  );
}
