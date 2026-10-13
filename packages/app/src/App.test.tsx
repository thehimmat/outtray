// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
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
    expect(screen.getByText(/4 documents read/)).toBeTruthy();
  });

  it('never shows a full ID number from the demo documents', async () => {
    const user = userEvent.setup();
    render(<App api={demoApi(() => '2026-07-22')} />);
    await user.click(screen.getByRole('button', { name: /Choose a folder/ }));
    await screen.findByRole('heading', { name: 'Demo documents' });
    expect(document.body.textContent).not.toMatch(/D8923829|POL-804220/);
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
    };
    render(<App api={api} />);
    await user.click(screen.getByRole('button', { name: /Choose a folder/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Start Ollama/);
    expect(screen.getByRole('button', { name: /Choose a folder/ })).toBeTruthy();
  });
});
