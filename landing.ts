import type { User } from '@/types';

// Where a given user should land after login (or when hitting a route
// their role can't use), matching BRD Section 5.2.8 & 5.2.12.
export function landingPathFor(user: User | null): string {
  if (!user) return '/login';
  const role = user.role;
  const isSuper = !!user.is_superuser || role === 'super_admin';

  if (isSuper || role === 'admin' || role === 'brand_market_admin' || role === 'trademark_admin') {
    return '/dashboard';
  }
  if (role === 'trademark_user' || role === 'trademark_team') {
    return '/trademark-review';
  }
  return '/generator';
}

// Check if a user is restricted from business generator tools
export function isRestrictedFromBusinessTools(user: User | null): boolean {
  return false; // In BRD 5.2.12, all roles can view/generate/analyze brand names for reference
}

