import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
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
      pickFolder: async () => {
        const picked = await open({
          directory: true,
          multiple: false,
          title: 'Choose a folder of documents',
        });
        return typeof picked === 'string' ? picked : null;
      },
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
