import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Route, Routes } from 'react-router';
import { api } from './lib/api';

type Branding = { name: string; accent: string; logoUrl: string | null };

/** The team's look, readable before sign-in. The accent becomes a CSS variable the theme uses. */
function useBranding() {
  const query = useQuery({ queryKey: ['branding'], queryFn: () => api<Branding>('/branding') });
  const accent = query.data?.accent;
  useEffect(() => {
    if (accent) document.documentElement.style.setProperty('--huddle-accent', accent);
  }, [accent]);
  return query;
}

function Welcome() {
  const { data } = useBranding();
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<{ status: string }>('/health') });
  return (
    <main className="grid min-h-full place-items-center p-6">
      <section className="edge w-full max-w-sm rounded-card p-8 text-center">
        <img
          src={data?.logoUrl ?? '/brand/huddle-logo-dark-h64.png'}
          alt={data?.name ?? 'Huddle'}
          className="mx-auto h-8 w-auto"
        />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">{data?.name ?? 'Huddle'}</h1>
        <p className="mt-2 text-muted">The front end is wired to the API.</p>
        <p className="mt-6 text-sm text-meta" role="status">
          API: {health.isPending ? 'checking…' : health.data?.status === 'ok' ? 'connected' : 'not reachable'}
        </p>
      </section>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="*" element={<Welcome />} />
    </Routes>
  );
}
