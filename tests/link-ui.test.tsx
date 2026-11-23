import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProgramDetail from '../src/pages/ProgramDetail';

afterEach(() => cleanup());

function mount(sourceUrl: string | null) {
  window.api = {
    programs: { getById: async () => ({ id: 'p', name: 'Test Program', program_type: 'airline', is_active: 1, notes: null, source_url: sourceUrl, created_at: '' }) },
    benefits: { getForProgram: async () => [] },
    projection: { all: async () => [] },
  } as unknown as typeof window.api;
  render(<MemoryRouter initialEntries={['/programs/p']}><Routes><Route path="/programs/:id" element={<ProgramDetail />} /></Routes></MemoryRouter>);
}

it('shows an official-page link only for web links (v1.0.29)', async () => {
  mount('https://world.hyatt.com/');
  expect(await screen.findByRole('link', { name: /Official page/ })).toHaveAttribute('href', 'https://world.hyatt.com/');
  expect(screen.getByRole('link', { name: /Official page/ })).toHaveAttribute('rel', 'noreferrer noopener');
  cleanup();
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-msdt:/id x']) {
    mount(bad);
    await screen.findByText('Test Program');
    expect(screen.queryByRole('link', { name: /Official page/ })).toBeNull();
    cleanup();
  }
});
