import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Per-request CSP nonce, following Next.js's own documented pattern for
// script-src nonces on the Pages Router: generated here, threaded through
// to pages/_document.tsx via the x-nonce request header (read there and
// applied to NextScript's own injected chunks), and set directly on the
// response's Content-Security-Policy header. 'strict-dynamic' lets
// webpack's code-split chunks (this app dynamically imports jspdf,
// html2canvas, xlsx, dompurify) inherit trust from the nonce'd script that
// triggers them, without which those dynamic imports would be blocked
// even though the initiating script is trusted.
//
// 'unsafe-eval' is dev-only — Next.js's dev-mode webpack config uses
// eval() for its default source-map devtool (Fast Refresh's error
// overlay depends on it), so a strict CSP would break `next dev` locally.
// Production builds (`next build` + `next start`, see Dockerfile) don't
// use eval() for their own bundles, so this narrows to nothing in prod.
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV !== 'production';

  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  // style-src: nonce-gated in production, same as script-src above.
  // NOTE (M-08 follow-up — needs a browser smoke test, couldn't run one
  // here): 'unsafe-inline' was previously kept deliberately for Tailwind/
  // Radix runtime inline styles. A nonce only covers <style>/<link>
  // elements per the CSP spec — it does NOT allow inline style="..."
  // attributes, which is exactly how Radix applies its popover/dropdown/
  // select positioning (style={{...}} on the element). So this change may
  // well visually break that positioning in a production build even though
  // it satisfies the CSP finding; verify Radix popovers/dropdowns/selects
  // render correctly in `next build && next start` before treating this as
  // fully resolved, and fall back to 'unsafe-inline' in prod if they don't.
  const styleSrc = isDev
    ? "style-src 'self' 'unsafe-inline'"
    : `style-src 'self' 'nonce-${nonce}'`;

  // connect-src's backend origin: prefer the configured NEXT_PUBLIC_API_URL,
  // but if it's unset or looks like a dev/placeholder value, derive it from
  // the incoming request instead of hardcoding localhost — otherwise a real
  // deployment with a misconfigured/missing env var would have its actual
  // API origin silently blocked by this CSP.
  const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL || '';
  const looksLikePlaceholder = !configuredApiUrl || /localhost|127\.0\.0\.1|placeholder|<.*>/i.test(configuredApiUrl);
  let backendOrigin: string;
  if (!looksLikePlaceholder) {
    backendOrigin = configuredApiUrl;
  } else {
    const hostHeader = request.headers.get('host') || request.nextUrl.host || '';
    const hostname = hostHeader.split(':')[0];
    const protocol = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '') || 'http';
    backendOrigin = hostname ? `${protocol}://${hostname}:8000` : configuredApiUrl || 'http://localhost:8000';
  }

  const cspHeader = [
    "default-src 'self'",
    scriptSrc,
    styleSrc,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${backendOrigin}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('Content-Security-Policy', cspHeader);
  // Defense-in-depth alongside frame-ancestors above.
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

export const config = {
  // Skip static assets and Next's own internals — a nonce'd CSP on those
  // achieves nothing (no HTML/script execution context) and would just add
  // per-request overhead to every asset request.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
