import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { landingPathFor } from '@/lib/landing';

// Mirrors the old catch-all `<Route path="*" element={<Navigate to={landing} replace/>}/>`
// — any unknown URL bounces to wherever this user belongs instead of
// showing a dead end.
export default function NotFound() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    router.replace(landingPathFor(user));
  }, [isLoading, user, router]);

  return null;
}
