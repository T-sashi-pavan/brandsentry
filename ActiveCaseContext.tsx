import React, { createContext, useContext, useState, useCallback } from 'react';

// Case metadata shown in the top bar once a backend-confirmed case exists —
// TopNav is a sibling of the page content (both live under AppLayout), so
// this has to be shared state rather than a prop passed down from a page.
export interface ActiveCaseInfo {
  caseId: string;
  createdBy: string;
  createdAt: string;
}

interface ActiveCaseContextValue {
  activeCase: ActiveCaseInfo | null;
  setActiveCase: (info: ActiveCaseInfo | null) => void;
}

const ActiveCaseContext = createContext<ActiveCaseContextValue | null>(null);

export function ActiveCaseProvider({ children }: { children: React.ReactNode }) {
  const [activeCase, setActiveCaseState] = useState<ActiveCaseInfo | null>(null);
  const setActiveCase = useCallback((info: ActiveCaseInfo | null) => setActiveCaseState(info), []);

  return (
    <ActiveCaseContext.Provider value={{ activeCase, setActiveCase }}>
      {children}
    </ActiveCaseContext.Provider>
  );
}

export function useActiveCase() {
  const ctx = useContext(ActiveCaseContext);
  if (!ctx) throw new Error('useActiveCase must be used within ActiveCaseProvider');
  return ctx;
}
