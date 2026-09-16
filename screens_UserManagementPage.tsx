import React, { useState, useMemo } from 'react';
import { usePersistentState } from '@/lib/usePersistentState';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Users,
  Plus,
  Pencil,
  Ban,
  CheckCircle2,
  Trash2,
  Shield,
  Search,
  Loader2,
  AlertTriangle,
  Eye,
  EyeOff,
  X,
  Check,
  ChevronDown,
  RotateCcw,
  Lock,
  KeyRound,
  RefreshCw,
} from 'lucide-react';
import { apiClient } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn, formatDate } from '@/lib/utils';
import type { User, PermissionMap } from '@/types';

// ── Granular RBAC — Module & Feature Access Controller ─────────────────────
// Labels are cosmetic only; the actual module/action keys come from the
// backend's AVAILABLE_MODULES (app/core/permissions.py) via
// GET /admin/permissions/schema, so this UI never drifts from what the
// server actually enforces.

const MODULE_LABELS: Record<string, string> = {
  topbar: 'Global Topbar',
  dashboard: 'Dashboard',
  generator: 'AI Name Generator',
  brand_analysis: 'Brand Analysis',
  compare: 'Compare Names',
  trademark_review: 'Trademark Review',
  reports: 'Reports & MIS',
  data_sources: 'Data Sources',
  audit_trail: 'Audit Trail',
  settings: 'Settings',
  user_management: 'User Management',
};

const ACTION_LABELS: Record<string, string> = {
  review_cart: 'Review Batch Cart icon',
  notifications_bell: 'Notification Bell',
  view: 'View / access this page',
  ai_tokens_tab: 'AI Token Operations tab',
  export_reports: 'Export reports',
  generate_names: 'Generate names',
  add_to_cart: 'Add to cart',
  run_analysis: 'Run analysis',
  export_pdf: 'Export PDF',
  run_compare: 'Run compare',
  export_excel: 'Export Excel',
  action_approve: 'Approve action',
  action_reject: 'Reject action',
  chat_drawer: 'Chat / discussion drawer',
  export_mis: 'Export MIS',
  view_financials: 'View financials',
  sync_sources: 'Sync data sources',
  configure_apis: 'Configure APIs',
  export_logs: 'Export logs',
  modify_thresholds: 'Modify thresholds',
  manage_users: 'Create / edit / delete users',
};

function fullPermissionMap(modules: Record<string, string[]>, allEnabled: boolean): PermissionMap {
  const map: PermissionMap = {};
  for (const [mod, actions] of Object.entries(modules)) {
    map[mod] = { enabled: allEnabled, actions: allEnabled ? [...actions] : [] };
  }
  return map;
}

function clonePermissionMap(map: PermissionMap): PermissionMap {
  const out: PermissionMap = {};
  for (const [mod, v] of Object.entries(map)) out[mod] = { enabled: v.enabled, actions: [...(v.actions || [])] };
  return out;
}

export function arePermissionMapsEqual(a?: PermissionMap | null, b?: PermissionMap | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  const allKeys = Array.from(new Set([...aKeys, ...bKeys]));
  for (const k of allKeys) {
    const valA = a[k];
    const valB = b[k];
    const enabledA = !!valA?.enabled;
    const enabledB = !!valB?.enabled;
    if (enabledA !== enabledB) return false;
    const actionsA = (valA?.actions || []).slice().sort();
    const actionsB = (valB?.actions || []).slice().sort();
    if (actionsA.length !== actionsB.length) return false;
    for (let i = 0; i < actionsA.length; i++) {
      if (actionsA[i] !== actionsB[i]) return false;
    }
  }
  return true;
}

