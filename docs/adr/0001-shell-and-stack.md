# ADR-0001: Shell and stack

Status: accepted. Date: 2026-07-21.

## Context

The product is a desktop app for macOS first (owner's machine: 2022 MacBook
Air, 8 CPU cores, 8 GB unified memory, which is both the dev machine and the
initial deployment target). The owner's primary language is TypeScript. The
immediate goal is an interview-ready showcase; the desktop shell itself is not
the showcase, the pipeline and evals are.

## Decision

- **Tauri v2 + React + TypeScript + Vite** for the shell, chosen over Electron
  (memory footprint matters on the target hardware) and over CLI-only (the
  Phase 3 approval queue is inherently a GUI, and shipping a desktop app is
  part of the showcase).
- **Rust only for the shell and OS integration.** All domain logic lives in
  TypeScript in `packages/core`, which must never import Tauri APIs. Core
  stays runnable and testable under plain Node.
- **CLI-first sequencing.** Phase 0 scaffolds a thin CLI (`packages/cli`) over
  core; Phases 1 and 2 demo via CLI plus the eval scoreboard. The first real
  Tauri code is written at the start of Phase 3, when the action-queue review
  UI exists to justify it.
- Tooling: pnpm workspaces, Biome (single fast binary, kind to 8 GB of RAM),
  Vitest, TypeScript project references, Conventional Commits, squash-merge
  PRs into an always-releasable main.

## Consequences

- The daily dev loop is pure Node/Vitest: fast on constrained hardware, no
  Rust compiles until Phase 3.
- A future CLI or server mode needs no rewrite; the CLI exists from day one.
- Deferring Tauri means the shell integration risk (folder access UX, sidecar
  wiring, signing) surfaces in Phase 3, mitigated by ADR-0007's early spikes.
