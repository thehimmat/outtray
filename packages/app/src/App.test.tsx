// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { OuttrayApi } from './api.js';
import { demoApi } from './demo-api.js';

afterEach(cleanup);

describe('App', () => {
  it('plans a chosen folder and shows its queue, using the real core planner', async () => {
    const user = userEvent.setup();
    render(<App api={demoApi(() => '2026-07-22')} />);
    await user.click(screen.getByRole('button', { name: /Choose a folder/ }));
    expect(await screen.findByRole('heading', { name: 'Demo documents' })).toBeTruthy();
    expect(screen.getByText(/drivers-license\.png expired 2026-01-19/)).toBeTruthy();
    expect(screen.getByRole('listitem', { name: /Pay Metro Electric \$91\.00/ })).toBeTruthy();
    expect(screen.getByText(/5 documents read/)).toBeTruthy();
  });

  it('never shows a full ID number from the demo documents', async () => {
    const user = userEvent.setup();
    render(<App api={demoApi(() => '2026-07-22')} />);
    await user.click(screen.getByRole('button', { name: /Choose a folder/ }));
    await screen.findByRole('heading', { name: 'Demo documents' });
    expect(document.body.textContent).not.toMatch(/D8923829|POL-804220|4410-2287-19|4410228719/);
  });

  it('takes the marks from the host, not the last screen, when a folder is planned again', async () => {
    const user = userEvent.setup();
    // A host that saves nothing: after a re-plan, no tick may survive.
    const api: OuttrayApi = { ...demoApi(() => '2026-07-22'), setReviewed: async () => {} };
    render(<App api={api} />);
    const choose = screen.getByRole('button', { name: /Choose a folder/ });
    await user.click(choose);
    const [box] = await screen.findAllByRole('checkbox', { name: /Reviewed/ });
    await user.click(box as HTMLElement);
    expect((box as HTMLInputElement).checked).toBe(true);
    await user.click(choose);
    await screen.findByRole('heading', { name: 'Demo documents' });
    const [again] = await screen.findAllByRole('checkbox', { name: /Reviewed/ });
    expect((again as HTMLInputElement).checked).toBe(false);
  });

  it('stays put when the person cancels the folder picker', async () => {
    const user = userEvent.setup();
    const api: OuttrayApi = { ...demoApi(), chooseFolder: async () => null };
    render(<App api={api} />);
    await user.click(screen.getByRole('button', { name: /Choose a folder/ }));
    expect(screen.queryByRole('heading', { level: 1, name: /Demo/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Choose a folder/ })).toBeTruthy();
  });

  it('shows the host error in plain words and lets the person try again', async () => {
    const user = userEvent.setup();
    const api: OuttrayApi = {
      chooseFolder: async () => '/docs',
      planFolder: async () => {
        throw new Error('The local model is not running. Start Ollama and try again.');
      },
      setReviewed: async () => {},
      setDocumentType: async () => ({ reextract: false, learned: false }),
      search: async () => [],
    };
    render(<App api={api} />);
    await user.click(screen.getByRole('button', { name: /Choose a folder/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Start Ollama/);
    expect(screen.getByRole('button', { name: /Choose a folder/ })).toBeTruthy();
  });

  it('settles a disputed type and shows the corrected queue on the next plan', async () => {
    const user = userEvent.setup();
    render(<App api={demoApi(() => '2026-07-22')} />);
    await user.click(screen.getByRole('button', { name: /Choose a folder/ }));
    const flag = await screen.findByRole('listitem', { name: /Type disputed for water-bill\.png/ });
    await user.selectOptions(within(flag).getByRole('combobox', { name: /Document type/ }), 'bill');
    await user.click(within(flag).getByRole('button', { name: /Set type/ }));
    await within(flag).findByRole('status');

    await user.click(screen.getByRole('button', { name: /Plan again/ }));
    await screen.findByRole('heading', { name: 'Demo documents' });
    expect(screen.queryByRole('listitem', { name: /Type disputed/ })).toBeNull();
    const advice = screen.getAllByRole('listitem', { name: /Shred once payment has cleared/ });
    expect(advice.some((li) => /water-bill\.png/.test(li.textContent ?? ''))).toBe(true);
  });

  it('offers no Plan again before a folder is planned', () => {
    render(<App api={demoApi(() => '2026-07-22')} />);
    expect(screen.queryByRole('button', { name: /Plan again/ })).toBeNull();
  });

  it('searches the planned documents and cites where each passage came from', async () => {
    const user = userEvent.setup();
    render(<App api={demoApi(() => '2026-07-22')} />);
    await user.click(screen.getByRole('button', { name: /Choose a folder/ }));
    const box = await screen.findByRole('searchbox', { name: /Search these documents/ });
    await user.type(box, 'grocery receipt');
    await user.click(screen.getByRole('button', { name: /^Search$/ }));
    const results = await screen.findByRole('list', { name: /Search results/ });
    const first = within(results).getAllByRole('listitem')[0];
    expect(first?.textContent).toMatch(/grocery-receipt\.png/);
    expect(document.body.textContent).not.toMatch(/4410-2287-19|4410228719|D8923829|POL-804220/);
  });

  it('says so when a search finds nothing, and shows a search error in plain words', async () => {
    const user = userEvent.setup();
    const api: OuttrayApi = {
      ...demoApi(() => '2026-07-22'),
      search: async (q) => {
        if (q === 'boom') throw new Error('The local model is not running.');
        return [];
      },
    };
    render(<App api={api} />);
    await user.click(screen.getByRole('button', { name: /Choose a folder/ }));
    const box = await screen.findByRole('searchbox', { name: /Search these documents/ });
    await user.type(box, 'nothing here');
    await user.click(screen.getByRole('button', { name: /^Search$/ }));
    expect(await screen.findByText('No matching passages.')).toBeTruthy();
    await user.clear(box);
    await user.type(box, 'boom');
    await user.click(screen.getByRole('button', { name: /^Search$/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Could not search: The local model is not running/,
    );
  });
});
