import React, { StrictMode, useEffect } from 'react';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { afterEach, it, expect } from 'vitest';
import { AxiosHeaders } from 'axios';
import { AppProviders } from '../src/app/providers/AppProviders';
import { api } from '../src/lib/api';
import { useAuth } from '../src/features/auth/use-auth';
import { auth } from '../src/features/auth/auth';

afterEach(cleanup);
function Probe({ capture }: { capture: (client: QueryClient) => void }) {
  const auth = useAuth();
  const client = useQueryClient();
  useEffect(() => capture(client), [capture, client]);
  return <span>{auth.status}</span>;
}

it('React StrictMode initializes the shared store with exactly one refresh', async () => {
  let refreshes = 0;
  let client!: QueryClient;
  const capture = (value: QueryClient) => {
    client = value;
  };
  api.defaults.adapter = async (config) => {
    if (config.url === '/auth/refresh') refreshes++;
    if (config.url === '/auth/logout')
      return {
        status: 204,
        statusText: 'No Content',
        config,
        headers: new AxiosHeaders(),
        data: undefined,
      };
    return {
      status: 200,
      statusText: 'OK',
      config,
      headers: new AxiosHeaders(),
      data: {
        accessToken: 'restored-token',
        tokenType: 'Bearer',
        expiresIn: 900,
        user: {
          id: 'student',
          fullName: 'Student',
          email: 'student@example.com',
          role: 'STUDENT',
          isActive: true,
        },
      },
    };
  };
  const view = render(
    <StrictMode>
      <AppProviders>
        <Probe capture={capture} />
      </AppProviders>
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByText('authenticated')).toBeTruthy());
  expect(refreshes).toBe(1);
  view.unmount();
  render(
    <AppProviders>
      <Probe capture={capture} />
    </AppProviders>,
  );
  await waitFor(() => expect(screen.getByText('authenticated')).toBeTruthy());
  expect(refreshes).toBe(1);
  client.setQueryData(['private-data'], 'old student data');
  await act(async () => {
    await auth.logout();
  });
  expect(client.getQueryData(['private-data'])).toBeUndefined();
  expect(screen.getByText('unauthenticated')).toBeTruthy();
});
