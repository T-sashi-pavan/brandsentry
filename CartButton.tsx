import Link from 'next/link';
import { useRouter } from 'next/router';
import { ShoppingCart } from 'lucide-react';
import { useCart } from '@/contexts/CartContext';
import { cn } from '@/lib/utils';

// Navigates to the full Review Batch page (see screens/ReviewBatchPage.tsx)
// instead of opening a popup, so the sidebar and page-title pattern common to
// every other module (per the mock, Sun_Pharma_Screens_V1.2.pptx slide 11)
// stays intact here too. Deliberately NOT listed in the sidebar itself (per
// direct instruction) — this button is its only entry point.
export function CartButton() {
  const { count } = useCart();
  const router = useRouter();
  const isActive = router.pathname === '/review-batch';

  return (
    <Link
      href="/review-batch"
      className={cn(
        'relative flex items-center gap-1.5 h-9 px-3 rounded-lg transition-colors text-sm font-medium',
        isActive || count > 0 ? 'text-orange-700 hover:bg-orange-50' : 'text-gray-500 hover:bg-gray-50',
      )}
      title="Review batch"
    >
      <ShoppingCart className="w-5 h-5" />
      <span className="hidden sm:inline">Review Batch</span>
      {count > 0 && (
        <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-orange-600 text-white text-[10px] font-bold flex items-center justify-center">
          {count}
        </span>
      )}
    </Link>
  );
}
