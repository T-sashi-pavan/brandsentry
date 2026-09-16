import React, { createContext, useContext, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useAuth } from './AuthContext';
import type { CartItem } from '@/types';

export type { CartItem };

// The cart stages brand names server-side (GET/POST/DELETE /cart) until the
// user "checks out" and submits them to Trademark Review as one batch.
// Scoped per logged-in user via the JWT, so it's visible from any device or
// browser once logged in — replaces the earlier localStorage-only version,
// which had no way to show the same cart on a second device.

interface CartContextValue {
  items: CartItem[];
  count: number;
  isLoading: boolean;
  has: (brandName: string) => boolean;
  // True once a name has ever been submitted to Trademark Review (any status,
  // including already-decided ones) — a name leaves the cart the moment it's
  // submitted, so `has()` alone goes back to false right after, which used to
  // silently re-enable "Add to Review Batch" for a name already under review.
  isSubmitted: (brandName: string) => boolean;
  add: (item: Omit<CartItem, 'id'>) => Promise<boolean>; // resolves false if already present
  remove: (brandName: string) => Promise<void>;
  clear: () => Promise<void>;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();

  const cartQuery = useQuery({
    queryKey: ['cart'],
    queryFn: () => apiClient.getCartItems(),
    enabled: isAuthenticated,
    staleTime: 30 * 1000,
  });

  const items = cartQuery.data ?? [];

  // Cheap, org-wide list (not per-user) — whether a name is "already submitted"
  // doesn't depend on who happens to be looking at it.
  const submittedQuery = useQuery({
    queryKey: ['legal-submitted-names'],
    queryFn: () => apiClient.getSubmittedReviewNames(),
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });
  const submittedNames = submittedQuery.data ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cart'] });
    qc.invalidateQueries({ queryKey: ['legal-submitted-names'] });
  };

  const addMutation = useMutation({
    mutationFn: (item: Omit<CartItem, 'id'>) => apiClient.addCartItem(item),
    onSuccess: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => apiClient.removeCartItem(id),
    onSuccess: invalidate,
  });
  const clearMutation = useMutation({
    mutationFn: () => apiClient.clearCart(),
    onSuccess: invalidate,
  });

  const has = useCallback(
    (brandName: string) =>
      items.some(i => i.brand_name.trim().toLowerCase() === brandName.trim().toLowerCase()),
    [items]
  );

  const isSubmitted = useCallback(
    (brandName: string) => {
      const target = brandName.trim().toLowerCase();
      return submittedNames.some(n => n.trim().toLowerCase() === target);
    },
    [submittedNames]
  );

  const add = useCallback(
    async (item: Omit<CartItem, 'id'>) => {
      // Backstop, not the primary gate — every "Add to Review Batch" button
      // is expected to already be disabled once isSubmitted() is true, but
      // this keeps a stale/bypassed button from actually creating a new cart
      // row for a name that's already gone through the review workflow.
      if (isSubmitted(item.brand_name)) return false;
      const result = await addMutation.mutateAsync(item);
      return result.added;
    },
    [addMutation, isSubmitted]
  );

  const remove = useCallback(
    async (brandName: string) => {
      const existing = items.find(
        i => i.brand_name.trim().toLowerCase() === brandName.trim().toLowerCase()
      );
      if (existing) await removeMutation.mutateAsync(existing.id);
    },
    [items, removeMutation]
  );

  const clear = useCallback(async () => {
    await clearMutation.mutateAsync();
  }, [clearMutation]);

  return (
    <CartContext.Provider
      value={{ items, count: items.length, isLoading: cartQuery.isLoading, has, isSubmitted, add, remove, clear }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
