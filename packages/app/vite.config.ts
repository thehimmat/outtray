import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The app bundles only the host-neutral core entry (ADR-0013); importing
// `@outtray/core/node` here would fail the build, which is the point.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/web', target: 'es2022' },
});
