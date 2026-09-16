import { useState, useEffect, Dispatch, SetStateAction } from 'react';

/**
 * A React hook that stores and synchronizes state in sessionStorage or localStorage
 * so that state (e.g. date filters, search queries, selected views) is preserved across page reloads.
 *
 * @param key Unique storage key (e.g. 'brandsentry_filter_dash_dateFrom')
 * @param defaultValue Default value when nothing is in storage
 * @param storage 'session' (persists across reloads within browser tab) or 'local' (persists indefinitely)
 */
export function usePersistentState<T>(
  key: string,
  defaultValue: T,
  storage: 'session' | 'local' = 'session'
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const store = storage === 'local' ? window.localStorage : window.sessionStorage;
      const saved = store.getItem(key);
      if (saved !== null) {
        return JSON.parse(saved) as T;
      }
    } catch (e) {
      console.warn(`[usePersistentState] Error reading key "${key}":`, e);
    }
    return defaultValue;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const store = storage === 'local' ? window.localStorage : window.sessionStorage;
      if (state === undefined) {
        store.removeItem(key);
      } else {
        store.setItem(key, JSON.stringify(state));
      }
    } catch (e) {
      console.warn(`[usePersistentState] Error saving key "${key}":`, e);
    }
  }, [key, state, storage]);

  return [state, setState];
}
