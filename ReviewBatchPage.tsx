import { useState, useMemo, useEffect } from 'react';
import { usePersistentState } from '@/lib/usePersistentState';
import { useRouter } from 'next/router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Download, Scale, CheckSquare, Square, ArrowUpDown, Filter as FilterIcon, X, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useCart, type CartItem } from '@/contexts/CartContext';
import { apiClient } from '@/api/client';
import { getCase, cacheFromBackend } from '@/lib/caseStore';
import { CaseFormDetailsModal } from '@/components/CaseFormDetailsModal';
import { TrademarkNameDetailModal } from '@/components/TrademarkNameDetailModal';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Per BRD 5.2.5 & QA specifications — configured to allow submitting
// batches of up to 6 candidate brand names.
const MAX_BATCH_SUBMIT = 6;

const PRIORITY_OPTIONS = ['High', 'Medium', 'Low'] as const;
type Priority = typeof PRIORITY_OPTIONS[number];

const SORT_OPTIONS = [
  { key: 'name_asc', label: 'Name (A-Z)' },
  { key: 'risk_desc', label: 'Risk (High to Low)' },
  { key: 'risk_asc', label: 'Risk (Low to High)' },
] as const;
type SortKey = typeof SORT_OPTIONS[number]['key'];

const FILTER_OPTIONS = [
  { key: 'all', label: 'All Risk Levels' },
  { key: 'HIGH', label: 'High Risk' },
  { key: 'MEDIUM', label: 'Medium Risk' },
  { key: 'LOW', label: 'Low Risk' },
] as const;
type RiskFilter = typeof FILTER_OPTIONS[number]['key'];

const LOG_TAG = '[ReviewBatch]';

function priorityPillClass(p: Priority): string {
  switch (p) {
    case 'High': return 'bg-rose-100 text-rose-600';
    case 'Medium': return 'bg-orange-100 text-orange-600';
    default: return 'bg-gray-100 text-gray-500';
  }
}

function riskDotColor(level?: string) {
  switch ((level || '').toUpperCase()) {
    case 'HIGH': return 'bg-red-500';
    case 'MEDIUM': return 'bg-orange-500';
    case 'LOW': return 'bg-green-500';
    default: return 'bg-gray-300';
  }
}

