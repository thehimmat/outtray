/**
 * The documents a plan read, each with its type. A document whose type has an
 * ID number shows only the redacted form; Reveal asks the host to show the
 * full number in a window of its own, so the page never holds it (ADR-0013
 * amendment 1).
 */

import { Eye } from 'lucide-react';
import { useState } from 'react';
import type { PlannedDocument } from './api.js';
import { TYPE_LABEL } from './labels.js';

const OUTCOME = {
  shown: 'Shown in its own window.',
  not_stored:
    'Not remembered. Turn on remembering ID numbers in Settings, then plan the folder again.',
} as const;

export function DocumentsView({
  documents,
  onReveal,
}: {
  documents: readonly PlannedDocument[];
  onReveal: (file: string) => Promise<'shown' | 'not_stored'>;
}) {
  return (
    <details className="documents">
      <summary>Documents read ({documents.length})</summary>
      <ul>
        {documents.map((d) => (
          <DocumentRow key={d.file} document={d} onReveal={onReveal} />
        ))}
      </ul>
    </details>
  );
}

function DocumentRow({
  document,
  onReveal,
}: {
  document: PlannedDocument;
  onReveal: (file: string) => Promise<'shown' | 'not_stored'>;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = `doc-${document.file}`;
  const reveal = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      setNote(OUTCOME[await onReveal(document.file)]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li aria-labelledby={nameId}>
      <span id={nameId} className="source">
        {document.file}
      </span>{' '}
      <span className="doc-type">{TYPE_LABEL[document.type]}</span>
      {document.identifier ? (
        <>
          {' '}
          <span className="redacted">{document.identifier.redacted}</span>
          <button type="button" onClick={reveal} disabled={busy}>
            <Eye aria-hidden="true" size={16} /> Reveal
          </button>
        </>
      ) : null}
      {note ? <p role="status">{note}</p> : null}
      {error ? (
        <p className="error" role="alert">
          Could not reveal: {error}
        </p>
      ) : null}
    </li>
  );
}
