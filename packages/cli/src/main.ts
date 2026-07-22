#!/usr/bin/env node
/**
 * Outtray CLI entry point.
 *
 * Thin by design: all domain logic lives in @outtray/core (ADR-0001). This
 * binary is the demo and dogfooding surface until the Tauri shell lands in
 * Phase 3.
 *
 * Failure modes: exits 1 with a usage message on unknown commands; never
 * touches the filesystem or network in Phase 0.
 */

const USAGE = `outtray: point it at the pile, get an action list.

Usage:
  outtray scan <dir>   Ingest a folder of documents (lands in Phase 1)
  outtray --version    Print version
  outtray --help       Show this help
`;

function main(argv: readonly string[]): number {
  const [command] = argv;
  switch (command) {
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case '--version':
    case '-v':
      process.stdout.write('0.0.0\n');
      return 0;
    case 'scan':
      process.stdout.write('scan is not implemented yet: it lands in Phase 1 (extraction core).\n');
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
