# @outtray/app

The desktop app's UI (Phase 3). React over the host-neutral `@outtray/core`
(ADR-0013): the UI depends only on the `OuttrayApi` interface in `src/api.ts`.

Two hosts implement it:

- `src/tauri-api.ts`, in the desktop shell (`src-tauri`). Core runs in the
  webview and calls the same `scanWithStore` as the CLI; the shell holds the
  encrypted store (`store/`, the shared contract suite's Rust store), the
  Keychain key (never sent to the page), the native folder picker, and
  read-only access to the picked folders only (#123). The models are
  the local Ollama ones (`qwen3-vl:2b`, `nomic-embed-text`).
- `src/demo-api.ts`, in a plain browser: the real core planner over
  synthetic documents, for UI work without a model.

```sh
pnpm build                            # core first; the app imports its dist
pnpm --filter @outtray/app tauri dev  # the desktop app (macOS; Ollama running)
pnpm --filter @outtray/app dev        # the demo host in a browser (stop it when done)
pnpm --filter @outtray/app bundle     # production web bundle into dist/web
```

The shell's data and key are the CLI's (`~/Library/Application
Support/outtray/`, Keychain service `outtray`), so the app and `outtray scan`
share one store. Builds are unsigned until #12.

The queue follows ADR-0008: every proposal shows the evidence it came from,
review-gated items say so, the retention disclaimer is always shown, the
summary never claims an all clear, and nothing in the UI acts on a file.

![The demo queue](../../docs/images/app-queue-demo.png)
