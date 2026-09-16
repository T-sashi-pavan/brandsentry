import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { landingPathFor } from '@/lib/landing';

// "/" itself never renders anything, it just forwards to wherever this user
// (or a not-yet-logged-in visitor) belongs — see landingPathFor.
export default function Index() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    router.replace(landingPathFor(user));
  }, [isLoading, user, router]);

  return null;
}
