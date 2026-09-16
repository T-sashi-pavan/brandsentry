import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  User,
  Lock,
  Sliders,
  Bell,
  Save,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RotateCcw,
  Eye,
  EyeOff,
  Layers,
  Sparkles,
  Search,
  Zap,
} from 'lucide-react';
import { apiClient } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { RiskWeights, GradeThresholds } from '@/types';

const WEIGHT_LABELS: Record<
  keyof RiskWeights,
  { label: string; desc: string; color: string }
> = {
  phonetic: {
    label: 'Phonetic Similarity',
    desc: 'Weight given to sound-alike & Double Metaphone phonetic matching',
    color: 'bg-purple-600',
  },
  spelling: {
    label: 'Spelling Similarity',
    desc: 'Weight given to orthographic Levenshtein & edit distance similarity',
    color: 'bg-blue-600',
  },
  conceptual: {
    label: 'Conceptual / Semantic',
    desc: 'Weight given to AI vector embeddings, medical meaning & taxonomy',
    color: 'bg-indigo-600',
  },
  visual: {
    label: 'Visual Lookalike',
    desc: 'Weight given to visual letter shape & prescription lookalike analysis',
    color: 'bg-orange-600',
  },
};

function getGradeBadgeStyle(grade?: string, paramKey?: 'phonetic' | 'spelling' | 'conceptual' | 'visual') {
  if (paramKey === 'spelling') {
    if (grade === 'A') return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    if (grade === 'B' || grade === 'C') return 'bg-amber-100 text-amber-800 border-amber-300';
    if (grade === 'D') return 'bg-red-100 text-red-800 border-red-300';
  }
  switch (grade) {
    case 'A':
      return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    case 'B':
      return 'bg-blue-100 text-blue-800 border-blue-300';
    case 'C':
      return 'bg-amber-100 text-amber-800 border-amber-300';
    case 'D':
      return 'bg-red-100 text-red-800 border-red-300';
    default:
      return 'bg-gray-100 text-gray-700 border-gray-200';
  }
}

