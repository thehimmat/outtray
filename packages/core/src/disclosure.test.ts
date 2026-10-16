import { describe, expect, it } from 'vitest';
import {
  APP_IDENTIFIER_STORAGE_DISCLOSURE,
  firstRunNotice,
  IDENTIFIER_STORAGE_DISCLOSURE,
} from './disclosure.js';

describe.each([
  ['the CLI', IDENTIFIER_STORAGE_DISCLOSURE, /outtray reveal/],
  ['the app', APP_IDENTIFIER_STORAGE_DISCLOSURE, /Reveal button/],
])('the identifier storage disclosure for %s', (_host, text, revealHow) => {
  // The ADR-0011 honesty requirements, one assertion each, so a later rewrite
  // of the wording cannot quietly drop one from either host's text.

  it('presents the choice in the user terms ADR-0011 names, off by default', () => {
    expect(text).toMatch(/remember your ID numbers/);
    expect(text).toMatch(/last four/);
    expect(text).toMatch(/off unless you turn it on/i);
  });

  it('says the number is kept once, encrypted, and shown only on request, by that host', () => {
    expect(text).toMatch(/once/);
    expect(text).toMatch(/encrypted/);
    expect(text).toMatch(/shown only when you ask/);
    expect(text).toMatch(revealHow);
  });

  it('states the best-effort limit as reducing copies, never guaranteeing one', () => {
    expect(text).toMatch(/best effort/i);
    expect(text).not.toMatch(/guarantee/i);
  });

  it('says turning it on only takes effect at the next scan', () => {
    expect(text).toMatch(/next scan/);
  });

  it('says turning it off deletes every stored number', () => {
    expect(text).toMatch(/off deletes every/);
  });

  it('says the scope is ID numbers, not names or addresses', () => {
    expect(text).toMatch(/names\s+and\s+addresses/i);
  });

  it('stays short enough to be read: under 15 lines', () => {
    expect(text.trimEnd().split('\n').length).toBeLessThan(15);
  });
});

describe('APP_IDENTIFIER_STORAGE_DISCLOSURE', () => {
  it('does not send an app user to a CLI command', () => {
    expect(APP_IDENTIFIER_STORAGE_DISCLOSURE).not.toMatch(/outtray reveal/);
  });
});

describe('firstRunNotice', () => {
  it('with the setting off, says only the last four are kept and how to change it', () => {
    const notice = firstRunNotice(false, '/data/outtray.db');
    expect(notice).toMatch(/\/data\/outtray\.db/);
    expect(notice).toMatch(/last four/);
    expect(notice).toMatch(/outtray settings/);
  });

  it('with the setting already on, says full numbers are kept and how to turn it off', () => {
    const notice = firstRunNotice(true, '/data/outtray.db');
    expect(notice).toMatch(/in full/);
    expect(notice).toMatch(/outtray settings identifier-storage off/);
  });
});
