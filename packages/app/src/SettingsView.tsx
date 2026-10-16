/**
 * The one setting: whether Outtray remembers ID numbers (ADR-0011, off by
 * default). The full disclosure is always on screen before it can be turned
 * on, in the words core pins with tests, and the host asks once more in a
 * native dialog; turning it off deletes every remembered number and says how
 * many.
 */

import { APP_IDENTIFIER_STORAGE_DISCLOSURE } from '@outtray/core';
import { useEffect, useState } from 'react';

/** The disclosure as paragraphs and bullet lists, with its hard line breaks reflowed. */
function Disclosure({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <div className="disclosure">
      {blocks.map((block) => {
        const lines = block.split('\n');
        const bullets: string[] = [];
        const lead: string[] = [];
        for (const line of lines) {
          if (line.startsWith('- ')) bullets.push(line.slice(2));
          else if (bullets.length > 0) bullets[bullets.length - 1] += ` ${line.trim()}`;
          else lead.push(line.trim());
        }
        return (
          <div key={block}>
            {lead.length > 0 ? <p>{lead.join(' ')}</p> : null}
            {bullets.length > 0 ? (
              <ul>
                {bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function SettingsView({
  readSettings,
  setIdentifierStorage,
}: {
  readSettings: () => Promise<{ identifierStorage: boolean }>;
  setIdentifierStorage: (on: boolean) => Promise<{ identifierStorage: boolean; purged: number }>;
}) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    readSettings()
      .then((s) => setOn(s.identifierStorage))
      .catch(() => setOn(false));
  }, [readSettings]);
  const change = async (next: boolean) => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const result = await setIdentifierStorage(next);
      setOn(result.identifierStorage);
      if (result.identifierStorage !== next) setNote('Not changed.');
      else if (next) setNote('ID numbers will be remembered from the next scan of each document.');
      else setNote(`Deleted ${result.purged} remembered ID number(s).`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings" aria-label="Settings">
      <h2>Settings</h2>
      {on === null ? null : (
        <>
          <p className="setting-state">Remembering ID numbers is {on ? 'on' : 'off'}.</p>
          <Disclosure text={APP_IDENTIFIER_STORAGE_DISCLOSURE} />
          {on ? (
            <button type="button" onClick={() => change(false)} disabled={busy}>
              Stop remembering and delete them
            </button>
          ) : (
            <button type="button" onClick={() => change(true)} disabled={busy}>
              Remember ID numbers
            </button>
          )}
        </>
      )}
      {note ? <p role="status">{note}</p> : null}
      {error ? (
        <p className="error" role="alert">
          Could not change the setting: {error}
        </p>
      ) : null}
    </section>
  );
}