export function SettingsPage() {
  const router = useRouter();
  const { user: currentUser, refreshUser, isSuperAdmin, hasPermission, logout } = useAuth();
  const canModifyThresholds = isSuperAdmin || hasPermission('settings', 'modify_thresholds');
  const qc = useQueryClient();

  // Profile Form State
  const [fullName, setFullName] = useState(currentUser?.full_name || '');
  const [department, setDepartment] = useState(currentUser?.department || '');

  // Password Form State
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordErrors, setPasswordErrors] = useState<{
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
  }>({});

  // Notification toggles state (Task 7)
  const [savedNotifs, setSavedNotifs] = useState({
    highRisk: true,
    genComplete: true,
    reviews: true,
    system: true,
  });
  const [notifHighRisk, setNotifHighRisk] = useState(true);
  const [notifGenComplete, setNotifGenComplete] = useState(true);
  const [notifReviews, setNotifReviews] = useState(true);
  const [notifSystem, setNotifSystem] = useState(true);

  const isNotifsDirty =
    notifHighRisk !== savedNotifs.highRisk ||
    notifGenComplete !== savedNotifs.genComplete ||
    notifReviews !== savedNotifs.reviews ||
    notifSystem !== savedNotifs.system;

  const handleSaveNotifications = () => {
    setSavedNotifs({
      highRisk: notifHighRisk,
      genComplete: notifGenComplete,
      reviews: notifReviews,
      system: notifSystem,
    });
    toast.success('Notification preferences saved');
  };

  // Sync profile values when currentUser loads
  useEffect(() => {
    if (currentUser) {
      setFullName(currentUser.full_name || '');
      setDepartment(currentUser.department || '');
    }
  }, [currentUser]);

  // Profile dirty tracking (Task 8)
  const isProfileDirty =
    fullName.trim() !== (currentUser?.full_name || '') ||
    department.trim() !== (currentUser?.department || '');

  // Risk Weights Query & State (Task 9: 30, 30, 20, 20)
  const { data: serverWeights } = useQuery({
    queryKey: ['risk-weights'],
    queryFn: () => apiClient.getRiskWeights(),
  });

  const [localWeights, setLocalWeights] = useState<RiskWeights>({
    spelling: 0.40,
    phonetic: 0.20,
    conceptual: 0.20,
    visual: 0.20,
  });

  useEffect(() => {
    if (serverWeights) {
      setLocalWeights({
        spelling: serverWeights.spelling ?? 0.40,
        phonetic: serverWeights.phonetic ?? 0.20,
        conceptual: serverWeights.conceptual ?? 0.20,
        visual: serverWeights.visual ?? 0.20,
      });
    }
  }, [serverWeights]);

  const weightSum =
    localWeights.phonetic +
    localWeights.spelling +
    localWeights.conceptual +
    localWeights.visual;
  const isWeightValid = Math.abs(weightSum - 1.0) <= 0.01;

  // Weights dirty tracking (Task 8)
  const isWeightsDirty = useMemo(() => {
    if (!serverWeights) return false;
    return (
      Math.abs(localWeights.spelling - (serverWeights.spelling ?? 0.40)) > 0.001 ||
      Math.abs(localWeights.phonetic - (serverWeights.phonetic ?? 0.20)) > 0.001 ||
      Math.abs(localWeights.conceptual - (serverWeights.conceptual ?? 0.20)) > 0.001 ||
      Math.abs(localWeights.visual - (serverWeights.visual ?? 0.20)) > 0.001
    );
  }, [localWeights, serverWeights]);

  // Enable reset only if weights deviate from standard default (40%, 20%, 20%, 20%)
  const isWeightsDifferentFromDefault = useMemo(() => {
    return (
      Math.abs(localWeights.spelling - 0.40) > 0.001 ||
      Math.abs(localWeights.phonetic - 0.20) > 0.001 ||
      Math.abs(localWeights.conceptual - 0.20) > 0.001 ||
      Math.abs(localWeights.visual - 0.20) > 0.001
    );
  }, [localWeights]);

  // Profile update mutation
  const profileMutation = useMutation({
    mutationFn: (payload: { full_name: string; department: string }) =>
      apiClient.updateProfile(payload),
    onSuccess: () => {
      toast.success('Profile updated successfully');
      if (refreshUser) refreshUser();
    },
    onError: () => {
      toast.error('Failed to update profile');
    },
  });

  // Change password mutation
  const passwordMutation = useMutation({
    mutationFn: (payload: { current_password: string; new_password: string }) =>
      apiClient.changePassword(payload),
    onSuccess: () => {
      toast.success('Password updated successfully. Please sign in with your new password.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordErrors({});
      logout();
      router.push('/login');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || 'Failed to update password');
    },
  });

  // Risk weights update mutation
  const weightsMutation = useMutation({
    mutationFn: (weights: RiskWeights) => apiClient.updateRiskWeights(weights),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['risk-weights'] });
      toast.success('Risk assessment weights saved');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || 'Failed to save risk weights');
    },
  });

  // ── Similarity Grade Ranges & Thresholds (Super Admin & Admin with modify_thresholds) ───
  const { data: serverGradeThresholds } = useQuery({
    queryKey: ['grade-thresholds'],
    queryFn: () => apiClient.getGradeThresholds(),
    enabled: !!canModifyThresholds,
    staleTime: 30 * 1000,
  });

  const { data: serverCombinationRules } = useQuery({
    queryKey: ['combination-rules'],
    queryFn: () => apiClient.getCombinationRules(),
    enabled: !!canModifyThresholds,
    staleTime: 30 * 1000,
  });

  const DEFAULT_THRESHOLDS: GradeThresholds = {
    A: { min: 0, max: 30 },
    B: { min: 31, max: 50 },
    C: { min: 51, max: 70 },
    D: { min: 71, max: 100 },
  };

  const [localThresholds, setLocalThresholds] = useState<GradeThresholds>(DEFAULT_THRESHOLDS);

  useEffect(() => {
    if (serverGradeThresholds) {
      setLocalThresholds({
        A: { min: serverGradeThresholds.A?.min ?? 0, max: serverGradeThresholds.A?.max ?? 30 },
        B: { min: serverGradeThresholds.B?.min ?? 31, max: serverGradeThresholds.B?.max ?? 50 },
        C: { min: serverGradeThresholds.C?.min ?? 51, max: serverGradeThresholds.C?.max ?? 70 },
        D: { min: serverGradeThresholds.D?.min ?? 71, max: serverGradeThresholds.D?.max ?? 100 },
      });
    }
  }, [serverGradeThresholds]);

  const isThresholdsDirty = useMemo(() => {
    if (!serverGradeThresholds) return false;
    return (
      localThresholds.A.min !== (serverGradeThresholds.A?.min ?? 0) ||
      localThresholds.A.max !== (serverGradeThresholds.A?.max ?? 30) ||
      localThresholds.B.min !== (serverGradeThresholds.B?.min ?? 31) ||
      localThresholds.B.max !== (serverGradeThresholds.B?.max ?? 50) ||
      localThresholds.C.min !== (serverGradeThresholds.C?.min ?? 51) ||
      localThresholds.C.max !== (serverGradeThresholds.C?.max ?? 70) ||
      localThresholds.D.min !== (serverGradeThresholds.D?.min ?? 71) ||
      localThresholds.D.max !== (serverGradeThresholds.D?.max ?? 100)
    );
  }, [localThresholds, serverGradeThresholds]);

  const isThresholdsDifferentFromDefault = useMemo(() => {
    return (
      localThresholds.A.min !== 0 || localThresholds.A.max !== 30 ||
      localThresholds.B.min !== 31 || localThresholds.B.max !== 50 ||
      localThresholds.C.min !== 51 || localThresholds.C.max !== 70 ||
      localThresholds.D.min !== 71 || localThresholds.D.max !== 100
    );
  }, [localThresholds]);

  const isThresholdsValid = useMemo(() => {
    const { A, B, C, D } = localThresholds;
    if (A.min < 0 || D.max > 100) return false;
    if (A.min >= A.max || B.min >= B.max || C.min >= C.max || D.min >= D.max) return false;
    if (A.max >= B.min || B.max >= C.min || C.max >= D.min) return false;
    return true;
  }, [localThresholds]);

  const gradeThresholdsMutation = useMutation({
    mutationFn: (payload: GradeThresholds) => apiClient.updateGradeThresholds(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['grade-thresholds'] });
      toast.success('Similarity grade thresholds updated successfully');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || 'Failed to update grade thresholds');
    },
  });

  const handleThresholdChange = (gradeKey: keyof GradeThresholds, field: 'min' | 'max', val: string) => {
    const num = parseInt(val, 10);
    if (!isNaN(num)) {
      setLocalThresholds((prev) => ({
        ...prev,
        [gradeKey]: {
          ...prev[gradeKey],
          [field]: Math.min(100, Math.max(0, num)),
        },
      }));
    }
  };

  const scoreToGradeLocal = (score: number): 'A' | 'B' | 'C' | 'D' => {
    if (score <= localThresholds.A.max) return 'A';
    if (score <= localThresholds.B.max) return 'B';
    if (score <= localThresholds.C.max) return 'C';
    return 'D';
  };

  const evaluateCombination = (
    p: 'A' | 'B' | 'C' | 'D',
    s: 'A' | 'B' | 'C' | 'D',
    c: 'A' | 'B' | 'C' | 'D',
    v: 'A' | 'B' | 'C' | 'D'
  ) => {
    const code = `${p}${s}${c}${v}`;
    if (serverCombinationRules?.rules && serverCombinationRules.rules[code]) {
      const r = serverCombinationRules.rules[code].toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH';
      return { risk: r, rec: r === 'HIGH' ? 'REJECT' : (r === 'MEDIUM' ? 'LEGAL_REVIEW' : 'PROCEED') };
    }
    if (s === 'D' || p === 'D' || c === 'D' || v === 'D') {
      return { risk: 'HIGH' as const, rec: 'REJECT' as const };
    }
    if (s === 'A' && (p === 'A' || p === 'B') && (c === 'A' || c === 'B') && (v === 'A' || v === 'B')) {
      return { risk: 'LOW' as const, rec: 'PROCEED' as const };
    }
    return { risk: 'MEDIUM' as const, rec: 'LEGAL_REVIEW' as const };
  };

  const allCombinations = useMemo(() => {
    const grades: ('A' | 'B' | 'C' | 'D')[] = ['A', 'B', 'C', 'D'];
    const list = [];
    for (const p of grades) {
      for (const s of grades) {
        for (const c of grades) {
          for (const v of grades) {
            const code = `${p}${s}${c}${v}`;
            const res = evaluateCombination(p, s, c, v);
            list.push({
              p,
              s,
              c,
              v,
              code,
              risk: res.risk,
              rec: res.rec,
            });
          }
        }
      }
    }
    return list;
  }, [serverCombinationRules]);

  const combinationCounts = useMemo(() => {
    let low = 0;
    let medium = 0;
    let high = 0;
    for (const item of allCombinations) {
      if (item.risk === 'LOW') low++;
      else if (item.risk === 'MEDIUM') medium++;
      else high++;
    }
    return { total: allCombinations.length, low, medium, high };
  }, [allCombinations]);

  // Simulator state
  const [simScores, setSimScores] = useState({
    p: 28,
    s: 18,
    c: 35,
    v: 24,
  });

  const simResult = useMemo(() => {
    const pG = scoreToGradeLocal(simScores.p);
    const sG = scoreToGradeLocal(simScores.s);
    const cG = scoreToGradeLocal(simScores.c);
    const vG = scoreToGradeLocal(simScores.v);
    const code = `${pG}${sG}${cG}${vG}`;
    const evalRes = evaluateCombination(pG, sG, cG, vG);
    return {
      pGrade: pG,
      sGrade: sG,
      cGrade: cG,
      vGrade: vG,
      code,
      risk: evalRes.risk,
      rec: evalRes.rec,
    };
  }, [simScores, localThresholds, serverCombinationRules]);

  const [combinationFilter, setCombinationFilter] = useState<'ALL' | 'LOW' | 'MEDIUM' | 'HIGH'>('ALL');
  const [combinationSearch, setCombinationSearch] = useState('');
  const [matrixPage, setMatrixPage] = useState(1);
  const MATRIX_PAGE_SIZE = 16;

  const filteredCombinations = useMemo(() => {
    return allCombinations.filter((item) => {
      if (combinationFilter !== 'ALL' && item.risk !== combinationFilter) return false;
      if (combinationSearch.trim()) {
        const q = combinationSearch.trim().toUpperCase();
        if (!item.code.includes(q)) return false;
      }
      return true;
    });
  }, [allCombinations, combinationFilter, combinationSearch]);

  const totalMatrixPages = Math.max(1, Math.ceil(filteredCombinations.length / MATRIX_PAGE_SIZE));
  const paginatedCombinations = useMemo(() => {
    const start = (matrixPage - 1) * MATRIX_PAGE_SIZE;
    return filteredCombinations.slice(start, start + MATRIX_PAGE_SIZE);
  }, [filteredCombinations, matrixPage]);

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) {
      toast.error('Full name is required');
      return;
    }
    profileMutation.mutate({
      full_name: fullName.trim(),
      department: department.trim(),
    });
  };

  const handleUpdatePassword = (e: React.FormEvent) => {
    e.preventDefault();
    const errors: { currentPassword?: string; newPassword?: string; confirmPassword?: string } = {};

    if (!currentPassword) {
      errors.currentPassword = 'Please enter your current password';
    }

    if (!newPassword) {
      errors.newPassword = 'Please enter New Password';
    } else if (newPassword.length < 8) {
      errors.newPassword = 'New password must be at least 8 characters';
    }

    if (!confirmPassword) {
      errors.confirmPassword = 'Please Confirm New Password';
    } else if (newPassword && newPassword !== confirmPassword) {
      errors.confirmPassword = 'New Passwords do not match';
    }

    if (Object.keys(errors).length > 0) {
      setPasswordErrors(errors);
      const firstError = errors.currentPassword || errors.newPassword || errors.confirmPassword;
      if (firstError) toast.error(firstError);
      return;
    }

    setPasswordErrors({});
    passwordMutation.mutate({
      current_password: currentPassword,
      new_password: newPassword,
    });
  };

  const handleWeightChange = (key: keyof RiskWeights, val: string) => {
    const num = parseFloat(val);
    if (!isNaN(num)) {
      setLocalWeights((prev) => ({
        ...prev,
        [key]: Math.min(1, Math.max(0, num)),
      }));
    }
  };

  const isAdmin = currentUser?.is_superuser || currentUser?.role === 'admin';
  const roleDisplay = isAdmin
    ? 'Admin'
    : currentUser?.role === 'trademark_team'
    ? 'Trademark Team'
    : 'Brand Marketing Team';

  const userInitial = (currentUser?.full_name || currentUser?.email || 'U')
    .charAt(0)
    .toUpperCase();

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-6">

      {/* Card 1: Profile */}
      <Card className="border border-gray-200/80 bg-white shadow-sm overflow-hidden">
        <CardHeader className="border-b border-gray-100 bg-gray-50/50 pb-4">
          <CardTitle className="text-sm font-bold text-gray-900 flex items-center gap-2">
            <User className="w-4 h-4 text-orange-600" />
            Profile
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 space-y-6">
          {/* User Avatar + Details */}
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-orange-100 border border-orange-200 flex items-center justify-center text-orange-700 text-2xl font-bold flex-shrink-0 shadow-sm">
              {userInitial}
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-gray-900 text-lg leading-tight truncate">
                {currentUser?.full_name || 'User'}
              </h3>
              <p className="text-xs text-gray-500 truncate mt-0.5">{currentUser?.email}</p>
              <div className="flex items-center gap-2 mt-2">
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-100 text-orange-800">
                  {roleDisplay}
                </span>
                {currentUser?.department && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-700">
                    {currentUser.department}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Profile Form */}
          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Full Name */}
              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5 block">
                  Full Name
                </label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Enter your full name..."
                  className="h-10 text-xs"
                />
              </div>

              {/* Email Address (Read-only) */}
              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5 block">
                  Email Address
                </label>
                <Input
                  value={currentUser?.email || ''}
                  disabled
                  className="h-10 text-xs bg-gray-50 cursor-not-allowed text-gray-500"
                />
              </div>

              {/* Department */}
              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5 block">
                  Department
                </label>
                <Input
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  placeholder="e.g. Business Development, Trademark Review"
                  className="h-10 text-xs"
                />
              </div>

              {/* Role (Read-only) */}
              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5 block">
                  Role
                </label>
                <Input
                  value={roleDisplay}
                  disabled
                  className="h-10 text-xs bg-gray-50 cursor-not-allowed text-gray-500"
                />
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                type="submit"
                disabled={!isProfileDirty || profileMutation.isPending || !fullName.trim()}
                className="bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold h-9 px-5 gap-1.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {profileMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Save Profile
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Card 2: Change Password */}
      <Card className="border border-gray-200/80 bg-white shadow-sm overflow-hidden">
        <CardHeader className="border-b border-gray-100 bg-gray-50/50 pb-4">
          <CardTitle className="text-sm font-bold text-gray-900 flex items-center gap-2">
            <Lock className="w-4 h-4 text-orange-600" />
            Change Password
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 space-y-4">
          <form onSubmit={handleUpdatePassword} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Current Password */}
              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5 block">
                  Current Password
                </label>
                <div className="relative">
                  <Input
                    type={showCurrentPassword ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => {
                      setCurrentPassword(e.target.value);
                      if (passwordErrors.currentPassword) {
                        setPasswordErrors((prev) => ({ ...prev, currentPassword: undefined }));
                      }
                    }}
                    placeholder="••••••••"
                    className={cn(
                      'h-10 text-xs pr-10 transition-colors',
                      passwordErrors.currentPassword && 'border-red-500 focus-visible:ring-red-300 bg-red-50/20'
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1 rounded-md hover:bg-gray-100 transition-colors"
                    title={showCurrentPassword ? 'Hide current password' : 'Show current password'}
                  >
                    {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {passwordErrors.currentPassword && (
                  <p className="text-[11px] text-red-600 font-medium mt-1">
                    {passwordErrors.currentPassword}
                  </p>
                )}
              </div>

              {/* New Password */}
              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5 block">
                  New Password
                </label>
                <div className="relative">
                  <Input
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => {
                      setNewPassword(e.target.value);
                      if (passwordErrors.newPassword) {
                        setPasswordErrors((prev) => ({ ...prev, newPassword: undefined }));
                      }
                    }}
                    placeholder="Min. 8 characters"
                    className={cn(
                      'h-10 text-xs pr-10 transition-colors',
                      passwordErrors.newPassword && 'border-red-500 focus-visible:ring-red-300 bg-red-50/20'
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1 rounded-md hover:bg-gray-100 transition-colors"
                    title={showNewPassword ? 'Hide new password' : 'Show new password'}
                  >
                    {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {passwordErrors.newPassword && (
                  <p className="text-[11px] text-red-600 font-medium mt-1">
                    {passwordErrors.newPassword}
                  </p>
                )}
              </div>

              {/* Confirm New Password */}
              <div>
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5 block">
                  Confirm New Password
                </label>
                <div className="relative">
                  <Input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (passwordErrors.confirmPassword) {
                        setPasswordErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                      }
                    }}
                    placeholder="••••••••"
                    className={cn(
                      'h-10 text-xs pr-10 transition-colors',
                      passwordErrors.confirmPassword && 'border-red-500 focus-visible:ring-red-300 bg-red-50/20'
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1 rounded-md hover:bg-gray-100 transition-colors"
                    title={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {passwordErrors.confirmPassword && (
                  <p className="text-[11px] text-red-600 font-medium mt-1">
                    {passwordErrors.confirmPassword}
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                type="submit"
                disabled={passwordMutation.isPending}
                variant="outline"
                className="border-gray-300 text-gray-800 hover:text-orange-600 hover:border-orange-300 text-xs font-semibold h-9 px-5 gap-1.5 shadow-sm"
              >
                {passwordMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Update Password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Note: Risk Assessment Weights and E-Pharmacy Discovery Provider sections are hidden as requested */}

      {/* Card: Similarity Grade Ranges & Thresholds */}
      {canModifyThresholds && (
        <Card className="border border-indigo-200/80 bg-white shadow-sm overflow-hidden">
          <CardHeader className="border-b border-indigo-100 bg-indigo-50/40 pb-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-sm font-bold text-gray-900 flex items-center gap-2">
                <Sliders className="w-4 h-4 text-indigo-600" />
                Similarity Grade Ranges & Threshold Configuration
                <Badge variant="secondary" className="text-[10px] font-bold bg-indigo-100 text-indigo-900 border border-indigo-200 ml-1">
                  CONFIG
                </Badge>
              </CardTitle>
              <div
                className={cn(
                  'px-2.5 py-0.5 rounded-full text-[11px] font-semibold flex items-center gap-1.5 border',
                  isThresholdsValid
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-red-50 text-red-700 border-red-200'
                )}
              >
                {isThresholdsValid ? (
                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-3 h-3 text-red-600" />
                )}
                {isThresholdsValid ? 'Continuous (0% - 100%)' : 'Ranges must be contiguous (0% - 100%)'}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            <p className="text-xs text-gray-600 leading-relaxed">
              Configure the percentage boundaries for each similarity grade (A, B, C, D). These grade brackets convert raw similarity percentages into standardized grades across Phonetic, Spelling, Visual, and Conceptual parameters.
              <strong className="text-gray-900 ml-1">Any threshold change immediately updates the combination simulator and metrics below in real-time.</strong>
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Grade A */}
              <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                    Grade A
                  </span>
                  <span className="text-[11px] font-semibold text-emerald-700">
                    {localThresholds.A.min}% – {localThresholds.A.max}%
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">Min %</label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={localThresholds.A.min}
                      onChange={(e) => handleThresholdChange('A', 'min', e.target.value)}
                      className="h-8 text-xs text-center font-bold"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">Max %</label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={localThresholds.A.max}
                      onChange={(e) => handleThresholdChange('A', 'max', e.target.value)}
                      className="h-8 text-xs text-center font-bold"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-gray-500 pt-1 leading-tight">
                  Phonetic/Conceptual/Visual: <strong className="text-emerald-700">Low Risk</strong><br />
                  Spelling: <strong className="text-emerald-700">Low Risk</strong>
                </p>
              </div>

              {/* Grade B */}
              <div className="p-4 rounded-xl border border-blue-200 bg-blue-50/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-blue-100 text-blue-800 border border-blue-300">
                    Grade B
                  </span>
                  <span className="text-[11px] font-semibold text-blue-700">
                    {localThresholds.B.min}% – {localThresholds.B.max}%
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">Min %</label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={localThresholds.B.min}
                      onChange={(e) => handleThresholdChange('B', 'min', e.target.value)}
                      className="h-8 text-xs text-center font-bold"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">Max %</label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={localThresholds.B.max}
                      onChange={(e) => handleThresholdChange('B', 'max', e.target.value)}
                      className="h-8 text-xs text-center font-bold"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-gray-500 pt-1 leading-tight">
                  Phonetic/Conceptual/Visual: <strong className="text-emerald-700">Low Risk</strong><br />
                  Spelling: <strong className="text-amber-700">Medium Risk</strong>
                </p>
              </div>

              {/* Grade C */}
              <div className="p-4 rounded-xl border border-amber-200 bg-amber-50/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300">
                    Grade C
                  </span>
                  <span className="text-[11px] font-semibold text-amber-700">
                    {localThresholds.C.min}% – {localThresholds.C.max}%
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">Min %</label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={localThresholds.C.min}
                      onChange={(e) => handleThresholdChange('C', 'min', e.target.value)}
                      className="h-8 text-xs text-center font-bold"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">Max %</label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={localThresholds.C.max}
                      onChange={(e) => handleThresholdChange('C', 'max', e.target.value)}
                      className="h-8 text-xs text-center font-bold"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-gray-500 pt-1 leading-tight">
                  Phonetic/Conceptual/Visual: <strong className="text-amber-700">Medium Risk</strong><br />
                  Spelling: <strong className="text-red-700">High Risk</strong>
                </p>
              </div>

              {/* Grade D */}
              <div className="p-4 rounded-xl border border-red-200 bg-red-50/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-red-100 text-red-800 border border-red-300">
                    Grade D
                  </span>
                  <span className="text-[11px] font-semibold text-red-700">
                    {localThresholds.D.min}% – {localThresholds.D.max}%
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">Min %</label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={localThresholds.D.min}
                      onChange={(e) => handleThresholdChange('D', 'min', e.target.value)}
                      className="h-8 text-xs text-center font-bold"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">Max %</label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={localThresholds.D.max}
                      onChange={(e) => handleThresholdChange('D', 'max', e.target.value)}
                      className="h-8 text-xs text-center font-bold"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-gray-500 pt-1 leading-tight">
                  Phonetic/Conceptual/Visual: <strong className="text-red-700">High Risk</strong><br />
                  Spelling: <strong className="text-red-700">High Risk Knockout</strong>
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-gray-100">
              <Button
                type="button"
                variant="outline"
                disabled={!isThresholdsDifferentFromDefault}
                onClick={() => {
                  setLocalThresholds(DEFAULT_THRESHOLDS);
                  toast.info('Reset grade thresholds to standard defaults (A: 0-30%, B: 31-50%, C: 51-70%, D: 71-100%)');
                }}
                className="text-xs font-semibold h-9 px-4 gap-1.5 border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5 text-gray-500" />
                Reset Defaults
              </Button>
              <Button
                onClick={() => gradeThresholdsMutation.mutate(localThresholds)}
                disabled={!isThresholdsDirty || !isThresholdsValid || gradeThresholdsMutation.isPending}
                className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold h-9 px-5 gap-1.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {gradeThresholdsMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Save Grade Thresholds
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Card: Combination Risk Classification Matrix & Live Sandbox */}
      {canModifyThresholds && (
        <Card className="border border-blue-200/80 bg-white shadow-sm overflow-hidden">
          <CardHeader className="border-b border-blue-100 bg-blue-50/40 pb-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-sm font-bold text-gray-900 flex items-center gap-2">
                <Layers className="w-4 h-4 text-blue-600" />
                Combination Risk Rules Matrix & Live Sandbox Simulator
                <Badge variant="secondary" className="text-[10px] font-bold bg-blue-100 text-blue-900 border border-blue-200 ml-1">
                  CONFIG
                </Badge>
              </CardTitle>
              <div className="flex items-center gap-2 text-xs font-semibold text-blue-800">
                <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                Dynamic Live Evaluation (256 Combinations)
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            {/* Top Summary Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3.5 rounded-xl border border-gray-200 bg-gray-50/80 text-center">
                <p className="text-2xl font-bold text-gray-900">{combinationCounts.total}</p>
                <p className="text-[11px] font-semibold text-gray-500 mt-0.5">Total Combinations</p>
                <span className="text-[10px] text-gray-400">4⁴ Parameter Matrix</span>
              </div>
              <div className="p-3.5 rounded-xl border border-emerald-200 bg-emerald-50/60 text-center">
                <p className="text-2xl font-bold text-emerald-700">{combinationCounts.low}</p>
                <p className="text-[11px] font-semibold text-emerald-800 mt-0.5">Low Risk (Proceed)</p>
                <span className="text-[10px] text-emerald-600 font-medium">
                  {((combinationCounts.low / combinationCounts.total) * 100).toFixed(1)}% of total
                </span>
              </div>
              <div className="p-3.5 rounded-xl border border-amber-200 bg-amber-50/60 text-center">
                <p className="text-2xl font-bold text-amber-700">{combinationCounts.medium}</p>
                <p className="text-[11px] font-semibold text-amber-800 mt-0.5">Medium Risk (Review)</p>
                <span className="text-[10px] text-amber-600 font-medium">
                  {((combinationCounts.medium / combinationCounts.total) * 100).toFixed(1)}% of total
                </span>
              </div>
              <div className="p-3.5 rounded-xl border border-red-200 bg-red-50/60 text-center">
                <p className="text-2xl font-bold text-red-700">{combinationCounts.high}</p>
                <p className="text-[11px] font-semibold text-red-800 mt-0.5">High Risk (Reject)</p>
                <span className="text-[10px] text-red-600 font-medium">
                  {((combinationCounts.high / combinationCounts.total) * 100).toFixed(1)}% of total
                </span>
              </div>
            </div>

            {/* Live Sandbox Simulator Block */}
            <div className="p-4 rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50/40 via-white to-blue-50/40 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-xs">
                    <Zap className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-gray-900">Interactive Risk Simulator Sandbox</h4>
                    <p className="text-[11px] text-gray-500">Test any percentage score to observe immediate grade and combination evaluation</p>
                  </div>
                </div>
                <span className="text-[10px] font-semibold text-indigo-700 bg-indigo-100 px-2.5 py-1 rounded-md border border-indigo-200">
                  Reflects Current In-Memory Thresholds
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Phonetic Slider */}
                <div className="space-y-1.5 p-2.5 rounded-lg bg-white border border-gray-200">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-gray-700">Phonetic (P)</span>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-blue-600">{simScores.p}%</span>
                      <span className={cn('text-[10px] font-bold px-1.5 py-0.2 rounded border', getGradeBadgeStyle(simResult.pGrade))}>
                        Grade {simResult.pGrade}
                      </span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={simScores.p}
                    onChange={(e) => setSimScores((prev) => ({ ...prev, p: parseInt(e.target.value, 10) }))}
                    className="w-full accent-blue-600 h-1.5 cursor-pointer"
                  />
                </div>

                {/* Spelling Slider */}
                <div className="space-y-1.5 p-2.5 rounded-lg bg-white border border-gray-200">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-gray-700">Spelling (S)</span>
                    <div className="flex items-center gap-1.5">
                      <span className={cn('font-bold', (simResult.sGrade === 'D') ? 'text-red-600' : (simResult.sGrade === 'B' || simResult.sGrade === 'C') ? 'text-amber-600' : 'text-purple-600')}>
                        {simScores.s}%
                      </span>
                      <span className={cn('text-[10px] font-bold px-1.5 py-0.2 rounded border uppercase whitespace-nowrap', getGradeBadgeStyle(simResult.sGrade, 'spelling'))}>
                        Grade {simResult.sGrade}
                      </span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={simScores.s}
                    onChange={(e) => setSimScores((prev) => ({ ...prev, s: parseInt(e.target.value, 10) }))}
                    className="w-full accent-purple-600 h-1.5 cursor-pointer"
                  />
                </div>

                {/* Conceptual Slider */}
                <div className="space-y-1.5 p-2.5 rounded-lg bg-white border border-gray-200">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-gray-700">Conceptual (C)</span>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-indigo-600">{simScores.c}%</span>
                      <span className={cn('text-[10px] font-bold px-1.5 py-0.2 rounded border uppercase whitespace-nowrap', getGradeBadgeStyle(simResult.cGrade, 'conceptual'))}>
                        Grade {simResult.cGrade}
                      </span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={simScores.c}
                    onChange={(e) => setSimScores((prev) => ({ ...prev, c: parseInt(e.target.value, 10) }))}
                    className="w-full accent-indigo-600 h-1.5 cursor-pointer"
                  />
                </div>

                {/* Visual Slider */}
                <div className="space-y-1.5 p-2.5 rounded-lg bg-white border border-gray-200">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-gray-700">Visual (V)</span>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-orange-600">{simScores.v}%</span>
                      <span className={cn('text-[10px] font-bold px-1.5 py-0.2 rounded border uppercase whitespace-nowrap', getGradeBadgeStyle(simResult.vGrade, 'visual'))}>
                        Grade {simResult.vGrade}
                      </span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={simScores.v}
                    onChange={(e) => setSimScores((prev) => ({ ...prev, v: parseInt(e.target.value, 10) }))}
                    className="w-full accent-orange-600 h-1.5 cursor-pointer"
                  />
                </div>
              </div>

              {/* Real-Time Evaluated Result */}
              <div className="p-3.5 rounded-xl border bg-white flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-gray-600">Simulated Combination:</span>
                  <span className="px-3 py-1 rounded-lg font-mono font-bold text-sm bg-gray-900 text-white tracking-widest shadow-xs">
                    {simResult.code}
                  </span>
                  <span className="text-xs text-gray-500 font-mono">
                    (P:{simResult.pGrade} · S:{simResult.sGrade} · C:{simResult.cGrade} · V:{simResult.vGrade})
                  </span>
                </div>

                <div className="flex items-center gap-2.5">
                  <span className="text-xs font-bold text-gray-600">Risk Assessment:</span>
                  <span
                    className={cn(
                      'px-3 py-1 rounded-lg text-xs font-bold border uppercase flex items-center gap-1.5 shadow-2xs whitespace-nowrap',
                      simResult.risk === 'LOW'
                        ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                        : simResult.risk === 'MEDIUM'
                        ? 'bg-amber-100 text-amber-800 border-amber-300'
                        : 'bg-red-100 text-red-800 border-red-300'
                    )}
                  >
                    <span
                      className={cn(
                        'w-2 h-2 rounded-full',
                        simResult.risk === 'LOW' ? 'bg-emerald-600' : simResult.risk === 'MEDIUM' ? 'bg-amber-600' : 'bg-red-600'
                      )}
                    />
                    {simResult.risk} RISK
                  </span>
                  <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 px-2.5 py-1 rounded-lg whitespace-nowrap">
                    {simResult.rec === 'PROCEED' ? 'Clear to Proceed' : simResult.rec === 'LEGAL_REVIEW' ? 'Review Required' : 'Reject / Conflict'}
                  </span>
                </div>
              </div>
            </div>

            {/* Combinations Reference Table */}
            <div className="space-y-3 pt-2 border-t border-gray-100">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {(['ALL', 'LOW', 'MEDIUM', 'HIGH'] as const).map((filterKey) => (
                    <Button
                      key={filterKey}
                      type="button"
                      variant={combinationFilter === filterKey ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setCombinationFilter(filterKey);
                        setMatrixPage(1);
                      }}
                      className={cn(
                        'text-xs font-semibold h-8 px-3 rounded-lg cursor-pointer whitespace-nowrap',
                        combinationFilter === filterKey && filterKey === 'LOW' && 'bg-emerald-600 hover:bg-emerald-700 text-white',
                        combinationFilter === filterKey && filterKey === 'MEDIUM' && 'bg-amber-600 hover:bg-amber-700 text-white',
                        combinationFilter === filterKey && filterKey === 'HIGH' && 'bg-red-600 hover:bg-red-700 text-white'
                      )}
                    >
                      {filterKey === 'ALL'
                        ? `All (${combinationCounts.total})`
                        : filterKey === 'LOW'
                        ? `Low Risk (${combinationCounts.low})`
                        : filterKey === 'MEDIUM'
                        ? `Medium Risk (${combinationCounts.medium})`
                        : `High Risk (${combinationCounts.high})`}
                    </Button>
                  ))}
                </div>

                <div className="relative w-72">
                  <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <Input
                    type="text"
                    placeholder="Search code (e.g. BABA, CACC)..."
                    value={combinationSearch}
                    onChange={(e) => {
                      setCombinationSearch(e.target.value);
                      setMatrixPage(1);
                    }}
                    className="h-8 text-xs pl-8 pr-3"
                  />
                </div>
              </div>

              {/* Table */}
              <div className="border border-gray-200 rounded-xl overflow-hidden bg-white shadow-2xs">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs min-w-[1000px]">
                    <thead className="bg-gray-50/90 border-b border-gray-200 text-gray-700 font-bold uppercase tracking-wider text-[10px]">
                      <tr>
                        <th className="py-3 px-4 w-32 min-w-[120px]">Combination</th>
                        <th className="py-3 px-4 w-32 min-w-[120px]">Phonetic (P)</th>
                        <th className="py-3 px-4 w-32 min-w-[120px]">Spelling (S)</th>
                        <th className="py-3 px-4 w-32 min-w-[120px]">Conceptual (C)</th>
                        <th className="py-3 px-4 w-32 min-w-[120px]">Visual (V)</th>
                        <th className="py-3 px-4 w-32 min-w-[120px]">Risk Level</th>
                        <th className="py-3 px-4 w-44 min-w-[160px]">AI Recommendation</th>
                        <th className="py-3 px-4 min-w-[280px]">Rule Explanation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 font-medium">
                      {paginatedCombinations.map((item) => (
                        <tr key={item.code} className="hover:bg-gray-50/70 transition-colors">
                          <td className="py-3 px-4 font-mono font-bold text-gray-900">
                            <span className="px-2.5 py-1 rounded bg-gray-100 border border-gray-200 tracking-wider whitespace-nowrap inline-block">
                              {item.code}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className={cn('px-2.5 py-1 rounded text-[11px] font-bold border uppercase whitespace-nowrap inline-flex items-center', getGradeBadgeStyle(item.p, 'phonetic'))}>
                              Grade {item.p}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className={cn('px-2.5 py-1 rounded text-[11px] font-bold border uppercase whitespace-nowrap inline-flex items-center', getGradeBadgeStyle(item.s, 'spelling'))}>
                              Grade {item.s}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className={cn('px-2.5 py-1 rounded text-[11px] font-bold border uppercase whitespace-nowrap inline-flex items-center', getGradeBadgeStyle(item.c, 'conceptual'))}>
                              Grade {item.c}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className={cn('px-2.5 py-1 rounded text-[11px] font-bold border uppercase whitespace-nowrap inline-flex items-center', getGradeBadgeStyle(item.v, 'visual'))}>
                              Grade {item.v}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={cn(
                                'px-2.5 py-1 rounded text-[11px] font-bold border uppercase whitespace-nowrap inline-flex items-center',
                                item.risk === 'LOW'
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : item.risk === 'MEDIUM'
                                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                                  : 'bg-red-50 text-red-700 border-red-200'
                              )}
                            >
                              {item.risk}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-semibold text-gray-700 whitespace-nowrap">
                            {item.rec === 'PROCEED' ? 'Clear to Proceed' : item.rec === 'LEGAL_REVIEW' ? 'Review Required' : 'Reject'}
                          </td>
                          <td className="py-3 px-4 text-gray-600 text-xs">
                            {item.risk === 'LOW'
                              ? 'Strictly S is Grade A with P,C,V in Grade A/B.'
                              : item.risk === 'MEDIUM'
                              ? 'Spelling is Grade B/C, or Grade C in P/C/V without Grade D.'
                              : 'Grade D in any parameter.'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50/50 border-t border-gray-100 text-xs text-gray-500">
                  <span>
                    Showing {filteredCombinations.length > 0 ? (matrixPage - 1) * MATRIX_PAGE_SIZE + 1 : 0} to{' '}
                    {Math.min(matrixPage * MATRIX_PAGE_SIZE, filteredCombinations.length)} of {filteredCombinations.length} combinations
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={matrixPage <= 1}
                      onClick={() => setMatrixPage((p) => Math.max(1, p - 1))}
                      className="h-8 text-xs px-3"
                    >
                      Previous
                    </Button>
                    <span className="text-xs font-semibold px-2">
                      Page {matrixPage} of {totalMatrixPages}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={matrixPage >= totalMatrixPages}
                      onClick={() => setMatrixPage((p) => Math.min(totalMatrixPages, p + 1))}
                      className="h-8 text-xs px-3"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Card 4: Notification Preferences */}
      <Card className="border border-gray-200/80 bg-white shadow-sm overflow-hidden">
        <CardHeader className="border-b border-gray-100 bg-gray-50/50 pb-4">
          <CardTitle className="text-sm font-bold text-gray-900 flex items-center gap-2">
            <Bell className="w-4 h-4 text-orange-600" />
            Notification Preferences
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 space-y-4">
          <div className="space-y-4 divide-y divide-gray-100">
            {/* High Risk Alerts */}
            <div className="flex items-center justify-between pt-2">
              <div>
                <p className="text-xs font-bold text-gray-800">High Risk Alerts</p>
                <p className="text-[11px] text-gray-400">Receive alert when screening identifies high risk conflict</p>
              </div>
              <input
                type="checkbox"
                checked={notifHighRisk}
                onChange={(e) => setNotifHighRisk(e.target.checked)}
                className="w-4 h-4 text-orange-600 rounded focus:ring-orange-500"
              />
            </div>

            {/* Generation Complete */}
            <div className="flex items-center justify-between pt-3">
              <div>
                <p className="text-xs font-bold text-gray-800">AI Generation Completion</p>
                <p className="text-[11px] text-gray-400">Notify when candidate brand names finish generating</p>
              </div>
              <input
                type="checkbox"
                checked={notifGenComplete}
                onChange={(e) => setNotifGenComplete(e.target.checked)}
                className="w-4 h-4 text-orange-600 rounded focus:ring-orange-500"
              />
            </div>

            {/* Review Batch Updates */}
            <div className="flex items-center justify-between pt-3">
              <div>
                <p className="text-xs font-bold text-gray-800">Trademark Review Batch Updates</p>
                <p className="text-[11px] text-gray-400">Notify when trademark batch status changes (Approved / Revision)</p>
              </div>
              <input
                type="checkbox"
                checked={notifReviews}
                onChange={(e) => setNotifReviews(e.target.checked)}
                className="w-4 h-4 text-orange-600 rounded focus:ring-orange-500"
              />
            </div>

            {/* System Updates */}
            <div className="flex items-center justify-between pt-3">
              <div>
                <p className="text-xs font-bold text-gray-800">Platform & Regulatory Updates</p>
                <p className="text-[11px] text-gray-400">Receive system notices, scheduled maintenance and WHO INN updates</p>
              </div>
              <input
                type="checkbox"
                checked={notifSystem}
                onChange={(e) => setNotifSystem(e.target.checked)}
                className="w-4 h-4 text-orange-600 rounded focus:ring-orange-500"
              />
            </div>
          </div>

          <div className="flex justify-end pt-4 border-t border-gray-100">
            <Button
              type="button"
              onClick={handleSaveNotifications}
              disabled={!isNotifsDirty}
              className="bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold h-9 px-5 gap-1.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              Save Preferences
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
