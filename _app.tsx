import NextApp, { type AppContext, type AppProps } from 'next/app';
import Head from 'next/head';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/contexts/AuthContext';
import { CartProvider } from '@/contexts/CartContext';
import { ActiveCaseProvider } from '@/contexts/ActiveCaseContext';
import { SectionNavProvider } from '@/contexts/SectionNavContext';
import '@/styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000,
    },
  },
});

// Every page in this app has no getStaticProps/getServerSideProps, so
// Next.js's Automatic Static Optimization prerenders all of them once at
// BUILD time — meaning _document.tsx's per-request CSP nonce (read from the
// x-nonce header middleware.ts sets on each real request) is baked into the
// static HTML as empty/stale forever, never matching the fresh nonce
// middleware puts on the actual response header. Every build-time-nonce'd
// (or non-nonce'd) script tag then gets blocked by the runtime CSP —
// exactly the blank-page "script violates CSP" failure. Defining
// getInitialProps here (even as a pass-through) is Next's documented way to
// disable that static optimization for every page sharing this _app, so
// _document's getInitialProps — and the nonce it reads — runs fresh on
// every request instead of once at build time. These pages already fetch
// all their real data client-side after mount (see AuthProvider/ProtectedPage),
// so there's no static-generation benefit being given up here.
export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>BrandSentry</title>
        <meta name="description" content="BrandSentry: Enterprise Pharmaceutical Brand Intelligence Platform" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=5" />
      </Head>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <CartProvider>
            <ActiveCaseProvider>
              <SectionNavProvider>
                <Component {...pageProps} />
                {/* offset clears the fixed 44px (h-11) app header — without
                    it, a toast's close button can land underneath the
                    header's own bell/cart/user-menu icons and never
                    receive the click. */}
                <Toaster position="top-right" richColors closeButton offset={{ top: '64px' }} />
              </SectionNavProvider>
            </ActiveCaseProvider>
          </CartProvider>
        </AuthProvider>
      </QueryClientProvider>
    </>
  );
}

App.getInitialProps = async (appContext: AppContext) => {
  const appProps = await NextApp.getInitialProps(appContext);
  return { ...appProps };
};
