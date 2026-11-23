import { Route, Routes } from 'react-router';
import { Gate } from './features/auth/gate';
import { InvitePage, SignInPage } from './features/auth/pages';
import { Shell } from './features/shell/shell';
import { useBranding } from './lib/queries';

export function App() {
  useBranding(); // applies the team's accent colour as early as possible
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route
        path="*"
        element={
          <Gate>
            <Shell />
          </Gate>
        }
      />
    </Routes>
  );
}
