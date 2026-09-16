import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Users, Plus, Pencil, UserX, UserCheck, Loader2,
  ShieldCheck, Shield, Search, Trash2, AlertTriangle,
} from 'lucide-react';
import { apiClient } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn, formatDate } from '@/lib/utils';
import type { User } from '@/types';

const ROLE_COLORS: Record<string, string> = {
  admin:    'bg-orange-100 text-orange-700',
  business_team:   'bg-purple-100 text-purple-700',
  trademark_team:  'bg-green-100 text-green-700',
};

function RoleBadge({ role, is_superuser }: { role: string; is_superuser: boolean }) {
  const label = is_superuser ? 'admin' : role;
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold',
      ROLE_COLORS[label] || 'bg-gray-100 text-gray-700'
    )}>
      {is_superuser && <ShieldCheck className="w-3 h-3" />}
      {label}
    </span>
  );
}

const EMPTY_FORM = {
  full_name: '', email: '', password: '', role: 'business_team', department: '', is_superuser: false,
};

type FormData = typeof EMPTY_FORM;

interface UserFormProps {
  open: boolean;
  onClose: () => void;
  editing: User | null;
}

function UserFormModal({ open, onClose, editing }: UserFormProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormData>(() =>
    editing
      ? { full_name: editing.full_name, email: editing.email, password: '', role: editing.role, department: editing.department ?? '', is_superuser: editing.is_superuser }
      : { ...EMPTY_FORM }
  );
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({});

  const createMutation = useMutation({
    mutationFn: (d: FormData) => apiClient.createAdminUser({
      email: d.email, full_name: d.full_name, password: d.password,
      role: d.is_superuser ? 'admin' : d.role,
      department: d.department || undefined,
      is_superuser: d.is_superuser,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success('User created successfully');
      onClose();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail ?? 'Failed to create user');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (d: FormData) => apiClient.updateAdminUser(editing!.id, {
      full_name: d.full_name,
      role: d.is_superuser ? 'admin' : d.role,
      department: d.department || undefined,
      is_superuser: d.is_superuser,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success('User updated successfully');
      onClose();
    },
    onError: () => toast.error('Failed to update user'),
  });

  const set = (k: keyof FormData, v: string | boolean) =>
    setForm(f => ({ ...f, [k]: v }));

  const validate = () => {
    const e: typeof errors = {};
    if (!form.full_name.trim()) e.full_name = 'Name is required';
    if (!form.email.trim() || !/\S+@\S+\.\S+/.test(form.email)) e.email = 'Valid email required'; // NOSONAR - fixed-width class, not backtracking-prone
    if (!editing && !form.password.trim()) e.password = 'Password is required'; // NOSONAR - form validation check, not a hardcoded credential
    if (!editing && form.password.length < 8) e.password = 'Minimum 8 characters'; // NOSONAR - form validation check, not a hardcoded credential
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    editing ? updateMutation.mutate(form) : createMutation.mutate(form);
  };

  const busy = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit User' : 'Create New User'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Full Name */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Full Name *</label>
            <Input
              value={form.full_name}
              onChange={e => set('full_name', e.target.value)}
              placeholder="Dr. Jane Smith"
              className={errors.full_name ? 'border-red-400' : ''}
            />
            {errors.full_name && <p className="text-xs text-red-500 mt-1">{errors.full_name}</p>}
          </div>

          {/* Email */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Email *</label>
            <Input
              type="email"
              value={form.email}
              onChange={e => set('email', e.target.value)}
              placeholder="user@pharmabi.com"
              disabled={!!editing}
              className={cn(errors.email ? 'border-red-400' : '', editing ? 'bg-gray-50' : '')}
            />
            {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email}</p>}
          </div>

          {/* Password (create only) */}
          {!editing && (
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Password *</label>
              <Input
                type="password"
                value={form.password}
                onChange={e => set('password', e.target.value)}
                placeholder="Min. 8 characters"
                className={errors.password ? 'border-red-400' : ''}
              />
              {errors.password && <p className="text-xs text-red-500 mt-1">{errors.password}</p>}
            </div>
          )}

          {/* Role + Admin toggle */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Role</label>
              <Select
                value={form.role}
                onValueChange={v => set('role', v)}
                disabled={form.is_superuser}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="business_team">Business Team</SelectItem>
                  <SelectItem value="trademark_team">Trademark Team</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Access Level</label>
              <button
                type="button"
                onClick={() => set('is_superuser', !form.is_superuser)}
                className={cn(
                  'w-full h-9 rounded-md border text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors',
                  form.is_superuser
                    ? 'bg-orange-500 border-orange-500 text-white'
                    : 'bg-white border-gray-200 text-gray-600 hover:border-orange-300'
                )}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                {form.is_superuser ? 'Admin' : 'Standard'}
              </button>
            </div>
          </div>

          {/* Department */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Department</label>
            <Input
              value={form.department}
              onChange={e => set('department', e.target.value)}
              placeholder="e.g. Brand Strategy, Trademark, R&D"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-orange-500 hover:bg-orange-600 text-white">
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {editing ? 'Save Changes' : 'Create User'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UserManagementPage() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [toggleTarget, setToggleTarget] = useState<User | null>(null);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => apiClient.getAdminUsers(),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      apiClient.updateAdminUser(id, { is_active }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success(vars.is_active ? 'User activated' : 'User deactivated');
      setToggleTarget(null);
    },
    onError: () => toast.error('Failed to update user'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiClient.deleteAdminUser(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success('User deleted');
      setDeleteTarget(null);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail ?? 'Failed to delete user');
    },
  });

  const openCreate = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (u: User) => { setEditing(u); setModalOpen(true); };

  const filtered = users.filter(u => {
    const q = search.toLowerCase();
    return !q || u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.role.toLowerCase().includes(q);
  });

  const activeCount = users.filter(u => u.is_active).length;
  const adminCount = users.filter(u => u.is_superuser).length;

  if (!me?.is_superuser) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">Admin access required</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fffaf5]">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-orange-100 rounded-xl flex items-center justify-center">
                <Users className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
                <p className="text-gray-500 text-sm">Create and manage platform users</p>
              </div>
            </div>
            <Button onClick={openCreate} className="bg-orange-500 hover:bg-orange-600 text-white gap-2">
              <Plus className="w-4 h-4" />
              Add User
            </Button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            {[
              { label: 'Total Users', value: users.length, color: 'text-gray-900' },
              { label: 'Active', value: activeCount, color: 'text-green-600' },
              { label: 'Admins', value: adminCount, color: 'text-orange-600' },
            ].map(s => (
              <Card key={s.label} className="border border-gray-100">
                <CardContent className="p-4">
                  <p className="text-xs text-gray-500 mb-1">{s.label}</p>
                  <p className={cn('text-2xl font-bold', s.color)}>{s.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Search */}
          <div className="relative max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              className="pl-9 h-9 text-sm bg-gray-50"
              placeholder="Search users..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
          </div>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left py-3 px-4 text-gray-500 font-medium">User</th>
                    <th className="text-left py-3 px-4 text-gray-500 font-medium">Role</th>
                    <th className="text-left py-3 px-4 text-gray-500 font-medium">Department</th>
                    <th className="text-left py-3 px-4 text-gray-500 font-medium">Status</th>
                    <th className="text-left py-3 px-4 text-gray-500 font-medium">Created</th>
                    <th className="text-left py-3 px-4 text-gray-500 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-gray-400">
                        <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        No users found
                      </td>
                    </tr>
                  ) : (
                    filtered.map(u => (
                      <tr key={u.id} className={cn('hover:bg-gray-50 transition-colors', !u.is_active && 'opacity-50')}>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0',
                              u.is_superuser ? 'bg-orange-500' : 'bg-gray-400'
                            )}>
                              {u.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-gray-900">{u.full_name}</p>
                              <p className="text-xs text-gray-400">{u.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <RoleBadge role={u.role} is_superuser={u.is_superuser} />
                        </td>
                        <td className="py-3 px-4 text-gray-500 text-xs">{u.department ?? '—'}</td>
                        <td className="py-3 px-4">
                          <Badge variant={u.is_active ? 'success' : 'destructive'} className="text-xs">
                            {u.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-gray-400 text-xs whitespace-nowrap">
                          {formatDate(u.created_at)}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost" size="sm"
                              className="h-7 w-7 p-0 text-gray-400 hover:text-orange-600"
                              onClick={() => openEdit(u)}
                              title="Edit user"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            {u.id !== me?.id && (
                              <>
                                <Button
                                  variant="ghost" size="sm"
                                  className={cn('h-7 w-7 p-0', u.is_active ? 'text-gray-400 hover:text-red-500' : 'text-gray-400 hover:text-green-600')}
                                  onClick={() => setToggleTarget(u)}
                                  title={u.is_active ? 'Deactivate user' : 'Reactivate user'}
                                >
                                  {u.is_active ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                                </Button>
                                <Button
                                  variant="ghost" size="sm"
                                  className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
                                  onClick={() => setDeleteTarget(u)}
                                  title="Delete user"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>

      <UserFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
      />

      {/* Activate / Deactivate confirmation */}
      <Dialog open={!!toggleTarget} onOpenChange={v => { if (!v) setToggleTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {toggleTarget?.is_active
                ? <><UserX className="w-5 h-5 text-red-500" /> Deactivate User</>
                : <><UserCheck className="w-5 h-5 text-green-600" /> Activate User</>}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-gray-600">
              {toggleTarget?.is_active ? 'Deactivate' : 'Activate'}{' '}
              <span className="font-semibold text-gray-900">{toggleTarget?.full_name}</span>{' '}
              <span className="text-gray-400">({toggleTarget?.email})</span>?
              {toggleTarget?.is_active
                ? ' They will lose access until reactivated.'
                : ' They will regain access to the platform.'}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToggleTarget(null)} disabled={toggleActiveMutation.isPending}>
              Cancel
            </Button>
            <Button
              className={cn('text-white', toggleTarget?.is_active ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700')}
              disabled={toggleActiveMutation.isPending}
              onClick={() => toggleTarget && toggleActiveMutation.mutate({ id: toggleTarget.id, is_active: !toggleTarget.is_active })}
            >
              {toggleActiveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {toggleTarget?.is_active ? 'Deactivate' : 'Activate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" />
              Delete User
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-sm text-gray-600">
              Are you sure you want to permanently delete{' '}
              <span className="font-semibold text-gray-900">{deleteTarget?.full_name}</span>{' '}
              <span className="text-gray-400">({deleteTarget?.email})</span>? This action cannot be undone.
            </p>
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-700">
                The user will lose access immediately. Their past activity (searches, reviews, audit logs) is retained but no longer linked to a user. To temporarily disable access instead, use Deactivate.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default UserManagementPage;
