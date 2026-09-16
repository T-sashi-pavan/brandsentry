import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { landingPathFor } from '@/lib/landing';
import { LoginPage } from '@/screens/LoginPage';

export default function Login() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  // Already signed in? Don't show the login form — bounce straight to
  // wherever this user belongs (mirrors the old
  // `isAuthenticated ? <Navigate to={landing}/> : <LoginPage/>` route).
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace(landingPathFor(user));
    }
  }, [isLoading, isAuthenticated, user, router]);

  if (isLoading || isAuthenticated) return null;

  return <LoginPage />;
}
