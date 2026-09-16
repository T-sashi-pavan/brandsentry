import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { useQueries, useMutation, useQuery } from '@tanstack/react-query';
import {
  Loader2, GitCompare, Trophy, X, Plus, FileSpreadsheet,
  ArrowRight, Zap, Sparkles, ShoppingCart, Download, ShieldCheck, ChevronDown,
  Eye, FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/api/client';
import { useCart } from '@/contexts/CartContext';
import { useAuth } from '@/contexts/AuthContext';
import { useActiveCase } from '@/contexts/ActiveCaseContext';
import { CaseSelector } from '@/components/CaseSelector';
import { CaseFormDetailsModal } from '@/components/CaseFormDetailsModal';
import { cn, formatDate } from '@/lib/utils';
import { downloadCompareReport, downloadCompareNamesTemplate } from '@/lib/report';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getCase, caseDisplayName, type BrandCase } from '@/lib/caseStore';
import type { GeneratedName, ScreeningResult, CompareSource } from '@/types';

const MAX_NAMES = 20;
const MIN_NAMES = 2;
const STORAGE_KEY = 'pharma_compare_names';

// ── helpers ────────────────────────────────────────────────────────────────────

function riskColor(score: number) {
  if (score >= 70) return 'text-red-600';
  if (score >= 40) return 'text-orange-500';
  return 'text-green-600';
}
function riskBg(score: number) {
  if (score >= 70) return 'bg-red-500';
  if (score >= 40) return 'bg-orange-400';
  return 'bg-green-500';
}
function classificationBadge(cls?: string) {
  if (cls === 'HIGH') return 'bg-red-100 text-red-700 border border-red-200';
  if (cls === 'MEDIUM') return 'bg-orange-100 text-orange-700 border border-orange-200';
  return 'bg-green-100 text-green-700 border border-green-200';
}
function recommendationBadge(rec?: string) {
  if (rec === 'REJECT') return 'bg-red-100 text-red-700 border border-red-200';
  if (rec === 'LEGAL_REVIEW') return 'bg-orange-100 text-orange-700 border border-orange-200';
  return 'bg-green-100 text-green-700 border border-green-200';
}
function recommendationLabel(rec?: string) {
  if (rec === 'REJECT') return 'Reject';
  if (rec === 'LEGAL_REVIEW') return 'Trademark Review Required';
  if (rec === 'PROCEED') return 'Proceed';
  return rec ?? 'N/A';
}
const classificationRank = (c?: string) => (c === 'LOW' ? 0 : c === 'MEDIUM' ? 1 : 2);
const recommendationRank = (r?: string) => (r === 'PROCEED' ? 0 : r === 'LEGAL_REVIEW' ? 1 : 2);

// Availability is the exact inverse of risk (see generator.py's
// _score_candidate: `availability_score = 100 - risk_score`) — always
// derivable from a field every screening result already has, for any name
// regardless of source.
const availabilityFor = (sr: ScreeningResult) => Math.max(0, 100 - sr.overall_risk_score);

// The single highest similarity dimension across every sub-score the
// deterministic pipeline already computes — a one-number summary of "how
// close is the closest match," with "View Screening" as the way to see the
// full per-dimension breakdown.
const maxSimilarityFor = (sr: ScreeningResult) => Math.max(
  sr.phonetic_similarity_score, sr.semantic_similarity_score,
  sr.lookalike_score, sr.spelling_similarity_score,
);

// Which page this name's data actually came from — shown under the name in
// the results header instead of a redundant "+ Batch" (the real add-to-
// batch action already lives in the Actions row at the bottom).
function sourceLabel(source: CompareSource | undefined): string {
  if (source === 'generator_history') return 'AI Name Generator';
  if (source === 'screening_history') return 'Brand Analysis';
  return 'Freshly Screened';
}

// Which columns "win" a metric. Lower is better for risk/conflicts/similarity.
// tol = tie tolerance; if the whole row is within tol, nobody wins (it's a tie).
function winnerFlags(values: number[], lowerIsBetter = true, tol = 0): boolean[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min <= tol) return values.map(() => false);
  const best = lowerIsBetter ? min : max;
  return values.map(v => Math.abs(v - best) <= tol);
}

// Same as winnerFlags, but for metrics that can legitimately be missing for
// some columns (Memorability/Pronunciation Ease only exist for names that
// came from AI Name Generator) — a winner is only ever crowned among the
// columns that actually have a value, and only when at least two do.
function winnerFlagsNullable(values: Array<number | null | undefined>, lowerIsBetter = true, tol = 0): boolean[] {
  const present = values
    .map((v, i) => (v == null ? null : { v, i }))
    .filter((x): x is { v: number; i: number } => x !== null);
  const out = values.map(() => false);
  if (present.length < 2) return out;
  const flags = winnerFlags(present.map(p => p.v), lowerIsBetter, tol);
  present.forEach((p, idx) => { out[p.i] = flags[idx]; });
  return out;
}

// Case-insensitive dedup that reports what it dropped, instead of silently
// discarding repeats via `new Set(...)` with no feedback — "Fynaxis" typed
// into two slots used to just vanish down to one entry with no explanation.
function dedupeCaseInsensitive(items: string[]): { unique: string[]; dupes: string[] } {
  const seen = new Set<string>();
  const unique: string[] = [];
  const dupes: string[] = [];
  for (const n of items) {
    const key = n.toLowerCase();
    if (seen.has(key)) { dupes.push(n); continue; }
    seen.add(key);
    unique.push(n);
  }
  return { unique, dupes };
}

// ── cell renderers ───────────────────────────────────────────────────────────────

// `higherIsBetter` flips which end of the scale reads as "good" for color
// purposes only — Availability/Memorability/Pronunciation Ease all score
// 0-100 same as Risk, but a high value there is the desirable outcome, not a
// red flag, so the color is computed off the inverted value while the bar's
// width still reflects the real score.
function ScoreCell({ value, win, higherIsBetter = false }: { value: number; win: boolean; higherIsBetter?: boolean }) {
  const colorValue = higherIsBetter ? 100 - value : value;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={`text-lg font-bold ${riskColor(colorValue)}`}>
          {value.toFixed(0)}<span className="text-xs font-normal text-gray-400">/100</span>
        </span>
        {win && <Trophy className="w-4 h-4 text-yellow-500 flex-shrink-0" />}
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${riskBg(colorValue)}`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  );
}

function SimCell({ value, win }: { value: number; win: boolean }) {
  const color = value >= 70 ? 'bg-red-400' : value >= 40 ? 'bg-orange-400' : 'bg-green-400';
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-gray-700">{value.toFixed(0)}%</span>
        {win && <Trophy className="w-3 h-3 text-yellow-500 flex-shrink-0" />}
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  );
}

function NumCell({ value, win }: { value: number; win: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-xl font-bold ${value === 0 ? 'text-green-600' : value > 5 ? 'text-red-600' : 'text-orange-500'}`}>
        {value}
      </span>
      {win && <Trophy className="w-4 h-4 text-yellow-500 flex-shrink-0" />}
    </div>
  );
}

