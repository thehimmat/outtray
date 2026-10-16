/**
 * Search the planned folder's documents, as `outtray find` does (ADR-0005,
 * ADR-0012). Every passage names the document it came from; passages are
 * tokenized derived text, so no full identifier is ever shown (ADR-0011).
 */

import type { Citation } from '@outtray/core';
import { Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';

export function SearchView({ onSearch }: { onSearch: (query: string) => Promise<Citation[]> }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Citation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResults(await onSearch(query));
    } catch (failure) {
      setResults(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="search" aria-label="Search">
      <form onSubmit={submit}>
        <label htmlFor="search-query">Search these documents</label>
        <input
          id="search-query"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="for example: car insurance renewal"
        />
        <button type="submit" disabled={busy}>
          <Search aria-hidden="true" size={16} /> Search
        </button>
      </form>
      {error ? (
        <p className="error" role="alert">
          Could not search: {error}
        </p>
      ) : null}
      {results !== null && results.length === 0 ? (
        <p className="empty">No matching passages.</p>
      ) : null}
      {results !== null && results.length > 0 ? (
        <ol className="results" aria-label="Search results">
          {results.map((c) => (
            <li key={`${c.source.documentId}|${c.source.chunkIndex}`}>
              <span className="source">{c.source.documentId}</span>
              <span className="score">{c.score.toFixed(2)}</span>
              <p>{c.text.length > 200 ? `${c.text.slice(0, 200)}...` : c.text}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
