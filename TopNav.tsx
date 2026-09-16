import { useRouter } from 'next/router';
import { useSectionNav } from '@/contexts/SectionNavContext';
import { cn } from '@/lib/utils';

// Secondary, content-column-only bar for per-page section tabs — the global
// bell/cart/user/breadcrumb header now lives in AppLayout, above both this
// and the sidebar. Renders nothing when a page has none to show, so it
// doesn't leave an empty strip behind. (The case-id/created-by/created-on
// pill row that used to live here was removed per explicit request — it no
// longer shows anywhere.)
export function TopNav() {
  const { tabs, activeKey, goTo } = useSectionNav();
  const router = useRouter();

  // Section tabs (registered by whichever page owns them) are a desktop-only
  // affordance: cramming several tabs into a phone-width top bar would be unusable.
  const showSectionTabs = router.pathname === '/suggestion-form' && tabs && tabs.length > 0;

  if (!showSectionTabs) return null;

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-center px-4 sm:px-6 sticky top-0 z-20">
      {showSectionTabs && (
        <nav className="hidden lg:flex items-center gap-10">
          {tabs!.map((tab) => (
            <button
              key={tab.key}
              onClick={() => goTo(tab.key)}
              className={cn(
                'text-sm pb-1 border-b-2 transition-colors whitespace-nowrap',
                activeKey === tab.key
                  ? 'text-orange-600 border-orange-500 font-medium'
                  : 'text-gray-400 border-transparent hover:text-gray-600'
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}
