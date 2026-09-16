import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

// Landed on after the backend's SAML ACS handler validates the assertion
// and redirects here with the HttpOnly session cookie already established.
export default function SsoCallback() {
  const router = useRouter();
  const { loginWithToken } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!router.isReady) return;

    loginWithToken()
      .then(() => {
        router.replace('/');
      })
      .catch(() => {
        setError('Could not complete SSO sign-in. Please try again.');
      });
  }, [router.isReady, loginWithToken, router]);

  return (
    <div className="h-screen flex items-center justify-center bg-white">
      {error ? (
        <div className="flex flex-col items-center gap-3 text-center px-6">
          <AlertCircle className="w-6 h-6 text-red-500" />
          <p className="text-red-600 text-sm">{error}</p>
          <button
            type="button"
            onClick={() => router.replace('/login')}
            className="text-sm text-orange-600 hover:underline"
          >
            Back to sign in
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <p>Completing sign-in…</p>
        </div>
      )}
    </div>
  );
}
