import { NavLink, Navigate, Route, Routes } from 'react-router';
import { Page } from '@/components/ui/page';
import { useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { AuditTab } from './audit-tab';
import { ExportTab } from './export-tab';
import { ImportTab } from './import-tab';
import { PeopleTab } from './people-tab';
import { UsageTab } from './usage-tab';
import { WebhooksTab } from './webhooks-tab';
import { WorkspaceTab } from './workspace-tab';

const TABS = [
  { path: 'people', label: 'People' },
  { path: 'workspace', label: 'Workspace' },
  { path: 'webhooks', label: 'Webhooks' },
  { path: 'security', label: 'Security log' },
  { path: 'usage', label: 'Usage' },
  { path: 'import', label: 'Import' },
  { path: 'export', label: 'Export' },
];

/** Workspace administration, for owners and admins (the server enforces this on every call too). */
export function AdminPage() {
  const { data: me } = useMe();
  if (!me) return null;
  if (me.role !== 'owner' && me.role !== 'admin') {
    return (
      <Page title="Admin">
        <p className="text-[15px] text-muted">Only owners and admins can manage the workspace.</p>
      </Page>
    );
  }
  return (
    <Page title="Admin">
      <nav aria-label="Admin sections" className="-mx-1 flex gap-1 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <NavLink
            key={t.path}
            to={`/admin/${t.path}`}
            className={({ isActive }) =>
              cn(
                'shrink-0 rounded-pill px-4 py-2 text-sm font-medium transition-colors duration-100',
                isActive ? 'bg-active text-ink' : 'text-muted hover:text-ink',
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route path="people" element={<PeopleTab me={me} />} />
        <Route path="workspace" element={<WorkspaceTab />} />
        <Route path="webhooks" element={<WebhooksTab />} />
        <Route path="security" element={<AuditTab />} />
        <Route path="usage" element={<UsageTab />} />
        <Route path="import" element={<ImportTab isOwner={me.role === 'owner'} />} />
        <Route path="export" element={<ExportTab isOwner={me.role === 'owner'} />} />
        <Route path="*" element={<Navigate to="/admin/people" replace />} />
      </Routes>
    </Page>
  );
}
