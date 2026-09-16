import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { Pill, Eye, EyeOff, Loader2, AlertCircle, Check } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { apiClient } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// Mentor-provided copy for the left hero panel.
const FEATURES = [
  'AI-Powered Name Generation',
  'Multi-Source Brand Screening',
  'Trademark Conflict Detection',
  'Review & Decision Support',
];

export function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [ssoEnabled, setSsoEnabled] = useState(false);

  // Button always renders; whether clicking it actually starts the SAML
  // flow or just warns "not integrated yet" depends on this (see
  // settings.sso_enabled in app/core/config.py, set once the client's
  // Entra ID admin hands back real SAML_IDP_* values).
  useEffect(() => {
    apiClient.ssoStatus()
      .then((res) => setSsoEnabled(res.enabled))
      .catch(() => setSsoEnabled(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) { setError('Please enter email and password'); return; }
    setLoading(true);
    try {
      await login(email, password);
      router.push('/');
    } catch (err: any) {
      const msg = err?.response?.data?.detail;
      if (err?.response?.status === 403) {
        setError(msg || 'Your account has been deactivated. Please contact your platform administrator.');
      } else if (err?.response?.status === 503 || msg?.toLowerCase()?.includes('rds') || msg?.toLowerCase()?.includes('database')) {
        setError(msg || 'AWS RDS Database is currently inactive or unreachable. Please verify RDS instance status in AWS Console.');
      } else if (err?.code === 'ERR_NETWORK' || !err?.response) {
        setError('Backend server or AWS RDS Database is currently unreachable. Please verify that the RDS instance is active.');
      } else if (err?.response?.status === 401) {
        setError(msg || 'Invalid email or password.');
      } else {
        setError(msg || 'Authentication failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex bg-white overflow-hidden">

      {/* ── Left panel ─────────────────────────────────────────────────────── */}
      <div className="hidden lg:flex flex-col justify-center gap-6 w-[52%] bg-orange-50 border-r border-orange-100 px-12 py-10">

        {/* Logo */}
        <div className="flex items-center gap-4 mb-5">
          <div className="w-12 h-12 bg-orange-500 rounded-xl flex items-center justify-center shadow-sm flex-shrink-0">
            <Pill className="w-7 h-7 text-white" />
          </div>
          <div className="flex flex-col gap-0.5">
            <p className="text-gray-900 font-bold text-xl leading-tight">BrandSentry</p>
            <p className="text-orange-500 text-sm font-medium">Brand Intelligence Platform</p>
          </div>
        </div>

        {/* Hero text */}
        <div>
          <h1 className="text-4xl font-extrabold text-gray-900 mb-4 leading-tight">
            Make Better<br />
            <span className="text-orange-500">Brand Decisions</span>
          </h1>
          <p className="text-gray-500 text-base mb-6">
            AI-powered intelligence to generate, screen and analyze brand names.
          </p>
          <ul className="space-y-2.5 mb-8">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-center gap-2.5 text-sm font-medium text-gray-700">
                <span className="w-5 h-5 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
                  <Check className="w-3 h-3 text-orange-600" />
                </span>
                {f}
              </li>
            ))}
          </ul>
          <div className="pt-6 border-t border-orange-100">
            <p className="text-gray-900 font-bold">From Brand Idea to Trademark Review</p>
            <p className="text-gray-500 text-sm mt-1">One unified workflow for smarter brand decisions.</p>
          </div>
        </div>
      </div>

      {/* ── Right panel — login form ────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col justify-center items-center px-6 py-12 bg-white overflow-y-auto">
        <div className="w-full max-w-md">

          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-10 h-10 bg-orange-500 rounded-xl flex items-center justify-center">
              <Pill className="w-6 h-6 text-white" />
            </div>
            <p className="text-xl font-bold text-gray-900">BrandSentry Platform</p>
          </div>

          <div className="mb-8">
            <h2 className="text-3xl font-bold text-gray-900">Welcome back</h2>
            <p className="text-gray-400 mt-1">Sign in to your account to continue</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label className="text-sm font-medium text-gray-700 mb-1.5 block">Email Address</Label>
              <Input
                type="email"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11"
                autoComplete="email"
                required
              />
            </div>

            <div>
              <Label className="text-sm font-medium text-gray-700 mb-1.5 block">Password</Label>
              <div className="relative">
                <Input
                  type={showPass ? 'text' : 'password'}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 pr-11"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button
              type="submit" size="lg"
              className="w-full h-11 text-base bg-orange-500 hover:bg-orange-600 text-white font-medium shadow-sm transition-all"
              disabled={loading}
            >
              {loading && <Loader2 className="w-5 h-5 animate-spin mr-2" />}
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>

          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs text-gray-400 font-medium">OR</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full h-11 text-base font-medium"
            onClick={() => {
              if (ssoEnabled) {
                window.location.href = `${BASE_URL}/auth/sso/login`;
              } else {
                setError('SSO keys are not integrated yet. Please contact your administrator.');
              }
            }}
          >
            <svg className="w-4 h-4 mr-2" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Sign in with Microsoft
          </Button>
        </div>
      </div>

    </div>
  );
}