function BadgeCell({ text, badge, win }: { text: string; badge: string; win: boolean }) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${badge}`}>{text}</span>
      {win && <Trophy className="w-4 h-4 text-yellow-500 flex-shrink-0" />}
    </div>
  );
}

interface NameOption {
  name: string;
  source?: CompareSource;
  risk_score?: number;
  risk_level?: string;
  recommendation?: string;
}

// A plain <input> plus a custom-styled suggestions panel (matching the app's
// own dropdowns — white background, rounded-xl, orange hover) — replaces an
// earlier attempt using a native <datalist>.
//
// Opens ONLY via the trailing chevron button — typing or focusing the input
// filters the list live.
function NameSuggestField({
  value, onChange, onEnter, placeholder, disabled, options, exclude, className, arrowClassName = 'right-3',
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  disabled?: boolean;
  options: NameOption[];
  // Names already used elsewhere (other slots/chips) — left out of the
  // suggestion list so picking one can't create a duplicate.
  exclude?: string[];
  className?: string;
  arrowClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const q = value.trim().toLowerCase();
  const excluded = new Set((exclude ?? []).map(n => n.trim().toLowerCase()));
  const filtered = options
    .filter(o => !excluded.has(o.name.trim().toLowerCase()))
    .filter(o => !q || o.name.toLowerCase().includes(q));

  return (
    <div className="relative" ref={wrapRef}>
      <input
        type="text"
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => { if (options.length > 0) setOpen(true); }}
        onClick={() => { if (options.length > 0) setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { setOpen(false); onEnter?.(); }
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        aria-label="Show suggested names for this case"
        title="Show suggested names for this case"
        className={cn('absolute top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed', arrowClassName)}
      >
        <ChevronDown className={cn('w-4 h-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && !disabled && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-gray-200 rounded-xl shadow-xl max-h-64 overflow-y-auto py-1 divide-y divide-gray-50">
          {filtered.length === 0 ? (
            <p className="px-3.5 py-3 text-xs text-gray-400">No matching candidate names found for this case</p>
          ) : (
            filtered.map(o => {
              const isLow = o.risk_level === 'LOW' || (o.risk_score !== undefined && o.risk_score < 30);
              const isMed = o.risk_level === 'MEDIUM' || (o.risk_score !== undefined && o.risk_score >= 30 && o.risk_score < 65);
              const isHigh = o.risk_level === 'HIGH' || (o.risk_score !== undefined && o.risk_score >= 65);
              return (
                <button
                  key={o.name}
                  type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => { onChange(o.name); setOpen(false); }}
                  className="w-full flex items-center justify-between gap-2 text-left px-3.5 py-2.5 text-sm text-gray-800 hover:bg-orange-50 hover:text-orange-950 transition-colors"
                >
                  <span className="font-semibold text-gray-900 truncate">{o.name}</span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {isLow && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">
                        Low Risk
                      </span>
                    )}
                    {isMed && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-200">
                        Medium Risk
                      </span>
                    )}
                    {isHigh && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                        High Risk
                      </span>
                    )}
                    {o.source && (
                      <span className="text-[10px] font-medium text-gray-500 bg-gray-100 rounded-full px-2 py-0.5 border border-gray-200">
                        {sourceLabel(o.source)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ── main component ─────────────────────────────────────────────────────────────

type Ready = { name: string; sr: ScreeningResult; source: CompareSource | undefined };

// localStorage/performance don't exist during Next's build-time static
// prerender (server-side) — every direct access below that runs during
// initial render (not inside an effect/handler) is wrapped defensively.
// Uses localStorage (not sessionStorage) so a compared set of names survives
// a full page reload, not just in-tab navigation.
function readStoredNames(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function ComparePage() {
  const router = useRouter();
  const cart = useCart();
  const { hasPermission } = useAuth();
  const { setActiveCase: setTopBarCase } = useActiveCase();
  // Which case was linked — survives a remount (navigating away and back)
  // the same way the compared names themselves do, instead of silently
  // resetting to "no case" on every navigation.
  const CASE_STORAGE_KEY = 'pharma_compare_active_case_id';
  const initialCaseId = (() => {
    try { return localStorage.getItem(CASE_STORAGE_KEY) || ''; } catch { return ''; }
  })();
  const initialCase = initialCaseId ? getCase(initialCaseId) ?? null : null;
  const [selectedCaseId, setSelectedCaseId] = useState<string>(initialCase?.case_id ?? '');
  const [activeCase, setActiveCase] = useState<BrandCase | null>(initialCase);
  const [showViewCaseModal, setShowViewCaseModal] = useState(false);

  // Names actually generated (AI Name Generator) or screened (Brand
  // Analysis) for this case — Compare Names only compares candidates that
  // came from one of those two places for the linked case, not anything
  // typed ad-hoc (see handleCompare/handleUpload below).
  const caseNamesQuery = useQuery({
    queryKey: ['case-names', activeCase?.case_id],
    queryFn: () => apiClient.getCaseNames(activeCase!.case_id),
    enabled: !!activeCase,
    staleTime: 60 * 1000,
  });
  const knownCaseNames = new Set((caseNamesQuery.data?.names ?? []).map(n => n.trim().toLowerCase()));

  // Synchronize submitted and input names with valid case names once query loads
  useEffect(() => {
    if (!activeCase || !caseNamesQuery.isSuccess) return;
    const valid = new Set((caseNamesQuery.data?.names ?? []).map(n => n.trim().toLowerCase()));
    setSubmitted(prev => {
      const filtered = prev.filter(n => valid.has(n.trim().toLowerCase()));
      if (filtered.length !== prev.length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
        return filtered;
      }
      return prev;
    });
    setNames(prev => {
      const filtered = prev.filter(n => !n.trim() || valid.has(n.trim().toLowerCase()));
      if (filtered.length < MIN_NAMES) return padNames(filtered);
      return filtered;
    });
  }, [activeCase, caseNamesQuery.isSuccess, caseNamesQuery.data]);

  // Silently restores the top-bar case chip on remount — no toast, no
  // re-running addSuggestion (which could unexpectedly overwrite a name
  // slot the user already filled independently).
  useEffect(() => {
    if (initialCase) {
      setTopBarCase({
        caseId: initialCase.case_id,
        createdBy: initialCase.suggested_by || 'Unknown',
        createdAt: formatDate(initialCase.saved_at),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── initial names (localStorage first paint › URL name1..nameN once router
  // hydrates › two blanks). Next's router.query is empty until router.isReady,
  // so the URL-params priority from the original app is applied a moment later
  // via the effect below instead of during this initial render.
  const [names, setNames] = useState<string[]>(() => {
    const saved = readStoredNames();
    if (saved.length >= MIN_NAMES) return padNames(saved);
    return ['', ''];
  });

  const [submitted, setSubmitted] = useState<string[]>(() => {
    return readStoredNames().filter((n: string) => n && n.trim().length >= 2);
  });

  const appliedUrlNamesRef = useRef(false);

  // Apply ?name1=..&name2=.. (back-compat with "Compare with Another") once the
  // router has hydrated — overrides the sessionStorage-restored state above,
  // matching the original priority (URL beats sessionStorage).
  useEffect(() => {
    if (!router.isReady || appliedUrlNamesRef.current) return;
    appliedUrlNamesRef.current = true;
    const fromUrl: string[] = [];
    for (let i = 1; i <= MAX_NAMES; i++) {
      const v = router.query[`name${i}`];
      if (typeof v === 'string' && v) fromUrl.push(v);
    }
    if (!fromUrl.length) return;
    setNames(padNames(fromUrl));
    const cleaned = fromUrl.filter(n => n.trim().length >= 2);
    if (cleaned.length >= MIN_NAMES) setSubmitted(cleaned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  const [suggestions, setSuggestions] = useState<GeneratedName[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountRef = useRef(true);

  // ── compare every submitted name (dynamic list of queries) ───────────────────
  // Same WHO INN/IQVIA/Google/e-pharmacy pipeline as Brand Analysis, but
  // DB-first: apiClient.compareBrand serves an existing Brand Screening or
  // AI Name Generator history record (within 90 days) directly when one
  // exists, only running the full pipeline for a new/stale name.
  const queries = useQueries({
    queries: submitted.map(n => ({
      queryKey: ['compare', n, activeCase?.case_id],
      queryFn: () => apiClient.compareBrand({ brand_name: n.trim(), case_id: activeCase?.case_id }),
      enabled: n.trim().length >= 2,
      staleTime: 10 * 60 * 1000,
      gcTime: Infinity,
    })),
  });

  const queryErrors = queries.filter(q => q.isError);
  useEffect(() => {
    if (queryErrors.length > 0) {
      const err = queryErrors[0].error as { response?: { data?: { detail?: string } }; message?: string };
      const msg = err?.response?.data?.detail || err?.message || 'Failed to compare some candidate names.';
      toast.error(msg);
    }
  }, [queryErrors.length]);

  // ── AI suggestions based on the first name (click to add a column) ───────────
  const firstName = names[0]?.trim() ?? '';
  const suggestMutation = useMutation({
    mutationFn: (name: string) => apiClient.generateBrandNames({
      product_attributes: `Pharmaceutical brand name with similar style and category to "${name}"`,
      count: 5,
    }),
    onSuccess: (data) => setSuggestions(data),
  });

  useEffect(() => {
    if (isMountRef.current) { isMountRef.current = false; return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (firstName.length < 3) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(() => suggestMutation.mutate(firstName), 700);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstName]);

  // Draft text for the results view's single "type a name and press Enter"
  // input (mock slide 13) — separate from the pre-compare hero's numbered
  // slots above, which stay untouched once results are showing.
  const [newNameDraft, setNewNameDraft] = useState('');

  // ── input handlers ───────────────────────────────────────────────────────────
  const updateName = (i: number, val: string) =>
    setNames(prev => prev.map((n, idx) => (idx === i ? val : n)));

  const addName = (preset = '') =>
    setNames(prev => (prev.length >= MAX_NAMES ? prev : [...prev, preset]));

  // Also drops the name from `submitted` (and its persisted copy) when it was
  // already part of a comparison — otherwise removing a chip from the
  // results view left its row/column in the table untouched, since that
  // table renders off `submitted`/`ready`, not `names`.
  //
  // Pads back up to MIN_NAMES with a blank slot instead of refusing the
  // removal outright when already at the floor — refusing left the "removed"
  // value still sitting in `names`, so the moment removing it also dropped
  // `ready` below 2 and the view fell back to the hero, that hero rendered
  // the untouched pair and the just-removed name looked like it had come
  // back on its own.
  const removeName = (i: number) => {
    const removed = names[i]?.trim().toLowerCase();
    setNames(prev => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length < MIN_NAMES ? padNames(next) : next;
    });
    if (!removed) return;
    setSubmitted(prev => {
      if (!prev.some(n => n.trim().toLowerCase() === removed)) return prev;
      const next = prev.filter(n => n.trim().toLowerCase() !== removed);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const addSuggestion = (name: string) => {
    if (names.some(n => n.trim().toLowerCase() === name.toLowerCase())) return;
    setNames(prev => {
      const blank = prev.findIndex(n => !n.trim());
      if (blank !== -1) return prev.map((n, idx) => (idx === blank ? name : n));
      return prev.length >= MAX_NAMES ? prev : [...prev, name];
    });
  };

  // `extra` is the results view's own "type a name and press Add or Enter"
  // draft (newNameDraft) — clicking Compare directly, without pressing Enter
  // first to turn it into a chip, used to silently drop whatever was typed
  // since this only ever read `names`. Folding it in here (and committing it
  // as a real chip afterward) means Compare always acts on what's on screen.
  const handleCompare = (extra?: string) => {
    const draft = extra?.trim();

    // 1. Gating: A case must be selected
    if (!activeCase) {
      toast.error('Please link or select a Case before comparing brand names.');
      return;
    }

    // 2. In Hero input view: check if any visible field in `names` is empty or < 2 chars
    if (!canShow && !draft) {
      const emptySlots: number[] = [];
      const tooShortSlots: number[] = [];

      names.forEach((n, idx) => {
        const val = n.trim();
        if (!val) {
          emptySlots.push(idx + 1);
        } else if (val.length < 2) {
          tooShortSlots.push(idx + 1);
        }
      });

      if (emptySlots.length > 0) {
        toast.error(
          `Brand Name field ${emptySlots.map(s => `#${s}`).join(', ')} is empty. Please fill in all empty fields or remove them before comparing.`
        );
        return;
      }

      if (tooShortSlots.length > 0) {
        toast.error(
          `Brand Name field ${tooShortSlots.map(s => `#${s}`).join(', ')} must be at least 2 characters.`
        );
        return;
      }
    }

    // 3. If extra was provided (from Results view input): validate it
    if (draft) {
      if (draft.length < 2) {
        toast.error('Brand name must be at least 2 characters.');
        return;
      }
      if (names.some(n => n.trim().toLowerCase() === draft.toLowerCase())) {
        toast.error(`"${draft}" is already in your comparison list.`);
        return;
      }
    }

    const pool = draft && draft.length >= 2 ? [...names.filter(n => n.trim()), draft] : names.filter(n => n.trim());
    const trimmedPool = pool.map(n => n.trim()).filter(n => n.length >= 2);

    // 4. Duplicate check
    const { dupes } = dedupeCaseInsensitive(trimmedPool);
    if (dupes.length > 0) {
      toast.error(
        `Duplicate name${dupes.length > 1 ? 's' : ''}: ${Array.from(new Set(dupes)).join(', ')}. ` +
        'Each brand name must be unique — remove the duplicate before comparing.'
      );
      return;
    }

    // 5. Strict Case-Scoping: Disallow new / arbitrary names not belonging to this case
    if (activeCase) {
      const validNames = new Set((caseNamesQuery.data?.names ?? []).map(n => n.trim().toLowerCase()));
      const disallowedNames = trimmedPool.filter(n => !validNames.has(n.toLowerCase()));
      if (disallowedNames.length > 0) {
        toast.error(
          `No new names allowed: ${disallowedNames.map(n => `"${n}"`).join(', ')}. Only candidate names previously generated (AI Name Generator) or screened (Brand Analysis) for Case "${caseDisplayName(activeCase)}" can be compared.`
        );
        return;
      }
    }

    const cleaned = trimmedPool;
    if (cleaned.length < MIN_NAMES) {
      toast.error(`Please select or enter at least ${MIN_NAMES} brand names from this case to compare.`);
      return;
    }

    if (draft && draft.length >= 2) {
      setNames(prev => [...prev.filter(n => n.trim()), draft]);
      setNewNameDraft('');
    }
    setSubmitted(cleaned);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  };

  const handleClear = () => {
    setNames(['', '']);
    setSubmitted([]);
    setSuggestions([]);
    setNewNameDraft('');
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('pharma_compare_name1');
  };

  const applyCase = (c: BrandCase | null) => {
    setSelectedCaseId(c?.case_id ?? '');
    setActiveCase(c);
    try {
      if (c) localStorage.setItem(CASE_STORAGE_KEY, c.case_id);
      else localStorage.removeItem(CASE_STORAGE_KEY);
    } catch { /* ignore */ }
    if (!c) {
      setTopBarCase(null);
      return;
    }
    setTopBarCase({
      caseId: c.case_id,
      createdBy: c.suggested_by || 'Unknown',
      createdAt: formatDate(c.saved_at),
    });
  };

  // ── Excel/CSV upload: pull names from the "brand_names" column and compare them ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';   // allow re-selecting the same file
    if (!file) return;
    setUploading(true);
    try {
      const { names: parsed } = await apiClient.parseCompareNames(file);
      const { unique: cleaned, dupes } = dedupeCaseInsensitive(parsed.map(n => n.trim()).filter(n => n.length >= 2));
      if (dupes.length > 0) {
        toast.info(`Duplicate name${dupes.length > 1 ? 's' : ''} in "${file.name}" kept once: ${Array.from(new Set(dupes)).join(', ')}`);
      }
      if (cleaned.length < MIN_NAMES) {
        toast.error('Need at least 2 names in the "brand_names" column of the file.');
        return;
      }

      if (activeCase && caseNamesQuery.isSuccess) {
        const disallowedNames = cleaned.filter(n => !knownCaseNames.has(n.toLowerCase()));
        if (disallowedNames.length > 0) {
          toast.error(
            `No new names allowed in file: ${disallowedNames.map(n => `"${n}"`).join(', ')}. Only candidate names from Case "${caseDisplayName(activeCase)}" can be compared.`
          );
          return;
        }
      }

      setNames(padNames(cleaned));
      setSubmitted(cleaned);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
      toast.success(`Loaded ${cleaned.length} name${cleaned.length > 1 ? 's' : ''} from "${file.name}"`);
    } catch (err) {
      // Surface the real reason instead of a generic message.
      const e = err as { response?: { status?: number; data?: { detail?: string } } };
      const detail = e?.response?.data?.detail;
      const status = e?.response?.status;
      const msg = detail
        ? detail
        : status === 404
        ? 'Upload endpoint not found (HTTP 404). The backend may need a redeploy.'
        : status
        ? `Upload failed (HTTP ${status}).`
        : 'Could not reach the server. Is the backend running?';
      toast.error(msg);
      console.error('parse-names upload failed:', status, detail || err);
    } finally {
      setUploading(false);
    }
  };

  // ── assemble ready results, ranked best-first ─────────────────────────────
  // Overall risk score is the single most important signal (lower is
  // better), so it's the primary sort key; the tie-breakers below only
  // matter when two names land on the same risk score. Availability isn't
  // one of them — it's exactly `100 - risk_score` (see availabilityFor),
  // so it carries no information the risk score doesn't already provide.
  const rankReady = (a: Ready, b: Ready): number =>
    a.sr.overall_risk_score - b.sr.overall_risk_score
    || a.sr.total_conflicts - b.sr.total_conflicts
    || maxSimilarityFor(a.sr) - maxSimilarityFor(b.sr)
    || (b.sr.memorability_score ?? 0) - (a.sr.memorability_score ?? 0)
    || (b.sr.pronunciation_score ?? 0) - (a.sr.pronunciation_score ?? 0);

  const ready: Ready[] = submitted
    .map((name, i) => ({ name, sr: queries[i]?.data?.screening_result, source: queries[i]?.data?.source }))
    .filter((x): x is Ready => !!x.sr)
    .sort(rankReady);

  const anyLoading = queries.some((q, i) => q.isLoading && submitted[i]?.trim().length >= 2);
  const canShow = ready.length >= 2;
  const showHero = !canShow && !anyLoading;
  const showInitialLoading = anyLoading && !canShow;
  const validCount = names.filter(n => n.trim().length >= 2).length;

  // Requires a linked case — Review Batch groups every name by its case (no
  // "Ungrouped" bucket, per explicit direction), so a name added here with
  // no case attached would silently vanish from the review batch view even
  // though it's still in the cart (the badge count would no longer match
  // what's visible). Gating here prevents that instead of patching it after
  // the fact. In normal use this can never actually trigger once results are
  // showing (the hero above requires a case before any name can be typed),
  // but a legacy ?name1=&name2= deep link can still populate `submitted`
  // directly, bypassing that gate — so the check stays as a backstop.
  const cartPayloadFor = (r: Ready) => ({
    brand_name: r.name,
    source_type: 'compare' as const,
    risk_score: r.sr.overall_risk_score,
    risk_level: r.sr.risk_classification,
    risk_ai_assessment: r.sr.ai_assessment ?? undefined,
    case_id: activeCase?.case_id,
    case_name: activeCase ? caseDisplayName(activeCase) : undefined,
  });

  const quickAddToCart = async (r: Ready) => {
    if (!activeCase) {
      toast.error('Link a case first, every review batch entry needs a case attached.');
      return;
    }
    if (cart.isSubmitted(r.name)) {
      toast.info(`"${r.name}" was already submitted for Trademark Review`);
      return;
    }
    const ok = await cart.add(cartPayloadFor(r));
    if (ok) toast.success(`"${r.name}" added to review batch`);
    else toast.info(`"${r.name}" is already in your review batch`);
  };

  const addAllToCart = async () => {
    if (!activeCase) {
      toast.error('Link a case first, every review batch entry needs a case attached.');
      return;
    }
    const targets = ready.filter(r => !cart.has(r.name) && !cart.isSubmitted(r.name));
    if (targets.length === 0) {
      toast.info('All compared names are already in your review batch or already submitted');
      return;
    }
    const outcomes = await Promise.all(targets.map(r => cart.add(cartPayloadFor(r))));
    const added = outcomes.filter(Boolean).length;
    if (added > 0) toast.success(`${added} name(s) added to review batch`);
  };

  // overall winner column(s): lowest risk
  const overallWins = winnerFlags(ready.map(r => r.sr.overall_risk_score), true, 2);

  // dynamic grid template — fills width for few names, scrolls for many
  const labelW = 200;
  const gridTpl = `${labelW}px repeat(${ready.length}, minmax(0, 1fr))`;
  const minWidth = labelW + ready.length * 190;

  // Names already generated (AI Name Generator) or screened (Brand Analysis)
  // for the linked case — offered as suggestions in the name inputs below.
  // Filters for Low and Medium risk candidates.
  const caseNameOptions: NameOption[] = (caseNamesQuery.data?.sources ?? []).filter(o => {
    const isHigh = o.risk_level === 'HIGH' || (o.risk_score !== undefined && o.risk_score >= 65);
    return !isHigh;
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Hero / inputs ──────────────────────────────────────────────────────── */}
      {showHero && (
      <div
        // No overflow-hidden — this used to clip the name-suggestions
        // dropdown (NameSuggestField) any time it opened below the last row
        // of inputs, since it's rendered outside the hero's own box.
        className="relative py-10 px-6"
        style={{ background: 'linear-gradient(160deg, #fffaf5 0%, #fef0de 55%, #fad4a0 100%)', borderBottom: '3px solid #f7941e' }}
      >
        <div className="max-w-4xl mx-auto text-center pt-2">
          {(submitted.length > 0 || names.some(n => n.trim())) && (
            <div className="flex justify-end mb-3">
              <button
                onClick={handleClear}
                className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-500 hover:text-red-600 hover:border-red-200 px-3 py-1.5 rounded-full text-xs font-medium shadow-sm transition-colors"
              >
                <X className="w-3.5 h-3.5" /> Clear All
              </button>
            </div>
          )}

          {/* Case selector — a case must be linked before any name can be
              entered or compared (per explicit direction, mirrors Brand
              Analysis's own gating) — prefills a name from the linked case. */}
          <div className="flex flex-col items-center justify-center gap-1.5 mb-3">
            <div className="flex items-center justify-center gap-2">
              <span className="text-xs text-gray-500 font-medium">Case:</span>
              <CaseSelector value={selectedCaseId} onSelect={applyCase} className="bg-white/90 rounded-lg shadow-sm" />
            </div>
            {selectedCaseId && (
              <button
                type="button"
                onClick={() => setShowViewCaseModal(true)}
                className="inline-flex items-center gap-1 text-xs font-semibold text-orange-600 hover:text-orange-700 hover:underline cursor-pointer"
                title="View case form details"
              >
                <Eye className="w-3.5 h-3.5" /> View Form Details
              </button>
            )}
          </div>
          {!activeCase && (
            <p className="text-xs text-orange-700 mb-4">Link a case above to start comparing names.</p>
          )}
          {activeCase && <div className="mb-4" />}

          {/* Name inputs */}
          <div className="grid sm:grid-cols-2 gap-3 max-w-3xl mx-auto text-left">
            {names.map((name, i) => (
              <div key={i} className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-orange-100 text-orange-600 text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                <NameSuggestField
                  value={name}
                  onChange={v => updateName(i, v)}
                  onEnter={() => handleCompare()}
                  placeholder={activeCase ? `Brand name ${i + 1}…` : 'Link a case to begin'}
                  disabled={!activeCase}
                  options={caseNameOptions}
                  exclude={names.filter((_, idx) => idx !== i)}
                  arrowClassName="right-9"
                  className="w-full h-12 pl-12 pr-16 text-base rounded-xl border-0 bg-white shadow focus:outline-none focus:ring-2 focus:ring-orange-300 placeholder:text-gray-400 disabled:opacity-60 disabled:cursor-not-allowed"
                />
                {(names.length > MIN_NAMES || name) && (
                  <button
                    onClick={() => (names.length > MIN_NAMES ? removeName(i) : updateName(i, ''))}
                    title={names.length > MIN_NAMES ? 'Remove this name' : 'Clear this field'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-red-500 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Add / Compare controls */}
          <div className="flex items-center justify-center gap-3 mt-4 flex-wrap">
            <Button
              variant="outline"
              onClick={() => addName()}
              disabled={!activeCase || names.length >= MAX_NAMES}
              className="h-11 bg-white border-orange-200 text-orange-700 hover:bg-orange-50 disabled:opacity-50"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Add name {names.length >= MAX_NAMES ? `(max ${MAX_NAMES})` : `(${names.length}/${MAX_NAMES})`}
            </Button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={handleUpload} />
            <Button
              variant="outline"
              onClick={() => setShowUploadModal(true)}
              disabled={!activeCase || uploading}
              title={!activeCase ? 'Link a case first' : 'Upload an Excel/CSV with a "brand_names" column (max 20 rows) to compare those names'}
              className="h-11 bg-white border-orange-200 text-orange-700 hover:bg-orange-50 disabled:opacity-50"
            >
              {uploading
                ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                : <FileSpreadsheet className="w-4 h-4 mr-1.5" />}
              Upload Excel
            </Button>
            <Dialog open={showUploadModal} onOpenChange={setShowUploadModal}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Upload Names from Excel</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <p className="text-sm text-gray-600">
                    Your file needs a <span className="font-mono bg-gray-100 px-1 rounded">brand_names</span> column
                    with the names you want to compare (max {MAX_NAMES} rows). Not sure of the format? Start from the template.
                  </p>
                  <button
                    type="button"
                    onClick={() => downloadCompareNamesTemplate()}
                    className="w-full flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-orange-300 hover:bg-orange-50 text-left transition-colors"
                  >
                    <Download className="w-5 h-5 text-orange-600 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-gray-800">Download Template</p>
                      <p className="text-xs text-gray-500">Get a ready-made .xlsx with the right column</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowUploadModal(false); fileRef.current?.click(); }}
                    className="w-full flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-orange-300 hover:bg-orange-50 text-left transition-colors"
                  >
                    <FileSpreadsheet className="w-5 h-5 text-orange-600 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-gray-800">Upload Excel File</p>
                      <p className="text-xs text-gray-500">Choose your filled-in .xlsx, .xls, or .csv file</p>
                    </div>
                  </button>
                </div>
              </DialogContent>
            </Dialog>
            <Button
              variant="outline"
              onClick={handleClear}
              disabled={names.every(n => !n.trim()) && !selectedCaseId && submitted.length === 0}
              className="h-11 bg-white border-gray-200 text-gray-600 hover:text-red-600 hover:border-red-200 hover:bg-red-50 disabled:opacity-40"
              title="Clear all fields and reset comparison"
            >
              <X className="w-4 h-4 mr-1.5" />
              Clear All
            </Button>
            <Button
              onClick={() => handleCompare()}
              disabled={!activeCase || anyLoading || !hasPermission('compare', 'run_compare')}
              title={!hasPermission('compare', 'run_compare') ? 'Permission required to run comparison' : undefined}
              className="h-11 px-7 bg-orange-500 hover:bg-orange-600 text-white rounded-xl shadow-lg font-semibold flex-shrink-0 disabled:opacity-50"
            >
              {anyLoading
                ? <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Comparing…</>
                : <><Zap className="w-5 h-5 mr-2" /> Compare {validCount >= MIN_NAMES ? `${validCount} names` : ''}</>}
            </Button>
          </div>

          {/* AI suggestions */}
          {suggestMutation.isPending && (
            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-orange-600">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> <span>AI is suggesting comparison names…</span>
            </div>
          )}
          {!suggestMutation.isPending && suggestions.length > 0 && (
            <div className="mt-4 max-w-3xl mx-auto">
              <div className="flex items-center gap-2 mb-2 justify-center">
                <Sparkles className="w-3.5 h-3.5 text-orange-500" />
                <span className="text-xs text-gray-500 font-medium">AI suggestions for <span className="text-orange-600 font-semibold">{firstName}</span>, click to add</span>
              </div>
              <div className="flex flex-wrap gap-2 justify-center">
                {suggestions.map(s => {
                  const used = names.some(n => n.trim().toLowerCase() === s.generated_name.toLowerCase());
                  return (
                    <button
                      key={s.id}
                      onClick={() => addSuggestion(s.generated_name)}
                      disabled={used || names.length >= MAX_NAMES}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-all disabled:opacity-50
                        ${used ? 'bg-orange-100 text-orange-700 border-orange-200' : 'bg-white text-gray-700 border-gray-200 hover:border-orange-400 hover:text-orange-700 shadow-sm'}`}
                    >
                      {!used && <Plus className="w-3 h-3" />}{s.generated_name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      </div>
      )}

      {/* ── Initial Comparison Loading State ── */}
      {showInitialLoading && (
        <div className="max-w-4xl mx-auto px-6 py-24 text-center">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 flex flex-col items-center justify-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-orange-50 border border-orange-100 flex items-center justify-center">
              <Loader2 className="w-7 h-7 text-orange-500 animate-spin" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900 mb-1">Comparing Brand Names</h2>
              <p className="text-sm text-gray-500 max-w-md">
                Screening candidate names against WHO INN, IQVIA database, e-pharmacy platforms, and market databases...
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center pt-2">
              {submitted.map((name, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 bg-orange-50 border border-orange-200 text-orange-700 text-xs font-semibold px-3 py-1.5 rounded-full">
                  <Loader2 className="w-3 h-3 animate-spin text-orange-500" />
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────────────────────
          Once results are ready this replaces the hero above with a
          clean layout: a compact 1-row toolbar (Case + Clear All + Export + Add All),
          a "Names to Compare" card, then the metric comparison table. */}
      {canShow && (
        <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <div className="flex items-center gap-2.5 min-w-0">
              {activeCase && (
                <button
                  type="button"
                  onClick={() => setShowViewCaseModal(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-orange-700 bg-orange-100 hover:bg-orange-200 border border-orange-300 rounded-xl px-3 py-2 transition-colors cursor-pointer"
                  title="Click to view case form details"
                >
                  <FileText className="w-4 h-4 text-orange-600" />
                  <span className="truncate max-w-xs sm:max-w-md">Case: {caseDisplayName(activeCase)}</span>
                  <Eye className="w-3.5 h-3.5 ml-0.5 text-orange-600 opacity-80" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={handleClear}
                className="h-9 px-3 gap-1.5 border-gray-200 text-gray-600 hover:border-red-300 hover:text-red-600 hover:bg-red-50 rounded-xl text-xs"
                title="Clear all comparison results and start over"
              >
                <X className="w-3.5 h-3.5" /> Clear All
              </Button>
              {hasPermission('compare', 'export_excel') && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadCompareReport(ready)}
                  className="h-9 px-3 gap-1.5 border-gray-200 text-gray-600 hover:border-orange-400 hover:text-orange-600 rounded-xl text-xs"
                >
                  <Download className="w-3.5 h-3.5" /> Export
                </Button>
              )}
              {hasPermission('generator', 'add_to_cart') && (
                <Button
                  size="sm"
                  onClick={addAllToCart}
                  disabled={!activeCase || ready.every(r => cart.has(r.name) || cart.isSubmitted(r.name))}
                  title={!activeCase ? 'Link a case first' : undefined}
                  className="h-9 px-4 gap-1.5 bg-orange-500 hover:bg-orange-600 text-white disabled:opacity-50 rounded-xl text-xs font-medium"
                >
                  <ShieldCheck className="w-3.5 h-3.5" /> Add All to Review Batch
                </Button>
              )}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700">
                Names to Compare <span className="text-xs text-gray-400 font-normal">(min {MIN_NAMES}, max {MAX_NAMES})</span>
              </p>
              <Button size="sm" onClick={handleClear}
                className="bg-orange-500 hover:bg-orange-600 text-white">
                New Comparison
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
              {names.map((name, i) => name.trim() && (
                <span key={i} className="inline-flex items-center gap-1.5 bg-orange-50 border border-orange-200 text-orange-700 text-sm font-medium px-3 py-1.5 rounded-full">
                  {name}
                  <button onClick={() => removeName(i)} className="text-orange-400 hover:text-red-500">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <NameSuggestField
                  value={newNameDraft}
                  onChange={setNewNameDraft}
                  onEnter={() => {
                    const draft = newNameDraft.trim();
                    if (draft.length < 2) return;
                    if (activeCase && caseNamesQuery.isSuccess && !knownCaseNames.has(draft.toLowerCase())) {
                      toast.error(`No new names allowed: "${draft}". Only candidate names previously generated or screened for Case "${caseDisplayName(activeCase)}" can be added.`);
                      return;
                    }
                    if (names.some(n => n.trim().toLowerCase() === draft.toLowerCase())) {
                      toast.error(`"${draft}" is already in your comparison list.`);
                      return;
                    }
                    addName(draft);
                    setNewNameDraft('');
                  }}
                  placeholder="Type a brand name and press Add or Enter…"
                  options={caseNameOptions}
                  exclude={names}
                  className="w-full h-11 pl-4 pr-9 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-orange-300 placeholder:text-gray-400"
                />
              </div>
              <Button
                onClick={() => handleCompare(newNameDraft)}
                disabled={(validCount < MIN_NAMES && newNameDraft.trim().length < 2) || anyLoading}
                className="h-11 px-6 bg-orange-500 hover:bg-orange-600 text-white rounded-xl flex-shrink-0"
              >
                {anyLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                Compare
              </Button>
            </div>
            <p className="text-xs text-orange-600 mt-2">
              {ready.length} name{ready.length === 1 ? '' : 's'} loaded · Pre-screened results shown below
            </p>
          </div>

          <div className="overflow-x-auto pb-2">
            <div style={{ minWidth }}>
              {/* Comparison table — matches the mock's flat metric-row layout
                  (Sun_Pharma_Screens_V1.2.pptx, slide 13): Risk Score,
                  Availability, Memorability, Pronunciation Ease, Conflicts
                  Found, Max Similarity, Risk Classification, Recommendation,
                  then an Actions row. Memorability/Pronunciation Ease are
                  LLM-assigned scores captured only at AI Name Generator time
                  (compare.py threads them through, never recomputed here —
                  Compare itself still makes no LLM call), so a name typed
                  directly into Compare without ever being AI-generated shows
                  "N/A" for these two rather than a fabricated number.
                  Granular per-tier breakdowns (market vs e-pharmacy conflicts,
                  the 5 individual similarity dimensions) live one click away
                  via "View Screening" instead of cluttering this summary. */}
              <CompareSection>
                <div className="grid gap-3 px-5 py-4" style={{ gridTemplateColumns: gridTpl }}>
                  <div />
                  {ready.map((r, i) => (
                    <div key={r.name} className="text-center">
                      <span className={cn(
                        'inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full mb-1',
                        i === 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      )}>
                        {i === 0 ? 'BEST MATCH' : `#${i + 1}`}
                      </span>
                      <p className="font-bold text-gray-900 truncate">{r.name}</p>
                      {/* Where this name came from — the actual add-to-batch
                          action already lives in the Actions row at the
                          bottom of the table, so this slot doesn't need to
                          duplicate it. */}
                      <p className="text-[11px] text-gray-400 mt-0.5">{sourceLabel(r.source)}</p>
                    </div>
                  ))}
                </div>

                <MetricRow label="Risk Score" sub="lower is better" tpl={gridTpl} winCols={overallWins}>
                  {ready.map((r, i) => <ScoreCell key={r.name} value={r.sr.overall_risk_score} win={overallWins[i]} />)}
                </MetricRow>

                {(() => {
                  const vals = ready.map(r => availabilityFor(r.sr));
                  const wins = winnerFlags(vals, false, 2);
                  return (
                    <MetricRow label="Availability" sub="higher is better" tpl={gridTpl} winCols={wins}>
                      {ready.map((r, i) => <ScoreCell key={r.name} value={vals[i]} win={wins[i]} higherIsBetter />)}
                    </MetricRow>
                  );
                })()}

                {(() => {
                  const vals = ready.map(r => r.sr.memorability_score);
                  const wins = winnerFlagsNullable(vals, false, 2);
                  return (
                    <MetricRow label="Memorability" sub="higher is better" tpl={gridTpl} winCols={wins}>
                      {ready.map((r, i) => vals[i] != null
                        ? <ScoreCell key={r.name} value={vals[i] as number} win={wins[i]} higherIsBetter />
                        : <span key={r.name} className="text-xs text-gray-400">N/A</span>)}
                    </MetricRow>
                  );
                })()}

                {(() => {
                  const vals = ready.map(r => r.sr.pronunciation_score);
                  const wins = winnerFlagsNullable(vals, false, 2);
                  return (
                    <MetricRow label="Pronunciation Ease" sub="higher is better" tpl={gridTpl} winCols={wins}>
                      {ready.map((r, i) => vals[i] != null
                        ? <ScoreCell key={r.name} value={vals[i] as number} win={wins[i]} higherIsBetter />
                        : <span key={r.name} className="text-xs text-gray-400">N/A</span>)}
                    </MetricRow>
                  );
                })()}

                {(() => {
                  const vals = ready.map(r => r.sr.total_conflicts);
                  const wins = winnerFlags(vals, true, 0);
                  return (
                    <MetricRow label="Conflicts Found" sub="lower is better" tpl={gridTpl} winCols={wins}>
                      {ready.map((r, i) => <NumCell key={r.name} value={vals[i]} win={wins[i]} />)}
                    </MetricRow>
                  );
                })()}

                {(() => {
                  const vals = ready.map(r => maxSimilarityFor(r.sr));
                  const wins = winnerFlags(vals, true, 2);
                  return (
                    <MetricRow label="Max Similarity" sub="lower is better" tpl={gridTpl} winCols={wins}>
                      {ready.map((r, i) => <SimCell key={r.name} value={vals[i]} win={wins[i]} />)}
                    </MetricRow>
                  );
                })()}

                <MetricRow label="Risk Classification" tpl={gridTpl}>
                  {ready.map(r => (
                    <BadgeCell key={r.name} text={r.sr.risk_classification ?? 'N/A'} badge={classificationBadge(r.sr.risk_classification)} win={false} />
                  ))}
                </MetricRow>

                <MetricRow label="Recommendation" tpl={gridTpl}>
                  {ready.map(r => (
                    <BadgeCell key={r.name} text={recommendationLabel(r.sr.ai_recommendation)} badge={recommendationBadge(r.sr.ai_recommendation)} win={false} />
                  ))}
                </MetricRow>

                <MetricRow label="Actions" tpl={gridTpl}>
                  {ready.map(r => (
                    <div key={r.name} className="flex flex-col gap-1.5">
                      <Button
                        variant="outline" size="sm"
                        className="gap-1.5 text-gray-600 border-gray-200 hover:border-orange-400 hover:text-orange-600"
                        onClick={() => router.push(
                          `/brand-analysis?q=${encodeURIComponent(r.name)}` +
                          (activeCase ? `&case=${encodeURIComponent(activeCase.case_id)}` : '')
                        )}
                      >
                        View Screening <ArrowRight className="w-3.5 h-3.5" />
                      </Button>
                      {hasPermission('generator', 'add_to_cart') && (
                        <Button
                          size="sm"
                          disabled={cart.has(r.name) || cart.isSubmitted(r.name)}
                          title={
                            cart.isSubmitted(r.name) ? 'Already submitted for Trademark Review'
                              : cart.has(r.name) ? 'Already in review batch'
                              : 'Add to review batch'
                          }
                          className="gap-1.5 bg-orange-500 hover:bg-orange-600 text-white disabled:opacity-50"
                          onClick={() => quickAddToCart(r)}
                        >
                          <ShoppingCart className="w-3.5 h-3.5" />
                          {cart.isSubmitted(r.name) ? 'Submitted' : 'Add to Batch'}
                        </Button>
                      )}
                    </div>
                  ))}
                </MetricRow>
              </CompareSection>

              {/* Legend */}
              <div className="flex flex-wrap items-center gap-4 px-1 py-3 text-xs text-gray-500">
                <span className="flex items-center gap-1.5"><Trophy className="w-3.5 h-3.5 text-yellow-500" /> Best in metric (winner)</span>
                <span className="flex items-center gap-1.5"><span className="px-2 py-0.5 rounded-full font-semibold bg-red-100 text-red-700 border border-red-200">HIGH</span> High risk, avoid</span>
                <span className="flex items-center gap-1.5"><span className="px-2 py-0.5 rounded-full font-semibold bg-orange-100 text-orange-700 border border-orange-200">MEDIUM</span> Review required</span>
                <span className="flex items-center gap-1.5"><span className="px-2 py-0.5 rounded-full font-semibold bg-green-100 text-green-700 border border-green-200">LOW</span> Proceed with confidence</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!canShow && !anyLoading && (
        <div className="max-w-lg mx-auto px-6 py-16 text-center">
          <div className="w-16 h-16 bg-orange-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <GitCompare className="w-8 h-8 text-orange-500" />
          </div>
          <p className="text-gray-700 font-semibold text-lg mb-2">Enter at least two brand names to compare</p>
          <p className="text-gray-400 text-sm">Add up to {MAX_NAMES} names. They'll be screened together and shown side-by-side, with the lowest-risk name highlighted.</p>
        </div>
      )}

      <CaseFormDetailsModal
        open={showViewCaseModal}
        onClose={() => setShowViewCaseModal(false)}
        caseData={activeCase}
        caseId={selectedCaseId}
      />
    </div>
  );
}

// ── layout helpers ─────────────────────────────────────────────────────────────

function padNames(arr: string[]): string[] {
  const trimmed = arr.slice(0, MAX_NAMES);
  while (trimmed.length < MIN_NAMES) trimmed.push('');
  return trimmed;
}

function CompareSection({ title, icon, children }: { title?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {title && (
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
          {icon}
          <p className="text-sm font-semibold text-gray-700">{title}</p>
        </div>
      )}
      <div className="divide-y divide-gray-50">{children}</div>
    </div>
  );
}

function MetricRow({ label, sub, children, tpl, align = 'items-center', winCols }: { label: string; sub?: string; children: React.ReactNode; tpl: string; align?: string; winCols?: boolean[] }) {
  const cols = Array.isArray(children) ? children : [children];
  return (
    <div className={`grid gap-3 px-5 py-4 hover:bg-gray-50/50 transition-colors ${align}`} style={{ gridTemplateColumns: tpl }}>
      <div>
        <p className="text-sm text-gray-700 font-medium">{label}</p>
        {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
      </div>
      {cols.map((child, i) => (
        <div key={i} className={winCols?.[i] ? '-my-4 py-4 bg-yellow-50/60' : undefined}>{child}</div>
      ))}
    </div>
  );
}