function exportGroupCsv(caseName: string, items: CartItem[]) {
  console.log(`${LOG_TAG} exporting CSV for "${caseName}" (${items.length} names)`);
  const header = ['Brand Name', 'Risk Level', 'Risk Score', 'Source', 'Therapeutic Area'];
  const rows = items.map((i) => [
    i.brand_name, i.risk_level || '', i.risk_score?.toString() || '', i.source_type || '', i.therapeutic_area || '',
  ]);
  const csv = [header, ...rows]
    .map((r) => r.map((cell) => `"${(cell || '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${caseName.replace(/[^a-z0-9]+/gi, '_')}_review_batch.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// A small local dropdown popover — button + panel, closes on outside click.
// Mirrors the pattern already used by AppLayout's UserMenu; kept local here
// since there's no shared DropdownMenu primitive in components/ui yet.
function DropdownButton({
  label, icon, children,
}: { label: string; icon: React.ReactNode; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant="default" size="sm" className="gap-1.5" onClick={() => setOpen((o) => !o)}>
        {icon} {label}
      </Button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setOpen(false); } }}
            role="button"
            tabIndex={0}
          />
          <div className="absolute right-0 top-full mt-1 min-w-[10rem] bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-20">
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
}

interface CaseGroup {
  key: string;
  heading: string;
  caseId?: string;
  createdOn?: string;
  items: CartItem[];
}

// Groups cart items by whichever case was active when each name was added
// (case_id/case_name are local-only labels on CartItem — see CartContext).
// The heading, Case ID, and Created On all come from the real case-store
// record (Create a Case / Link a Case), never fabricated. Items added with
// no active case are skipped entirely (no "Ungrouped" bucket) — the mock
// only ever shows real case-named groups, and a name with nothing to attach
// it to a Case isn't something Trademark Review can meaningfully act on.
function buildGroups(items: CartItem[], backendSuggestions?: Record<string, unknown>[]): CaseGroup[] {
  const map = new Map<string, CaseGroup>();
  for (const item of items) {
    if (!item.case_id) continue;
    const key = item.case_id;
    if (!map.has(key)) {
      const caseRecord = getCase(item.case_id);
      const backendCase = backendSuggestions?.find(
        (s) => s.case_id === item.case_id || s.id === item.case_id
      );
      const molecule =
        caseRecord?.generic_name ||
        (backendCase?.generic_name as string) ||
        item.case_name ||
        item.case_id;
      const therapyOrAilment =
        caseRecord?.therapy ||
        caseRecord?.ailment ||
        (backendCase?.therapy as string) ||
        (backendCase?.ailment as string);

      const rawDate =
        caseRecord?.saved_at ||
        caseRecord?.date ||
        (caseRecord as any)?.created_at ||
        (backendCase?.saved_at as string) ||
        (backendCase?.created_at as string) ||
        (backendCase?.date as string) ||
        item.added_at ||
        (item as any)?.created_at ||
        new Date().toISOString();

      map.set(key, {
        key,
        heading: therapyOrAilment ? `${molecule} - ${therapyOrAilment}` : molecule,
        caseId: item.case_id,
        createdOn: rawDate,
        items: [],
      });
    }
    map.get(key)!.items.push(item);
  }
  return Array.from(map.values());
}

function CaseGroupCard({ group }: { group: CaseGroup }) {
  const cart = useCart();
  const router = useRouter();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(group.items.slice(0, MAX_BATCH_SUBMIT).map((i) => i.brand_name))
  );
  const [priority, setPriority] = useState<Priority>('Medium');
  const [submitting, setSubmitting] = useState(false);
  const [caseModalOpen, setCaseModalOpen] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailNameIndex, setDetailNameIndex] = useState(0);
  const groupNames = useMemo(() => group.items.map((i) => i.brand_name), [group.items]);
  const caseRecord = group.caseId ? getCase(group.caseId) : null;

  const toggleOne = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        if (next.size >= MAX_BATCH_SUBMIT) {
          // Informational, not an error — a routine selection limit, not a failure.
          toast.info(`You can select a maximum of ${MAX_BATCH_SUBMIT} brand names for a single Trademark Review Request.`);
          return prev;
        }
        next.add(name);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    const picked = group.items.filter((i) => selected.has(i.brand_name));
    if (picked.length === 0) {
      toast.error('Select at least one name to submit');
      return;
    }
    console.log(`${LOG_TAG} submitting batch for "${group.heading}": ${picked.map(p => p.brand_name).join(', ')} (priority=${priority})`);
    setSubmitting(true);
    try {
      // `id` is local-only (the cart row's own id) and stripped back out —
      // but case_id/case_name now DO travel to the backend (see
      // legal.py's SubmitReviewRequest), since the 6-pending-per-case
      // submission cap needs them to know which case each name belongs to.
      // Priority has no dedicated backend field (see MAX_BATCH_SUBMIT
      // comment), so it travels in the batch description alongside the
      // case heading, same honest approach.
      const items = picked.map(({ id, ...rest }) => rest);
      const batch = await apiClient.submitLegalBatch({
        description: `${group.heading} | ${priority} Priority`,
        items,
      });
      console.log(`${LOG_TAG} batch submitted: ${batch.batch_code} (id=${batch.id}, ${items.length} names)`);
      await Promise.all(picked.map((i) => cart.remove(i.brand_name)));
      toast.success(`Submitted ${picked.length} name(s) for trademark review. Open "Trademark Review" from the sidebar to view it.`);
      // Don't auto-navigate (explicit request — the redirect felt slow/janky
      // mid-flow). Instead warm the destination's data + JS bundle right now
      // in the background, so whenever the user does click through manually
      // it's instant instead of showing its own loading/compile delay.
      qc.prefetchQuery({ queryKey: ['legal-batches'], queryFn: () => apiClient.getLegalBatches() });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-count'] });
      qc.invalidateQueries({ queryKey: ['dashboard-metrics'] });
      router.prefetch('/trademark-review');
      console.log(`${LOG_TAG} prefetched /trademark-review data + route`);
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      console.error(`${LOG_TAG} batch submit failed:`, err);
      // A `detail` message means the backend rejected this on a routine
      // business rule (e.g. the per-case pending-review cap) — informational,
      // not an error. No detail means something actually went wrong.
      if (detail) toast.info(detail);
      else toast.error('Failed to submit batch. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mb-8">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setCaseModalOpen(true)}
            className="text-left font-bold text-purple-700 hover:text-purple-950 hover:underline flex items-center gap-1.5 text-lg group/heading transition-colors cursor-pointer"
            title="Click to view full case form details"
          >
            <span>{group.heading}</span>
            <FileText className="w-4 h-4 text-purple-400 group-hover/heading:text-purple-600 opacity-80 flex-shrink-0" />
          </button>
          <span className={cn('px-2.5 py-1 rounded-full text-xs font-bold', priorityPillClass(priority))}>
            {priority} Priority
          </span>
        </div>
        <div className="flex items-center gap-2">
          <DropdownButton label="Set Priority" icon={<Scale className="w-3.5 h-3.5" />}>
            {(close) => PRIORITY_OPTIONS.map((p) => (
              <button
                key={p}
                onClick={() => { setPriority(p); close(); }}
                className={cn(
                  'w-full text-left px-4 py-1.5 text-sm hover:bg-gray-50',
                  priority === p && 'text-orange-600 font-semibold'
                )}
              >
                {p}
              </button>
            ))}
          </DropdownButton>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => exportGroupCsv(group.heading, group.items)}>
            <Download className="w-3.5 h-3.5" /> Export
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        {group.caseId && (
          <button
            type="button"
            onClick={() => setCaseModalOpen(true)}
            className="flex-1 min-w-[180px] h-11 px-4 flex items-center justify-between rounded-lg border border-gray-200 bg-white text-sm text-gray-700 hover:border-orange-300 hover:bg-orange-50/20 transition-colors text-left cursor-pointer"
            title="Click to view full case form details"
          >
            <span>Case ID: <span className="font-semibold text-orange-600 ml-1">{group.caseId}</span></span>
            <FileText className="w-3.5 h-3.5 text-gray-400" />
          </button>
        )}
        <div className="flex-1 min-w-[180px] h-11 px-4 flex items-center rounded-lg border border-gray-200 bg-white text-sm text-gray-700">
          Created On:{' '}
          <span className="font-semibold ml-1">
            {(() => {
              const val =
                group.createdOn ||
                caseRecord?.saved_at ||
                caseRecord?.date ||
                (caseRecord as any)?.created_at ||
                new Date().toISOString();
              const d = new Date(val);
              if (isNaN(d.getTime())) {
                return String(val);
              }
              return d.toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              });
            })()}
          </span>
        </div>
        <div className="flex-1 min-w-[180px] h-11 px-4 flex items-center rounded-lg border border-gray-200 bg-white text-sm text-gray-700">
          Cart: <span className="font-semibold ml-1">{group.items.length}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-3 mb-4">
        {group.items.map((item, itemIdx) => (
          <div key={item.brand_name} className="flex items-center gap-1.5 min-w-0">
            {/* Square checkbox button to select/deselect the name */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleOne(item.brand_name);
              }}
              className="p-0.5 text-gray-500 hover:text-gray-700 focus:outline-none transition-colors flex-shrink-0 cursor-pointer"
              title={selected.has(item.brand_name) ? `Deselect ${item.brand_name}` : `Select ${item.brand_name}`}
            >
              {selected.has(item.brand_name)
                ? <CheckSquare className="w-4 h-4 text-gray-700" />
                : <Square className="w-4 h-4 text-gray-300 hover:text-gray-400" />}
            </button>

            {/* Brand name button to open Detailed Analysis Report pop-up box */}
            <button
              type="button"
              onClick={() => {
                setDetailNameIndex(itemIdx);
                setDetailModalOpen(true);
              }}
              className="flex items-center gap-1.5 text-left min-w-0 flex-1 group/name hover:opacity-80 transition-all cursor-pointer"
              title={`Click to view detailed analysis report for ${item.brand_name}`}
            >
              <span className="text-sm font-semibold text-blue-600 underline truncate group-hover/name:text-blue-800">
                {item.brand_name}
              </span>
              <span className={cn('w-2 h-2 rounded-full flex-shrink-0', riskDotColor(item.risk_level))} />
            </button>

            {/* Remove from batch button */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                console.log(`${LOG_TAG} removed "${item.brand_name}" from cart`);
                cart.remove(item.brand_name);
              }}
              className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0 p-0.5 cursor-pointer"
              title="Remove from batch"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      <Button className="gap-2" disabled={submitting || selected.size === 0} onClick={handleSubmit}>
        {submitting ? 'Submitting...' : 'Submit for Trademark Review'}
      </Button>

      <CaseFormDetailsModal
        open={caseModalOpen}
        onClose={() => setCaseModalOpen(false)}
        caseData={caseRecord}
        caseId={group.caseId}
      />

      <TrademarkNameDetailModal
        names={groupNames}
        initialIndex={detailNameIndex}
        open={detailModalOpen}
        onClose={() => setDetailModalOpen(false)}
        titleClassName="text-orange-600"
        caseId={group.caseId}
      />
    </div>
  );
}

export function ReviewBatchPage() {
  const cart = useCart();
  const router = useRouter();
  const qc = useQueryClient();
  const [search, setSearch] = usePersistentState('brandsentry_filter_batch_search', '');
  const [sortBy, setSortBy] = usePersistentState<SortKey>('brandsentry_filter_batch_sortBy', 'name_asc');
  const [riskFilter, setRiskFilter] = usePersistentState<RiskFilter>('brandsentry_filter_batch_riskFilter', 'all');

  const { data: backendSuggestions = [] } = useQuery({
    queryKey: ['suggestions'],
    queryFn: () => apiClient.listSuggestions(),
    staleTime: 30 * 1000,
  });

  useEffect(() => {
    if (backendSuggestions && Array.isArray(backendSuggestions)) {
      backendSuggestions.forEach((s) => cacheFromBackend(s));
    }
  }, [backendSuggestions]);

  // Warm the Trademark Review page's route + data on arrival here too (not
  // just right after a submit) — covers visiting this page without
  // submitting anything new, then still clicking through via the sidebar.
  useEffect(() => {
    router.prefetch('/trademark-review');
    qc.prefetchQuery({ queryKey: ['legal-batches'], queryFn: () => apiClient.getLegalBatches() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    let items = cart.items;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      items = items.filter((i) =>
        i.brand_name.toLowerCase().includes(q) || (i.case_name || '').toLowerCase().includes(q)
      );
    }
    if (riskFilter !== 'all') {
      items = items.filter((i) => (i.risk_level || '').toUpperCase() === riskFilter);
    }
    return [...items].sort((a, b) => {
      if (sortBy === 'name_asc') return a.brand_name.localeCompare(b.brand_name);
      if (sortBy === 'risk_desc') return (b.risk_score || 0) - (a.risk_score || 0);
      return (a.risk_score || 0) - (b.risk_score || 0);
    });
  }, [cart.items, search, sortBy, riskFilter]);

  const groups = useMemo(() => buildGroups(filtered, backendSuggestions), [filtered, backendSuggestions]);
  const uncasedCount = useMemo(() => cart.items.filter((i) => !i.case_id).length, [cart.items]);

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Cases or brand names..."
            className="w-full h-11 pl-9 pr-9 rounded-lg border border-gray-200 text-sm bg-white"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <DropdownButton label="Sort" icon={<ArrowUpDown className="w-3.5 h-3.5" />}>
          {(close) => SORT_OPTIONS.map((o) => (
            <button
              key={o.key}
              onClick={() => { setSortBy(o.key); close(); }}
              className={cn('w-full text-left px-4 py-1.5 text-sm hover:bg-gray-50', sortBy === o.key && 'text-orange-600 font-semibold')}
            >
              {o.label}
            </button>
          ))}
        </DropdownButton>
        <DropdownButton label="Filter" icon={<FilterIcon className="w-3.5 h-3.5" />}>
          {(close) => FILTER_OPTIONS.map((o) => (
            <button
              key={o.key}
              onClick={() => { setRiskFilter(o.key); close(); }}
              className={cn('w-full text-left px-4 py-1.5 text-sm hover:bg-gray-50', riskFilter === o.key && 'text-orange-600 font-semibold')}
            >
              {o.label}
            </button>
          ))}
        </DropdownButton>
      </div>

      <p className="text-sm text-gray-700 mb-6">
        Note: You can select a maximum of {MAX_BATCH_SUBMIT} brand names for a single Trademark Review Request.
      </p>

      {groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-center gap-3">
          <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center">
            <Scale className="w-8 h-8 text-gray-300" />
          </div>
          <div>
            <p className="font-semibold text-gray-700">
              {cart.items.length === 0
                ? 'No names in your review batch'
                : uncasedCount === cart.items.length
                ? 'These names have no case attached'
                : 'No names match your filters'}
            </p>
            <p className="text-sm text-gray-400 mt-1">
              {cart.items.length === 0
                ? 'Add names from AI Name Generator, Brand Analysis, or Compare Names'
                : uncasedCount === cart.items.length
                ? "These can't be reviewed without a case, and there's no way to guess which case they belonged to"
                : 'Try adjusting your search or filters'}
            </p>
            {uncasedCount === cart.items.length && cart.items.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3 text-red-600 border-red-200 hover:bg-red-50"
                onClick={() => {
                  const stray = cart.items.filter((i) => !i.case_id);
                  stray.forEach((i) => cart.remove(i.brand_name));
                  console.log(`${LOG_TAG} removed ${stray.length} case-less name(s) from cart`);
                }}
              >
                Remove these {uncasedCount} name{uncasedCount === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        </div>
      ) : (
        groups.map((group) => <CaseGroupCard key={group.key} group={group} />)
      )}
    </div>
  );
}
