/**
 * Loopback-only endpoint guard shared by the local providers (THREAT_MODEL.md).
 *
 * Ollama's HTTP API is unauthenticated, so the app must prove it is only ever
 * talking to a loopback address before sending any document to it. This is
 * enforced at provider construction so a misconfigured endpoint fails fast.
 */

/** Hostnames a local provider is allowed to talk to. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Thrown when a provider is pointed at a non-loopback endpoint. */
export class NonLoopbackHostError extends Error {
  constructor(host: string) {
    super(
      `Refusing a non-loopback host: ${host}. Documents must never leave the ` +
        'machine before the Phase 5 opt-in (ADR-0003, THREAT_MODEL.md).',
    );
    this.name = 'NonLoopbackHostError';
  }
}

/** Throw `NonLoopbackHostError` unless `host` is a loopback URL. */
export function assertLoopback(host: string): void {
  let hostname: string;
  try {
    hostname = new URL(host).hostname;
  } catch {
    throw new NonLoopbackHostError(host);
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new NonLoopbackHostError(host);
  }
}
