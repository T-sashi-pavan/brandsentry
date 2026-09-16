import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { User } from '@/types';
import { apiClient } from '@/api/client';

export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'brand_market_admin'
  | 'brand_market_user'
  | 'trademark_admin'
  | 'trademark_user'
  | 'business_team'
  | 'trademark_team';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithToken: (tokenVal?: string) => Promise<User>;
  refreshUser: () => Promise<User | null>;
  logout: () => void;
  // Role helpers
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isBrandMarketingAdmin: boolean;
  isBrandMarketingUser: boolean;
  isTrademarkAdmin: boolean;
  isTrademarkUser: boolean;
  canAccessDashboard: boolean;
  canAccessReports: boolean;
  canAccessUserManagement: boolean;
  // Granular RBAC — see backend/app/core/permissions.py for the module/action
  // schema this reads (user.effective_permissions). Super Admin always
  // returns true, unconditionally.
  hasPermission: (module: string, subKey?: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Wipe all per-user UI caches (generated names, analysis, compare, last query…)
// so one user's session never carries over to the next on the same browser.
// Was previously clearing sessionStorage, but every actual write across this
// app (pharma_gen_form, pharma_gen_results, pharma_last_query,
// pharma_active_case_id, pharma_compare_names, pharma_brand_suggestions) uses
// localStorage — sessionStorage is never written to anywhere, so this was a
// silent no-op. pharma_user is excluded since login()/logout() manage it
// explicitly themselves, immediately before/after this call. (The session
// itself no longer lives in localStorage at all — see the httpOnly
// access_token/refresh_token cookies the backend sets — so there's no
// pharma_token key to exclude here any more.)
function clearUserCache() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('pharma_') && k !== 'pharma_user')
      .forEach(k => localStorage.removeItem(k));
  } catch {
    /* localStorage unavailable — nothing to clear */
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Tracks whether we currently believe there's an active session, without
  // relying on a stale closure — used by the focus/visibility revalidation
  // effect below (mounted once, with an empty dep array).
  const hasSessionRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // H-01: the JWT lives only in the httpOnly access_token cookie now —
      // there's nothing in localStorage to read synchronously, so the
      // session is established by asking the server who we are.
      try {
        const me = await apiClient.getMe();
        if (cancelled) return;
        setUser(me);
        hasSessionRef.current = true;
        localStorage.setItem('pharma_user', JSON.stringify(me));
      } catch {
        // access_token cookie may have expired — attempt one silent
        // refresh (rotates both cookies) and retry before giving up.
        try {
          const refreshed = await apiClient.refreshToken();
          if (cancelled) return;
          setToken(refreshed.access_token);
          setUser(refreshed.user);
          hasSessionRef.current = true;
          localStorage.setItem('pharma_user', JSON.stringify(refreshed.user));
        } catch {
          if (cancelled) return;
          setUser(null);
          setToken(null);
          hasSessionRef.current = false;
          localStorage.removeItem('pharma_user');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleRevalidate = () => {
      if (hasSessionRef.current) {
        apiClient.getMe()
          .then((me) => {
            setUser(me);
            localStorage.setItem('pharma_user', JSON.stringify(me));
          })
          .catch(() => { /* keep cached session; normal 401 handling covers expiry */ });
      }
    };

    window.addEventListener('focus', handleRevalidate);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        handleRevalidate();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('focus', handleRevalidate);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    // Defensive: clear any leftover cache before establishing the new session.
    clearUserCache();
    const result = await apiClient.login(email, password);
    setToken(result.access_token);
    setUser(result.user);
    hasSessionRef.current = true;
    localStorage.setItem('pharma_user', JSON.stringify(result.user));
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await apiClient.getMe();
      setUser(me);
      localStorage.setItem('pharma_user', JSON.stringify(me));
      return me;
    } catch {
      return null;
    }
  }, []);

  const loginWithToken = useCallback(async (tokenVal?: string) => {
    clearUserCache();
    if (tokenVal) {
      setToken(tokenVal);
    }
    const me = await apiClient.getMe();
    setUser(me);
    hasSessionRef.current = true;
    localStorage.setItem('pharma_user', JSON.stringify(me));
    return me;
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    hasSessionRef.current = false;
    localStorage.removeItem('pharma_user');
    clearUserCache();
  }, []);

  // Compute granular role flags matching BRD V1.2
  const isSuperAdmin = !!user?.is_superuser || user?.role === 'super_admin';
  const isAdmin = isSuperAdmin || user?.role === 'admin';
  const isBrandMarketingAdmin = user?.role === 'brand_market_admin';
  const isBrandMarketingUser = user?.role === 'brand_market_user' || user?.role === 'business_team';
  const isTrademarkAdmin = user?.role === 'trademark_admin';
  const isTrademarkUser = user?.role === 'trademark_user' || user?.role === 'trademark_team';

  // Granular RBAC (module/action entitlements) — see
  // backend/app/core/permissions.py for the schema this reads. Super Admin
  // is immutable and always passes, before ever consulting the map.
  const hasPermission = (module: string, subKey?: string): boolean => {
    if (isSuperAdmin) return true;
    const perms = user?.effective_permissions;
    if (!perms) return !subKey;
    const modPerms = perms[module];
    if (!modPerms?.enabled) return false;
    if (subKey && !modPerms.actions?.includes(subKey)) return false;
    return true;
  };

  // Page access capabilities — dynamically respects permissions model
  const canAccessDashboard = isSuperAdmin || hasPermission('dashboard');
  const canAccessReports = isSuperAdmin || hasPermission('reports');
  const canAccessUserManagement = isSuperAdmin || hasPermission('user_management');

  return (
    <AuthContext.Provider value={{
      user, token,
      // The access token itself is an httpOnly cookie now — it's never
      // readable from JS, so `token` is only populated transiently (right
      // after login()/refreshToken() return it in the response body) and
      // isn't a reliable signal of an active session on its own (e.g. right
      // after a plain getMe() success on mount, where no token string is
      // returned at all). Session state is authoritatively `user`.
      isAuthenticated: !!user,
      isLoading,
      login, loginWithToken, refreshUser, logout,
      isSuperAdmin,
      isAdmin,
      isBrandMarketingAdmin,
      isBrandMarketingUser,
      isTrademarkAdmin,
      isTrademarkUser,
      canAccessDashboard,
      canAccessReports,
      canAccessUserManagement,
      hasPermission,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