function PermissionMatrix({
  modules,
  permissions,
  locked,
  onToggleModule,
  onToggleAction,
}: {
  modules: Record<string, string[]>;
  permissions: PermissionMap;
  locked: boolean;
  onToggleModule: (mod: string) => void;
  onToggleAction: (mod: string, action: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(Object.keys(modules)));
  const toggleExpanded = (mod: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(mod)) next.delete(mod); else next.add(mod);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {Object.entries(modules).map(([mod, actions]) => {
        const modPerm = permissions[mod] || { enabled: false, actions: [] };
        const isExpanded = expanded.has(mod);
        return (
          <div key={mod} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-50/70">
              <button
                type="button"
                onClick={() => !locked && onToggleModule(mod)}
                disabled={locked}
                title="Enable module"
                className={cn(
                  'flex items-center justify-center w-4 h-4 rounded border flex-shrink-0 transition-colors',
                  modPerm.enabled ? 'bg-orange-600 border-orange-600 text-white' : 'bg-white border-gray-300',
                  locked ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer'
                )}
              >
                {modPerm.enabled && <Check className="w-3 h-3" />}
              </button>
              <button
                type="button"
                onClick={() => toggleExpanded(mod)}
                className="flex-1 flex items-center justify-between text-left cursor-pointer"
              >
                <span className="text-xs font-bold text-gray-800">{MODULE_LABELS[mod] || mod}</span>
                <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform', isExpanded && 'rotate-180')} />
              </button>
            </div>
            {isExpanded && actions.length > 0 && (
              <div className="px-3 py-2 space-y-1.5 border-t border-gray-100">
                {actions.map((action) => {
                  const checked = modPerm.actions.includes(action);
                  const itemDisabled = locked || !modPerm.enabled;
                  return (
                    <label
                      key={action}
                      className={cn('flex items-center gap-2 text-xs', itemDisabled ? 'text-gray-400' : 'text-gray-700 cursor-pointer')}
                    >
                      <button
                        type="button"
                        onClick={() => !itemDisabled && onToggleAction(mod, action)}
                        disabled={itemDisabled}
                        className={cn(
                          'flex items-center justify-center w-3.5 h-3.5 rounded border flex-shrink-0 transition-colors',
                          checked ? 'bg-orange-500 border-orange-500 text-white' : 'bg-white border-gray-300',
                          itemDisabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
                        )}
                      >
                        {checked && <Check className="w-2.5 h-2.5" />}
                      </button>
                      {ACTION_LABELS[action] || action}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Helper to format role names cleanly according to BRD V1.2
function getRoleDisplay(role: string | null | undefined, isSuperuser: boolean) {
  if (isSuperuser || role === 'super_admin') {
    return { label: 'Super Admin', color: 'bg-purple-100 text-purple-800 border-purple-200' };
  }
  if (!role) {
    return { label: 'Unassigned', color: 'bg-gray-100 text-gray-700 border-gray-200' };
  }
  if (role === 'admin') {
    return { label: 'Admin', color: 'bg-orange-100 text-orange-800 border-orange-200' };
  }
  if (role === 'brand_market_admin') {
    return { label: 'Brand Marketing Admin', color: 'bg-blue-100 text-blue-800 border-blue-200' };
  }
  if (role === 'brand_market_user' || role === 'business_team' || role === 'brand_marketing') {
    return { label: 'Brand Marketing User', color: 'bg-indigo-100 text-indigo-800 border-indigo-200' };
  }
  if (role === 'trademark_admin') {
    return { label: 'Trademark Admin', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
  }
  if (role === 'trademark_user' || role === 'trademark_team') {
    return { label: 'Trademark User', color: 'bg-teal-100 text-teal-800 border-teal-200' };
  }
  const formatted = role.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
  return { label: formatted || 'Unassigned', color: 'bg-gray-100 text-gray-800 border-gray-200' };
}

function normalizeRoleValue(role: string | null | undefined, isSuperuser?: boolean): string {
  if (isSuperuser || role === 'super_admin') return 'super_admin';
  if (role === 'business_team' || role === 'brand_marketing') return 'brand_market_user';
  if (role === 'trademark_team') return 'trademark_user';
  if (role === 'admin' || role === 'brand_market_admin' || role === 'brand_market_user' || role === 'trademark_admin' || role === 'trademark_user') {
    return role;
  }
  return 'brand_market_user';
}

const EMPTY_FORM = {
  full_name: '',
  email: '',
  password: '',
  role: 'brand_market_user',
  department: '',
  is_superuser: false,
  is_active: true,
};

type UserFormData = typeof EMPTY_FORM;

interface UserFormModalProps {
  open: boolean;
  onClose: () => void;
  editingUser: User | null;
}

function UserFormModal({ open, onClose, editingUser }: UserFormModalProps) {
  const qc = useQueryClient();
  const { user: currentAuthUser, refreshUser } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState<UserFormData>(() =>
    editingUser
      ? {
          full_name: editingUser.full_name,
          email: editingUser.email,
          password: '',
          role: normalizeRoleValue(editingUser.role, editingUser.is_superuser),
          department: editingUser.department || '',
          is_superuser: editingUser.is_superuser || editingUser.role === 'super_admin',
          is_active: editingUser.is_active,
        }
      : { ...EMPTY_FORM }
  );

  const [errors, setErrors] = useState<Partial<Record<keyof UserFormData, string>>>({});

  // Module & Feature Access Controller state — see PermissionMatrix above.
  const schemaQuery = useQuery({
    queryKey: ['permissions-schema'],
    queryFn: () => apiClient.getPermissionsSchema(),
    staleTime: 5 * 60 * 1000,
  });
  const [permissions, setPermissions] = useState<PermissionMap>({});
  const [baselinePermissions, setBaselinePermissions] = useState<PermissionMap>({});
  const [explicitReset, setExplicitReset] = useState(false);

  const permissionsDirty = useMemo(() => {
    return !arePermissionMapsEqual(permissions, baselinePermissions);
  }, [permissions, baselinePermissions]);

  const applyRoleDefaults = (role: string) => {
    if (!schemaQuery.data) return;
    const defaults = role === 'super_admin'
      ? fullPermissionMap(schemaQuery.data.available_modules, true)
      : (schemaQuery.data.role_defaults[role]
          ? clonePermissionMap(schemaQuery.data.role_defaults[role])
          : fullPermissionMap(schemaQuery.data.available_modules, false));
    setPermissions(defaults);
    setBaselinePermissions(defaults);
  };

  // Reset form when modal opens or editing user changes
  React.useEffect(() => {
    setShowPassword(false);
    const initialRole = editingUser ? normalizeRoleValue(editingUser.role, editingUser.is_superuser) : EMPTY_FORM.role;
    if (editingUser) {
      setForm({
        full_name: editingUser.full_name,
        email: editingUser.email,
        password: '',
        role: initialRole,
        department: editingUser.department || '',
        is_superuser: editingUser.is_superuser || editingUser.role === 'super_admin',
        is_active: editingUser.is_active,
      });
    } else {
      setForm({ ...EMPTY_FORM });
    }
    setErrors({});
    setExplicitReset(false);
    if (schemaQuery.data) {
      let initialPerms: PermissionMap;
      if (initialRole === 'super_admin') {
        initialPerms = fullPermissionMap(schemaQuery.data.available_modules, true);
      } else if (editingUser?.custom_permissions) {
        initialPerms = clonePermissionMap(editingUser.custom_permissions);
      } else {
        initialPerms = schemaQuery.data.role_defaults[initialRole]
          ? clonePermissionMap(schemaQuery.data.role_defaults[initialRole])
          : fullPermissionMap(schemaQuery.data.available_modules, false);
      }
      setPermissions(initialPerms);
      setBaselinePermissions(initialPerms);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingUser, open, schemaQuery.data]);

  const handleRoleChange = (v: string) => {
    setForm({ ...form, role: v, is_superuser: v === 'super_admin' });
    applyRoleDefaults(v);
    setExplicitReset(false);
  };

  const toggleModule = (mod: string) => {
    setPermissions((prev) => {
      const next = clonePermissionMap(prev);
      const cur = next[mod] || { enabled: false, actions: [] };
      next[mod] = { enabled: !cur.enabled, actions: cur.actions };
      return next;
    });
    setExplicitReset(false);
  };

  const toggleAction = (mod: string, action: string) => {
    setPermissions((prev) => {
      const next = clonePermissionMap(prev);
      const cur = next[mod] || { enabled: true, actions: [] };
      const has = cur.actions.includes(action);
      next[mod] = { enabled: cur.enabled, actions: has ? cur.actions.filter((a) => a !== action) : [...cur.actions, action] };
      return next;
    });
    setExplicitReset(false);
  };

  const resetPermissionsToRoleDefaults = () => {
    applyRoleDefaults(form.role);
    setExplicitReset(true);
  };

  const isSuperAdminRole = form.role === 'super_admin';
  const isEditingSelf = !!editingUser && editingUser.id === currentAuthUser?.id;

  const createMutation = useMutation({
    mutationFn: (d: UserFormData) => {
      const isSuper = d.role === 'super_admin' || d.is_superuser;
      return apiClient.createAdminUser({
        email: d.email.trim(),
        full_name: d.full_name.trim(),
        password: d.password,
        role: d.role,
        department: d.department.trim() || undefined,
        is_superuser: isSuper,
        custom_permissions: !isSuper && permissionsDirty ? permissions : undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success('User created successfully');
      onClose();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || 'Failed to create user');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (d: UserFormData) => {
      const isSuper = d.role === 'super_admin' || d.is_superuser;
      return apiClient.updateAdminUser(editingUser!.id, {
        full_name: d.full_name.trim(),
        role: d.role,
        department: d.department.trim() || undefined,
        is_active: d.is_active,
        is_superuser: isSuper,
        custom_permissions: !isSuper && permissionsDirty ? permissions : undefined,
        reset_permissions: !isSuper && explicitReset,
      });
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success('User updated successfully');
      if (isEditingSelf) await refreshUser();
      onClose();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || 'Failed to update user');
    },
  });

  const validate = () => {
    const errs: Partial<Record<keyof UserFormData, string>> = {};
    if (!form.full_name.trim()) errs.full_name = 'Full name is required';
    if (!form.email.trim() || !/^\S+@\S+\.\S+$/.test(form.email)) errs.email = 'Valid email is required'; // NOSONAR - fixed-width class, not backtracking-prone
    if (!editingUser) {
      if (!form.password) errs.password = 'Password is required'; // NOSONAR - form validation check, not a hardcoded credential
      else if (form.password.length < 8) errs.password = 'Password must be at least 8 characters'; // NOSONAR - form validation check, not a hardcoded credential
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    if (editingUser) {
      updateMutation.mutate(form);
    } else {
      createMutation.mutate(form);
    }
  };

  const isBusy = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !isBusy) onClose(); }}>
      <DialogContent className="max-w-4xl p-0 bg-white max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-gray-100 flex-shrink-0">
          <DialogTitle className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-orange-100 flex items-center justify-center text-orange-600">
              <Users className="w-4 h-4" />
            </div>
            {editingUser ? 'Edit User' : 'Add New User'}
          </DialogTitle>
        </DialogHeader>

        <form id="user-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left column — identity & role */}
            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1 block">
                  Full Name *
                </label>
                <Input
                  value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                  placeholder="e.g. John Deo"
                  className={cn('text-xs h-9', errors.full_name && 'border-red-400 focus-visible:ring-red-400')}
                />
                {errors.full_name && <p className="text-[11px] text-red-500 mt-1">{errors.full_name}</p>}
              </div>

              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1 block">
                  Email Address *
                </label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="e.g. analyst@pharmabi.com"
                  disabled={!!editingUser}
                  className={cn(
                    'text-xs h-9',
                    editingUser && 'bg-gray-100 cursor-not-allowed',
                    errors.email && 'border-red-400 focus-visible:ring-red-400'
                  )}
                />
                {errors.email && <p className="text-[11px] text-red-500 mt-1">{errors.email}</p>}
              </div>

              {!editingUser && (
                <div>
                  <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1 block">
                    Password *
                  </label>
                  <div className="relative">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder="Min. 8 characters"
                      className={cn('text-xs h-9 pr-9', errors.password && 'border-red-400 focus-visible:ring-red-400')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded-md hover:bg-gray-100 transition-colors"
                      title={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {errors.password && <p className="text-[11px] text-red-500 mt-1">{errors.password}</p>}
                </div>
              )}

              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1 block">
                  Assigned Role *
                </label>
                <Select value={form.role} onValueChange={handleRoleChange}>
                  <SelectTrigger className="text-xs h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="super_admin">Super Admin (Platform Owner)</SelectItem>
                    <SelectItem value="admin">Admin (Operations Lead)</SelectItem>
                    <SelectItem value="brand_market_admin">Brand Marketing Team Admin</SelectItem>
                    <SelectItem value="brand_market_user">Brand Marketing Team User</SelectItem>
                    <SelectItem value="trademark_admin">Trademark Team Admin</SelectItem>
                    <SelectItem value="trademark_user">Trademark Team User</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1 block">
                  Department
                </label>
                <Input
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  placeholder="e.g. Business Team, Trademark Reviewer"
                  className="text-xs h-9"
                />
              </div>

              {editingUser && (
                <div className="flex items-center justify-between p-3.5 bg-gray-50 border border-gray-200 rounded-xl">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-bold text-gray-800">Account Status</p>
                      <span
                        className={cn(
                          'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase border',
                          form.is_active
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-gray-100 text-gray-600 border-gray-200'
                        )}
                      >
                        {form.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400">
                      {form.is_active ? 'Account is active and permitted to log in.' : 'Account is deactivated and blocked from logging in.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={form.is_active}
                    onClick={() => setForm({ ...form, is_active: !form.is_active })}
                    disabled={isEditingSelf}
                    title={isEditingSelf ? "You cannot deactivate your own account" : undefined}
                    className={cn(
                      'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2',
                      form.is_active ? 'bg-emerald-600' : 'bg-gray-300',
                      isEditingSelf && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <span className="sr-only">Toggle account active status</span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out',
                        form.is_active ? 'translate-x-5' : 'translate-x-0'
                      )}
                    />
                  </button>
                </div>
              )}
            </div>

            {/* Right column — Module & Feature Access Controller */}
            <div className="space-y-2 lg:border-l lg:border-gray-100 lg:pl-6">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider">
                  Module &amp; Feature Access
                </label>
                {!isSuperAdminRole && (
                  <button
                    type="button"
                    onClick={resetPermissionsToRoleDefaults}
                    className="text-[11px] font-semibold text-orange-600 hover:text-orange-700 flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" /> Reset to Role Defaults
                  </button>
                )}
              </div>

              {isSuperAdminRole ? (
                <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg flex items-start gap-2.5">
                  <Lock className="w-4 h-4 text-purple-600 flex-shrink-0 mt-0.5" />
                  <p className="text-xs font-semibold text-purple-800">
                    Super Admin has permanent full system access
                  </p>
                </div>
              ) : schemaQuery.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-gray-400 py-6 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading permission schema...
                </div>
              ) : schemaQuery.data ? (
                <div className="max-h-[420px] overflow-y-auto pr-1">
                  <PermissionMatrix
                    modules={schemaQuery.data.available_modules}
                    permissions={permissions}
                    locked={false}
                    onToggleModule={toggleModule}
                    onToggleAction={toggleAction}
                  />
                </div>
              ) : (
                <p className="text-xs text-red-500 py-4">Could not load the permission schema.</p>
              )}
            </div>
          </div>
        </form>

        <DialogFooter className="px-6 py-4 border-t border-gray-100 gap-2 flex-shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={isBusy}
            className="text-xs h-9"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="user-form"
            size="sm"
            disabled={isBusy}
            className="text-xs h-9 bg-orange-600 hover:bg-orange-700 text-white font-semibold gap-1.5"
          >
            {isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {editingUser ? 'Save Changes' : 'Create User'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Super Admin Reset Password Modal ──────────────────────────────────────
interface ResetPasswordModalProps {
  user: User | null;
  open: boolean;
  onClose: () => void;
}

function ResetPasswordModal({ user, open, onClose }: ResetPasswordModalProps) {
  const qc = useQueryClient();
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  React.useEffect(() => {
    if (open) {
      setNewPassword('');
      setShowPassword(false);
      setError('');
    }
  }, [open]);

  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
    let pwd = '';
    for (let i = 0; i < 12; i++) {
      pwd += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setNewPassword(pwd);
    setShowPassword(true);
    setError('');
  };

  const resetMutation = useMutation({
    mutationFn: (pwd: string) => apiClient.resetAdminUserPassword(user!.id, pwd),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success(res?.message || `Password reset successfully for ${user?.full_name || user?.email}`);
      onClose();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || 'Failed to reset password');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    resetMutation.mutate(newPassword);
  };

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !resetMutation.isPending) onClose(); }}>
      <DialogContent className="max-w-md p-6 bg-white">
        <DialogHeader>
          <DialogTitle className="text-base font-bold text-gray-900 flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600">
              <KeyRound className="w-4 h-4" />
            </div>
            Reset User Password
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="p-3 bg-gray-50 rounded-lg border border-gray-100 space-y-1">
            <p className="text-xs text-gray-500 font-medium">Target User</p>
            <p className="text-sm font-semibold text-gray-900">{user.full_name}</p>
            <p className="text-xs text-gray-500">{user.email}</p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-gray-700">New Password</label>
              <button
                type="button"
                onClick={generatePassword}
                className="text-[11px] text-orange-600 hover:text-orange-700 font-semibold flex items-center gap-1 hover:underline"
              >
                <RefreshCw className="w-3 h-3" />
                Generate Secure Password
              </button>
            </div>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  if (error) setError('');
                }}
                placeholder="Enter at least 8 characters..."
                className="pr-10 text-xs h-9"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {error && <p className="text-[11px] text-red-500 font-medium">{error}</p>}
            <p className="text-[11px] text-gray-400">
              The user will need to log in with this new password. Any active sessions for this user will be invalidated.
            </p>
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={resetMutation.isPending}
              className="text-xs h-9"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={resetMutation.isPending}
              className="text-xs h-9 bg-blue-600 hover:bg-blue-700 text-white font-semibold gap-1.5"
            >
              {resetMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Reset Password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Role Permissions tab — edits the default template shared by every user
// assigned a role (distinct from the per-user override in UserFormModal).
// ─────────────────────────────────────────────────────────────────────────

const EDITABLE_ROLES = [
  { value: 'admin', label: 'Admin (Operations Lead)' },
  { value: 'brand_market_admin', label: 'Brand Marketing Team Admin' },
  { value: 'brand_market_user', label: 'Brand Marketing Team User' },
  { value: 'trademark_admin', label: 'Trademark Team Admin' },
  { value: 'trademark_user', label: 'Trademark Team User' },
];

function RolePermissionsTab() {
  const qc = useQueryClient();
  const { user: currentAuthUser, refreshUser } = useAuth();
  const [selectedRole, setSelectedRole] = useState(EDITABLE_ROLES[0].value);
  const [permissions, setPermissions] = useState<PermissionMap>({});

  const schemaQuery = useQuery({
    queryKey: ['permissions-schema'],
    queryFn: () => apiClient.getPermissionsSchema(),
    staleTime: 5 * 60 * 1000,
  });

  const savedTemplate = schemaQuery.data?.role_defaults?.[selectedRole];

  // Load the selected role's current template whenever the selection
  // changes or the schema (re)loads
  React.useEffect(() => {
    if (savedTemplate) {
      setPermissions(clonePermissionMap(savedTemplate));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRole, schemaQuery.data]);

  // Dirty is dynamically computed by comparing current permissions to savedTemplate!
  // If user deselects and then re-selects the same option, it matches savedTemplate and dirty becomes false!
  const isDirty = useMemo(() => {
    if (!savedTemplate) return false;
    return !arePermissionMapsEqual(permissions, savedTemplate);
  }, [permissions, savedTemplate]);

  const toggleModule = (mod: string) => {
    setPermissions((prev) => {
      const next = clonePermissionMap(prev);
      const cur = next[mod] || { enabled: false, actions: [] };
      next[mod] = { enabled: !cur.enabled, actions: cur.actions };
      return next;
    });
  };

  const toggleAction = (mod: string, action: string) => {
    setPermissions((prev) => {
      const next = clonePermissionMap(prev);
      const cur = next[mod] || { enabled: true, actions: [] };
      const has = cur.actions.includes(action);
      next[mod] = { enabled: cur.enabled, actions: has ? cur.actions.filter((a) => a !== action) : [...cur.actions, action] };
      return next;
    });
  };

  const saveMutation = useMutation({
    mutationFn: () => apiClient.updateRolePermissions(selectedRole, permissions),
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ['permissions-schema'] });
      if (currentAuthUser?.role === selectedRole) {
        await refreshUser();
      }
      toast.success(`Default permissions updated for ${EDITABLE_ROLES.find((r) => r.value === selectedRole)?.label || selectedRole}`);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || 'Failed to update role permissions');
    },
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
      {/* Role picker */}
      <div className="space-y-1.5">
        <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Select a Role to Edit</p>
        {EDITABLE_ROLES.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => setSelectedRole(r.value)}
            className={cn(
              'w-full text-left px-3 py-2.5 rounded-lg text-xs font-semibold transition-colors border',
              selectedRole === r.value
                ? 'bg-orange-50 border-orange-200 text-orange-800'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            )}
          >
            {r.label}
          </button>
        ))}
        <div className="mt-3 p-3 bg-purple-50 border border-purple-200 rounded-lg flex items-start gap-2">
          <Lock className="w-3.5 h-3.5 text-purple-600 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-purple-800 font-medium">
            Super Admin isn't listed here — its access is permanent and can't be edited.
          </p>
        </div>
      </div>

      {/* Matrix for the selected role */}
      <Card className="border border-gray-200/80 bg-white shadow-sm">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-gray-900">
                {EDITABLE_ROLES.find((r) => r.value === selectedRole)?.label}
              </p>
              <p className="text-[11px] text-gray-400 mt-0.5">
                Changes apply to every user currently assigned this role, unless they have an individual override.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={!isDirty || saveMutation.isPending}
              className="text-xs h-8 bg-orange-600 hover:bg-orange-700 text-white font-semibold gap-1.5 flex-shrink-0"
            >
              {saveMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save Role Defaults
            </Button>
          </div>

          {schemaQuery.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-gray-400 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading permission schema...
            </div>
          ) : schemaQuery.data ? (
            <PermissionMatrix
              modules={schemaQuery.data.available_modules}
              permissions={permissions}
              locked={false}
              onToggleModule={toggleModule}
              onToggleAction={toggleAction}
            />
          ) : (
            <p className="text-xs text-red-500 py-4">Could not load the permission schema.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function UserManagementPage() {
  const { user: currentUser, isSuperAdmin, hasPermission } = useAuth();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState<'users' | 'role_permissions'>('users');
  const [searchTerm, setSearchTerm] = usePersistentState('brandsentry_filter_user_search', '');
  const [roleFilter, setRoleFilter] = usePersistentState('brandsentry_filter_user_role', 'all');
  const [statusFilter, setStatusFilter] = usePersistentState('brandsentry_filter_user_status', 'all');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const [toggleTarget, setToggleTarget] = useState<User | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [resetPasswordTarget, setResetPasswordTarget] = useState<User | null>(null);

  const hasActiveFilters = Boolean(searchTerm.trim() || roleFilter !== 'all' || statusFilter !== 'all');

  const handleClearFilters = () => {
    setSearchTerm('');
    setRoleFilter('all');
    setStatusFilter('all');
  };

  // Fetch users list
  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => apiClient.getAdminUsers(),
  });

  // Toggle user active status
  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      apiClient.updateAdminUser(id, { is_active }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success(vars.is_active ? 'User activated' : 'User deactivated');
      setToggleTarget(null);
    },
    onError: () => {
      toast.error('Failed to update user status');
    },
  });

  // Delete user mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiClient.deleteAdminUser(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success('User permanently deleted');
      setDeleteTarget(null);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || 'Failed to delete user');
    },
  });

  const openCreateModal = () => {
    setEditingUser(null);
    setIsModalOpen(true);
  };

  const openEditModal = (user: User) => {
    setEditingUser(user);
    setIsModalOpen(true);
  };

  // KPI Calculations
  const totalUsers = users.length;
  const adminCount = users.filter((u) => u.is_superuser || u.role === 'super_admin' || u.role === 'admin').length;
  const brandMarketingCount = users.filter(
    (u) => !u.is_superuser && (u.role === 'brand_market_admin' || u.role === 'brand_market_user' || u.role === 'business_team' || u.role === 'brand_marketing')
  ).length;
  const trademarkTeamCount = users.filter(
    (u) => !u.is_superuser && (u.role === 'trademark_admin' || u.role === 'trademark_user' || u.role === 'trademark_team')
  ).length;

  // If not super admin, display restricted banner
  if (!isSuperAdmin) {
    return (
      <div className="p-8 max-w-2xl mx-auto my-12 text-center bg-white border border-gray-200 rounded-xl shadow-sm space-y-4">
        <div className="w-12 h-12 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center mx-auto">
          <Shield className="w-6 h-6" />
        </div>
        <h2 className="text-xl font-bold text-gray-900">Super Admin Privileges Required</h2>
        <p className="text-sm text-gray-500">
          User Management and Role Assignment are restricted to Super Administrators per Section 5.2.12 of the BrandSentry BRD.
        </p>
      </div>
    );
  }

  // Filtered Users list
  const filteredUsers = users.filter((u) => {
    // Search query match
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const matchName = u.full_name?.toLowerCase().includes(q);
      const matchEmail = u.email?.toLowerCase().includes(q);
      const matchDept = u.department?.toLowerCase().includes(q);
      if (!matchName && !matchEmail && !matchDept) return false;
    }

    // Role filter
    if (roleFilter !== 'all') {
      if (roleFilter === 'super_admin' && !(u.is_superuser || u.role === 'super_admin')) return false;
      if (roleFilter === 'admin' && (u.is_superuser || u.role !== 'admin')) return false;
      if (roleFilter === 'brand_market_admin' && u.role !== 'brand_market_admin') return false;
      if (roleFilter === 'brand_market_user' && u.role !== 'brand_market_user' && u.role !== 'business_team') return false;
      if (roleFilter === 'trademark_admin' && u.role !== 'trademark_admin') return false;
      if (roleFilter === 'trademark_user' && u.role !== 'trademark_user' && u.role !== 'trademark_team') return false;
    }

    // Status filter
    if (statusFilter !== 'all') {
      if (statusFilter === 'active' && !u.is_active) return false;
      if (statusFilter === 'inactive' && u.is_active) return false;
    }

    return true;
  });

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-6">

      {/* Tab Switcher — per-user accounts vs. per-role default templates */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        <button
          type="button"
          onClick={() => setActiveTab('users')}
          className={cn(
            'px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors',
            activeTab === 'users' ? 'border-orange-600 text-orange-700' : 'border-transparent text-gray-500 hover:text-gray-800'
          )}
        >
          Users
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('role_permissions')}
          className={cn(
            'px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors',
            activeTab === 'role_permissions' ? 'border-orange-600 text-orange-700' : 'border-transparent text-gray-500 hover:text-gray-800'
          )}
        >
          Role Permissions
        </button>
      </div>

      {activeTab === 'role_permissions' ? (
        <RolePermissionsTab />
      ) : (
      <>
      {/* 4 KPI Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Users */}
        <Card className="border border-gray-200/80 bg-white shadow-sm">
          <CardContent className="p-5">
            <p className="text-3xl font-bold text-gray-900 tracking-tight">{isLoading ? '...' : totalUsers}</p>
            <p className="text-xs text-gray-500 font-medium mt-1">Total Platform Users</p>
          </CardContent>
        </Card>

        {/* Admins */}
        <Card className="border border-purple-100 bg-white shadow-sm">
          <CardContent className="p-5">
            <p className="text-3xl font-bold text-purple-600 tracking-tight">{isLoading ? '...' : adminCount}</p>
            <p className="text-xs text-gray-500 font-medium mt-1">Super Admins & Admins</p>
          </CardContent>
        </Card>

        {/* Brand Marketing Team */}
        <Card className="border border-blue-100 bg-white shadow-sm">
          <CardContent className="p-5">
            <p className="text-3xl font-bold text-blue-600 tracking-tight">
              {isLoading ? '...' : brandMarketingCount}
            </p>
            <p className="text-xs text-gray-500 font-medium mt-1">Brand Marketing Team</p>
          </CardContent>
        </Card>

        {/* Trademark Team */}
        <Card className="border border-emerald-100 bg-white shadow-sm">
          <CardContent className="p-5">
            <p className="text-3xl font-bold text-emerald-600 tracking-tight">
              {isLoading ? '...' : trademarkTeamCount}
            </p>
            <p className="text-xs text-gray-500 font-medium mt-1">Trademark Team</p>
          </CardContent>
        </Card>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by name or email..."
            className="pl-9 pr-9 h-9 text-xs bg-white border-gray-200"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded-md hover:bg-gray-100 transition-colors"
              title="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          {/* Role Filter */}
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="h-9 text-xs w-52 bg-white border-gray-200">
              <SelectValue placeholder="All Roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Roles</SelectItem>
              <SelectItem value="super_admin">Super Admin</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="brand_market_admin">Brand Marketing Admin</SelectItem>
              <SelectItem value="brand_market_user">Brand Marketing User</SelectItem>
              <SelectItem value="trademark_admin">Trademark Admin</SelectItem>
              <SelectItem value="trademark_user">Trademark User</SelectItem>
            </SelectContent>
          </Select>

          {/* Status Filter */}
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 text-xs w-36 bg-white border-gray-200">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearFilters}
              className="h-9 text-xs text-gray-600 hover:text-gray-900 border-dashed border-gray-300 gap-1.5 flex-shrink-0"
              title="Clear search and filters"
            >
              <RotateCcw className="w-3.5 h-3.5 text-gray-500" />
              Clear All
            </Button>
          )}

          {hasPermission('user_management', 'manage_users') && (
            <Button
              onClick={openCreateModal}
              className="bg-purple-600 hover:bg-purple-700 text-white font-semibold text-xs h-9 px-4 gap-1.5 shadow-sm flex-shrink-0"
            >
              <Plus className="w-4 h-4" />
              Add User
            </Button>
          )}
        </div>
      </div>

      {/* Users Table */}
      <Card className="border border-gray-200/80 bg-white shadow-sm overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50/80 border-b border-gray-200 text-gray-500 font-bold uppercase tracking-wider text-[11px]">
                  <th className="text-left py-3.5 px-5">USER</th>
                  <th className="text-left py-3.5 px-5">ROLE</th>
                  <th className="text-left py-3.5 px-5">DEPARTMENT</th>
                  <th className="text-left py-3.5 px-5">STATUS</th>
                  <th className="text-left py-3.5 px-5">CREATED</th>
                  <th className="text-center py-3.5 px-5">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-gray-700">
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-gray-400">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-orange-600 mb-2" />
                      Loading users...
                    </td>
                  </tr>
                ) : filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-gray-400">
                      <Users className="w-8 h-8 mx-auto mb-2 opacity-30 text-gray-400" />
                      <p className="text-gray-600 font-medium">No users found matching your filters</p>
                      {hasActiveFilters && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleClearFilters}
                          className="mt-3 text-xs border-dashed gap-1.5 mx-auto"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Clear all filters
                        </Button>
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((u) => {
                    const isSuper = u.is_superuser || u.role === 'super_admin';
                    const roleMeta = getRoleDisplay(u.role, isSuper);
                    const initial = (u.full_name || u.email).charAt(0).toUpperCase();

                    return (
                      <tr key={u.id} className={cn('hover:bg-gray-50/70 transition-colors', !u.is_active && 'opacity-60')}>
                        {/* USER */}
                        <td className="py-3.5 px-5">
                          <div className="flex items-center gap-3">
                            <div
                              className={cn(
                                'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0',
                                isSuper
                                  ? 'bg-purple-600'
                                  : u.role === 'admin'
                                  ? 'bg-orange-500'
                                  : u.role.startsWith('trademark')
                                  ? 'bg-emerald-600'
                                  : 'bg-blue-600'
                              )}
                            >
                              {initial}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-gray-900 truncate">
                                  {u.full_name}
                                </span>
                                {isSuper && (
                                  <Shield className="w-3.5 h-3.5 text-orange-600 flex-shrink-0 fill-orange-50" />
                                )}
                              </div>
                              <span className="text-gray-400 text-[11px] truncate block">
                                {u.email}
                              </span>
                            </div>
                          </div>
                        </td>

                        {/* ROLE */}
                        <td className="py-3.5 px-5">
                          <span
                            className={cn(
                              'inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border',
                              roleMeta.color
                            )}
                          >
                            {roleMeta.label}
                          </span>
                        </td>

                        {/* DEPARTMENT */}
                        <td className="py-3.5 px-5 text-gray-600 font-medium">
                          {u.department || '—'}
                        </td>

                        {/* STATUS */}
                        <td className="py-3.5 px-5">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold',
                              u.is_active
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-gray-100 text-gray-500'
                            )}
                          >
                            <span
                              className={cn(
                                'w-1.5 h-1.5 rounded-full',
                                u.is_active ? 'bg-emerald-600' : 'bg-gray-400'
                              )}
                            />
                            {u.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>

                        {/* CREATED */}
                        <td className="py-3.5 px-5 text-gray-500 font-medium">
                          {formatDate(u.created_at)}
                        </td>

                        {/* ACTIONS */}
                        <td className="py-3.5 px-5">
                          {hasPermission('user_management', 'manage_users') ? (
                            <div className="flex items-center justify-center gap-1.5">
                              {/* Edit Button */}
                              <button
                                onClick={() => openEditModal(u)}
                                className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-orange-600 hover:bg-orange-50 transition-colors"
                                title="Edit user"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>

                              {/* Reset Password Button */}
                              <button
                                onClick={() => setResetPasswordTarget(u)}
                                className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                                title="Reset password"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                              </button>

                              {/* Deactivate / Reactivate Toggle */}
                              {u.id !== currentUser?.id && (
                                <button
                                  onClick={() => setToggleTarget(u)}
                                  className={cn(
                                    'w-7 h-7 rounded-lg flex items-center justify-center transition-colors',
                                    u.is_active
                                      ? 'text-gray-400 hover:text-amber-600 hover:bg-amber-50'
                                      : 'text-gray-400 hover:text-emerald-600 hover:bg-emerald-50'
                                  )}
                                  title={u.is_active ? 'Deactivate user' : 'Reactivate user'}
                                >
                                  {u.is_active ? (
                                    <Ban className="w-3.5 h-3.5" />
                                  ) : (
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                  )}
                                </button>
                              )}

                              {/* Delete Button */}
                              {u.id !== currentUser?.id && !isSuper && (
                                <button
                                  onClick={() => setDeleteTarget(u)}
                                  className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                                  title="Delete user"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="text-center text-gray-400 text-[11px] italic">
                              View only
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Add/Edit Modal */}
      <UserFormModal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        editingUser={editingUser}
      />

      {/* Deactivate / Activate Confirmation Dialog */}
      <Dialog open={!!toggleTarget} onOpenChange={(v) => { if (!v) setToggleTarget(null); }}>
        <DialogContent className="max-w-md p-6 bg-white">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-gray-900 flex items-center gap-2">
              {toggleTarget?.is_active ? (
                <>
                  <Ban className="w-5 h-5 text-amber-500" />
                  Deactivate User
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  Activate User
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 text-xs text-gray-600 space-y-2">
            <p>
              Are you sure you want to {toggleTarget?.is_active ? 'deactivate' : 'activate'}{' '}
              <span className="font-semibold text-gray-900">{toggleTarget?.full_name}</span> ({toggleTarget?.email})?
            </p>
            <p className="text-gray-500">
              {toggleTarget?.is_active
                ? 'They will immediately lose access to the platform until reactivated.'
                : 'They will be able to log in and access permitted features again.'}
            </p>
          </div>
          <DialogFooter className="gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setToggleTarget(null)}
              disabled={toggleActiveMutation.isPending}
              className="text-xs h-9"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toggleTarget &&
                toggleActiveMutation.mutate({
                  id: toggleTarget.id,
                  is_active: !toggleTarget.is_active,
                })
              }
              disabled={toggleActiveMutation.isPending}
              className={cn(
                'text-xs h-9 font-semibold text-white gap-1.5',
                toggleTarget?.is_active
                  ? 'bg-amber-600 hover:bg-amber-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              )}
            >
              {toggleActiveMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {toggleTarget?.is_active ? 'Deactivate User' : 'Activate User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md p-6 bg-white">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-red-600 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              Delete User
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 text-xs text-gray-600 space-y-3">
            <p>
              Are you sure you want to permanently delete{' '}
              <span className="font-semibold text-gray-900">{deleteTarget?.full_name}</span> ({deleteTarget?.email})?
            </p>
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-[11px] leading-relaxed">
              This action is irreversible. The user will be permanently removed from the system. Audit trails and past activity records are retained for compliance.
            </div>
          </div>
          <DialogFooter className="gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteMutation.isPending}
              className="text-xs h-9"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              className="text-xs h-9 bg-red-600 hover:bg-red-700 text-white font-semibold gap-1.5"
            >
              {deleteMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Modal */}
      <ResetPasswordModal
        open={!!resetPasswordTarget}
        onClose={() => setResetPasswordTarget(null)}
        user={resetPasswordTarget}
      />
      </>
      )}
    </div>
  );
}
