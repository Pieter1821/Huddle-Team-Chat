import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useMe, useSetupStatus } from '@/lib/queries';
import { NamePrompt, NotAMember, SetupPage } from './pages';

/**
 * Decides what a visitor sees before the app itself:
 * signed out → sign-in; signed in before first-run setup → setup; signed in but not a member →
 * an explanation; no display name yet → the name prompt; otherwise the app.
 */
export function Gate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const me = useMe();
  const signedInNonMember = me.error?.status === 403;
  const setup = useSetupStatus(signedInNonMember);

  if (me.isPending || (signedInNonMember && setup.isPending)) return <Splash />;

  if (me.error?.status === 401) {
    const here = location.pathname + location.search;
    return <Navigate to={here === '/' ? '/signin' : `/signin?next=${encodeURIComponent(here)}`} replace />;
  }
  if (signedInNonMember) {
    if (setup.data?.needsSetup) return <SetupPage />;
    return <NotAMember message={me.error?.message ?? 'You can’t open this workspace.'} />;
  }
  if (me.error || !me.data) {
    return <NotAMember message="Huddle couldn’t reach its server. Check your connection and reload." />;
  }
  if (me.data.needsName) return <NamePrompt />;
  return <>{children}</>;
}

function Splash() {
  return (
    <div className="grid min-h-full place-items-center" role="status" aria-label="Loading">
      <img
        src="/brand/huddle-mark-64.png"
        alt=""
        className="size-10 animate-pulse motion-reduce:animate-none"
      />
    </div>
  );
}
