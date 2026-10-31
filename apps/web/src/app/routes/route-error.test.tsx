import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { reloadForNewVersion } from '@/lib/new-version';
import { RouteError } from './route-error';

vi.mock('@/lib/new-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/new-version')>()),
  reloadForNewVersion: vi.fn(() => false),
}));

function renderFailingRoute(error: unknown) {
  const router = createMemoryRouter([
    {
      path: '/',
      errorElement: <RouteError />,
      lazy: async () => {
        throw error;
      },
    },
  ]);
  render(<RouterProvider router={router} />);
}

describe('RouteError', () => {
  it('loads the new build when a lazy page of the old one is gone after a deploy', async () => {
    renderFailingRoute(
      new TypeError('Failed to fetch dynamically imported module: /assets/routes-AbC123.js'),
    );
    expect(
      await screen.findByRole('heading', { name: 'A new version is available' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    // The reload is an effect of the render that shows the heading, flushed a task later.
    await waitFor(() => expect(vi.mocked(reloadForNewVersion)).toHaveBeenCalledTimes(1));
  });

  it('keeps the generic message for any other failure', async () => {
    vi.mocked(reloadForNewVersion).mockClear();
    renderFailingRoute(new Error('boom'));
    expect(
      await screen.findByRole('heading', { name: 'Something went wrong' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toBeInTheDocument();
    expect(vi.mocked(reloadForNewVersion)).not.toHaveBeenCalled();
  });
});
