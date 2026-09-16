import React, { createContext, useContext, useState, useRef, useCallback } from 'react';

// Lets a page register a set of "jump to this section" tabs (and which one
// is currently in view) so TopNav — a sibling, not a parent, of the page —
// can render them as a desktop-only tab bar. Only the Suggestion Form uses
// this today, but it's generic: any page could register its own tabs.
export interface SectionTab {
  key: string;
  label: string;
}

interface SectionNavContextValue {
  tabs: SectionTab[] | null;
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
  goTo: (key: string) => void;
  register: (tabs: SectionTab[], goToFn: (key: string) => void) => void;
  unregister: () => void;
}

const SectionNavContext = createContext<SectionNavContextValue | null>(null);

export function SectionNavProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<SectionTab[] | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const goToRef = useRef<(key: string) => void>(() => {});

  const register = useCallback((newTabs: SectionTab[], goToFn: (key: string) => void) => {
    goToRef.current = goToFn;
    setTabs(newTabs);
  }, []);

  const unregister = useCallback(() => {
    goToRef.current = () => {};
    setTabs(null);
    setActiveKey(null);
  }, []);

  const goTo = useCallback((key: string) => goToRef.current(key), []);

  return (
    <SectionNavContext.Provider value={{ tabs, activeKey, setActiveKey, goTo, register, unregister }}>
      {children}
    </SectionNavContext.Provider>
  );
}

export function useSectionNav() {
  const ctx = useContext(SectionNavContext);
  if (!ctx) throw new Error('useSectionNav must be used within SectionNavProvider');
  return ctx;
}
