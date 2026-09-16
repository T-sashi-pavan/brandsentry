import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Sparkles,
  Pill,
  X,
  Search,
  GitCompare,
  Database,
  Scale,
  ClipboardList,
  Settings,
  LayoutDashboard,
  Users,
  FileSpreadsheet,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';

export function Sidebar({
  mobileOpen = false,
  onMobileClose,
  collapsed = false,
  onToggleCollapse,
}: {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const auth = useAuth();
  const { isSuperAdmin, isAdmin, isBrandMarketingAdmin, isBrandMarketingUser, isTrademarkAdmin, canAccessDashboard, canAccessReports, hasPermission } = auth;
  const router = useRouter();
  const isBrandMarketing = isBrandMarketingAdmin || isBrandMarketingUser;

  // Define nav items with role-based visibility according to BRD Table 5.2.12,
  // additionally gated by the granular RBAC module grant (a Super Admin can
  // still hide a route for a specific user via custom_permissions even
  // though their role would otherwise show it).
  const navItems = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', description: isSuperAdmin ? 'Enterprise Overview' : isBrandMarketingAdmin ? 'Marketing Overview' : isTrademarkAdmin ? 'IP Overview' : 'Admin Overview', show: hasPermission('dashboard') },
    { to: '/generator', icon: Sparkles, label: 'AI Name Generator', description: 'Generate brand names', show: hasPermission('generator') },
    { to: '/brand-analysis', icon: Search, label: 'Brand Analysis', description: 'Screen & market insights', show: hasPermission('brand_analysis') },
    { to: '/compare', icon: GitCompare, label: 'Compare Names', description: 'Side-by-side comparison', show: hasPermission('compare') },
    { to: '/trademark-review', icon: Scale, label: isBrandMarketing ? 'Submission Status' : 'Trademark Review', description: isBrandMarketing ? 'Track IP clearance status' : 'IP Clearance queue', show: hasPermission('trademark_review') },
    { to: '/reports', icon: FileSpreadsheet, label: 'Reports', description: 'Business reports & export', show: hasPermission('reports'), badge: 'MIS' },
    { to: '/data-sources', icon: Database, label: 'Data Sources', description: 'Integrations & APIs', show: hasPermission('data_sources') },
    { to: '/audit-trail', icon: ClipboardList, label: 'Audit Trail', description: 'Activity history', show: hasPermission('audit_trail') },
    { to: '/settings', icon: Settings, label: 'Settings', description: 'Configuration', show: hasPermission('settings') },
    { to: '/user-management', icon: Users, label: 'User Management', description: 'Manage platform users', show: (isSuperAdmin || hasPermission('user_management')), badge: 'SUPER ADMIN' },
  ].filter(item => item.show);

  return (
    <>
      {/* Backdrop for mobile */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          'flex flex-col bg-white border-r border-orange-100 h-screen',
          'fixed top-0 left-0 z-50 w-72 transition-transform duration-300 ease-in-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:sticky lg:top-0 lg:translate-x-0 lg:h-full lg:transition-[width] lg:duration-200',
          collapsed ? 'lg:w-20' : 'lg:w-64'
        )}
      >
        {/* Logo Header */}
        <div className={cn(
          'flex items-center min-h-16 py-3 border-b border-orange-700 bg-orange-600 flex-shrink-0',
          collapsed ? 'justify-between px-3 lg:justify-center lg:px-2' : 'justify-between px-5'
        )}>
          <div className={cn('flex items-center gap-3 min-w-0', collapsed && 'lg:gap-0')}>
            <div className="flex-shrink-0 w-9 h-9 bg-white/20 rounded-xl flex items-center justify-center">
              <Pill className="w-5 h-5 text-white" />
            </div>
            <div className={cn('min-w-0', collapsed && 'lg:hidden')}>
              <p className="text-white font-bold text-base leading-snug truncate">BrandSentry</p>
              <p className="text-orange-100 text-[11px] leading-snug truncate mt-0.5 pb-0.5">Brand Intelligence Platform</p>
            </div>
          </div>
          {/* Close button for mobile */}
          <button
            onClick={onMobileClose}
            className="lg:hidden flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-white/80 hover:bg-white/10 hover:text-white transition-colors"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Collapse toggle (desktop only) */}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="hidden lg:flex absolute top-16 right-0 translate-x-1/2 z-10 w-6 h-6 items-center justify-center rounded-full bg-white border border-gray-200 text-gray-400 shadow-sm hover:text-orange-600 hover:border-orange-300 transition-colors"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          <p className={cn('text-[11px] font-bold text-gray-400 uppercase tracking-wider px-2 mb-2', collapsed && 'lg:hidden')}>
            Main Menu
          </p>
          {navItems.map(({ to, icon: Icon, label, description, badge }) => {
            const isActive = router.pathname === to || (to !== '/' && router.pathname.startsWith(to));

            return (
              <Link
                key={to}
                href={to}
                onClick={onMobileClose}
                title={collapsed ? label : undefined}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-150 group',
                  collapsed && 'lg:justify-center lg:px-2',
                  isActive
                    ? 'bg-orange-50 text-orange-800 font-semibold'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                )}
              >
                <Icon
                  className={cn(
                    'flex-shrink-0 w-5 h-5 transition-colors',
                    isActive ? 'text-orange-600' : 'text-gray-400 group-hover:text-gray-600'
                  )}
                />
                <div className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate">{label}</span>
                    {badge && (
                      <span className={cn(
                        "px-1.5 py-0.2 rounded text-[10px] font-bold tracking-wide",
                        badge === 'SUPER ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'
                      )}>
                        {badge}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 truncate">{description}</div>
                </div>
                {isActive && (
                  <div className={cn('ml-auto w-1.5 h-1.5 rounded-full bg-orange-600 flex-shrink-0', collapsed && 'lg:hidden')} />
                )}
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
