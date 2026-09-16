import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { apiClient } from '@/api/client';
import { AppLayout } from '@/components/layout/AppLayout';
import { isRestrictedFromBusinessTools } from '@/lib/landing';

export function ProtectedPage({
  children,
  businessToolsOnly = false,
  adminOnly = false,
  requiredModule,
}: {
  children: React.ReactNode;
  businessToolsOnly?: boolean;
  adminOnly?: boolean;
  // Granular RBAC route gate — the AVAILABLE_MODULES key this page belongs
  // to (e.g. "data_sources"). Checked via hasPermission(module, "view") in
  // addition to adminOnly/businessToolsOnly, not instead of them.
  requiredModule?: string;
}) {
  const { user, isAuthenticated, isLoading, hasPermission } = useAuth();
  const router = useRouter();

  // A freshly-hydrated cached session (saved before RBAC shipped, or just
  // not yet revalidated — see AuthContext's background getMe() on load) can
  // briefly have no effective_permissions at all. Treat that as still
  // resolving rather than denied, so a legitimately-authorized user isn't
  // bounced to /no-access for a moment on every load; only a real, loaded
  // "not permitted" result redirects.
  const permissionsPending = !!requiredModule && isAuthenticated && !user?.effective_permissions;
  const lacksModule = !!requiredModule && !permissionsPending && !hasPermission(requiredModule, 'view');

  // M-25: adminOnly must not trust the locally-cached user object (it can
  // be stale, or in principle tampered with client-side) — re-verify
  // against the server via /auth/me before ever rendering admin-only
  // content. null = still checking, true/false = server-confirmed result.
  const [serverAdminVerified, setServerAdminVerified] = useState<boolean | null>(null);

  useEffect(() => {
    if (!adminOnly || !isAuthenticated) {
      setServerAdminVerified(null);
      return;
    }
    let cancelled = false;
    setServerAdminVerified(null);
    apiClient.getMe()
      .then((me) => {
        if (cancelled) return;
        setServerAdminVerified(!!me.is_superuser || me.role === 'admin' || me.role === 'super_admin');
      })
      .catch(() => {
        if (cancelled) return;
        setServerAdminVerified(false);
      });
    return () => { cancelled = true; };
  }, [adminOnly, isAuthenticated]);

  const adminCheckPending = adminOnly && isAuthenticated && serverAdminVerified === null;
  const adminDenied = adminOnly && serverAdminVerified === false;

  useEffect(() => {
    if (isLoading || permissionsPending || adminCheckPending) return;
    if (!isAuthenticated) {
      router.replace('/login');
      return;
    }
    if (adminDenied) {
      router.replace('/no-access');
      return;
    }
    if (lacksModule) {
      router.replace('/no-access');
      return;
    }
    if (businessToolsOnly && isRestrictedFromBusinessTools(user)) {
      router.replace('/no-access');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, permissionsPending, adminCheckPending, isAuthenticated, user, adminDenied, businessToolsOnly, lacksModule]);

  if (
    isLoading ||
    permissionsPending ||
    adminCheckPending ||
    !isAuthenticated ||
    adminDenied ||
    lacksModule ||
    (businessToolsOnly && isRestrictedFromBusinessTools(user))
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 bg-orange-600 rounded-2xl flex items-center justify-center animate-pulse">
            <span className="text-white text-2xl font-bold">BS</span>
          </div>
          <p className="text-gray-500 text-sm">Loading BrandSentry Platform...</p>
        </div>
      </div>
    );
  }

  return <AppLayout>{children}</AppLayout>;
}
