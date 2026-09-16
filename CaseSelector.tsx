import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, FileText, Loader2, Search, Eye, Pencil } from 'lucide-react';
import { apiClient } from '@/api/client';
import { listCases, getCase, cacheFromBackend, caseDisplayName, type BrandCase } from '@/lib/caseStore';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectTrigger } from '@/components/ui/select';
import { CaseFormDetailsModal } from '@/components/CaseFormDetailsModal';
import { EditNamingCriteriaModal } from '@/components/EditNamingCriteriaModal';

export function CaseSelector({
  value,
  onSelect,
  className,
}: {
  value?: string;
  onSelect: (c: BrandCase | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [viewingCase, setViewingCase] = useState<BrandCase | null>(null);
  const [editingCase, setEditingCase] = useState<BrandCase | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const casesQuery = useQuery({
    queryKey: ['suggestions'],
    queryFn: () => apiClient.listSuggestions(),
    staleTime: 30 * 1000,
  });

  const rawCases: BrandCase[] = casesQuery.data
    ? casesQuery.data.map((s) => cacheFromBackend(s)).sort((a, b) => b.saved_at.localeCompare(a.saved_at))
    : listCases();

  const cases = useMemo(() => {
    const list = [...rawCases];
    if (value && !list.some((c) => c.case_id === value)) {
      const local = getCase(value);
      if (local) {
        list.unshift(local);
      } else {
        list.unshift({
          case_id: value,
          id: value,
          generic_name: value,
          division: '',
          dosage_form: '',
          suggested_by: '',
          dose: '',
          date: '',
          ailment: '',
          segment: '',
          therapy: '',
          promoting_indications: '',
          mfd_type: '',
          in_license: '',
          manufacturer_location: '',
          mfg_for_others_yn: '',
          mfg_for_others: '',
          marketer_name: '',
          seller_name: '',
          parent_brand_owner: '',
          expected_launch_month: '',
          expected_sale: '',
          dcgi_combination_approved: '',
          drug_schedule: '',
          domestic_brand_names: '',
          international_brand_names: '',
          innovator_brands: '',
          patent_validity: '',
          launch_after_expiry: '',
          launch_after_expiry_month: '',
          launch_during_validity: '',
          launch_during_validity_arrangement: '',
          inventor_name: '',
          patient_name: '',
          place_of_origin: '',
          other_historical_association: '',
          saved_at: new Date().toISOString(),
        });
      }
    }
    // Deduplicate by case_id so identical entries never appear twice
    const seen = new Set<string>();
    return list.filter((c) => {
      if (!c.case_id || seen.has(c.case_id)) return false;
      seen.add(c.case_id);
      return true;
    });
  }, [rawCases, value]);

  const selectedCase = value ? cases.find((c) => c.case_id === value) : null;
  const selectedLabel = (selectedCase ? caseDisplayName(selectedCase) : value || '').trim() || undefined;

  const q = search.trim().toLowerCase();
  const filteredCases = useMemo(() => {
    if (!q) return cases;
    return cases.filter((c) => caseDisplayName(c).toLowerCase().includes(q) || c.case_id.toLowerCase().includes(q));
  }, [cases, q]);

  // Reset highlight index when search query changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [q]);

  // Auto-scroll highlighted item into view
  useEffect(() => {
    if (open && itemRefs.current[highlightedIndex]) {
      itemRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex, open]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setHighlightedIndex(0);
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else {
      setSearch('');
    }
  }, [open]);

  const handleSelectCase = (c: BrandCase | null) => {
    onSelect(c);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (filteredCases.length > 0) {
        setHighlightedIndex((prev) => (prev + 1) % filteredCases.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (filteredCases.length > 0) {
        setHighlightedIndex((prev) => (prev - 1 + filteredCases.length) % filteredCases.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (filteredCases.length > 0 && filteredCases[highlightedIndex]) {
        handleSelectCase(filteredCases[highlightedIndex]);
      }
    } else if (e.key === 'Tab') {
      if (filteredCases.length > 0 && filteredCases[highlightedIndex]) {
        handleSelectCase(filteredCases[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else {
      e.stopPropagation();
    }
  };

  return (
    <div className={cn('flex items-center min-w-0', className)}>
      <Select
        open={open}
        value={value ?? ''}
        onOpenChange={setOpen}
      >
        <SelectTrigger className="flex-1 min-w-0 h-9 text-sm text-left justify-start gap-2" title="Select a saved case">
          <FileText className="w-4 h-4 text-orange-500 flex-shrink-0" />
          <span className="truncate text-left flex-1 min-w-0">
            {selectedLabel ? (
              <span className="text-gray-900">{selectedLabel}</span>
            ) : (
              <span className="text-gray-400">
                {casesQuery.isLoading ? 'Loading cases…' : cases.length ? 'Select a Case…' : 'No saved cases yet'}
              </span>
            )}
          </span>
        </SelectTrigger>
        <SelectContent
          className="max-h-72 w-[min(90vw,26rem)] p-0 shadow-lg border-gray-200"
        >
          {/* Sticky search header with full keyboard arrow & Enter navigation */}
          <div className="sticky top-0 z-10 bg-white p-2 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                ref={searchInputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search cases…"
                className="w-full h-8 pl-8 pr-2 text-sm rounded-md border border-gray-200 focus:outline-none focus:ring-1 focus:ring-orange-300"
              />
            </div>
          </div>
          <div className="p-1 max-h-56 overflow-y-auto">
            {casesQuery.isLoading && (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading cases…
              </div>
            )}
            {casesQuery.isError && (
              <div className="px-3 py-2 text-xs text-red-500">Could not reach the server. Showing cases cached on this device.</div>
            )}
            {!casesQuery.isLoading && filteredCases.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-400">No cases match "{search}"</div>
            )}
            {filteredCases.map((c, index) => {
              const isHighlighted = index === highlightedIndex;
              const isSelected = value === c.case_id;
              return (
                <div
                  key={c.case_id}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelectCase(c)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSelectCase(c);
                    }
                  }}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  className={cn(
                    'group relative flex w-full max-w-full cursor-pointer select-none items-center justify-between rounded-md py-1.5 pl-2.5 pr-2 text-sm outline-none transition-colors',
                    isHighlighted ? 'bg-orange-50 text-orange-950 font-medium' : 'text-gray-700 hover:bg-gray-50',
                    isSelected && 'font-semibold text-orange-700 bg-orange-50/60'
                  )}
                  title={caseDisplayName(c) + ` (${c.case_id})`}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0 pr-2">
                    {isSelected && (
                      <span className="flex h-3.5 w-3.5 items-center justify-center text-orange-600 flex-shrink-0">
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <span className="block truncate text-xs">{caseDisplayName(c)}</span>
                  </div>

                  {/* Right-aligned View & Edit Action Icons */}
                  <div className="flex items-center gap-1 flex-shrink-0 opacity-80 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setViewingCase(c);
                      }}
                      className="p-1 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer"
                      title="View case details (Read-Only)"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditingCase(c);
                      }}
                      className="p-1 rounded-md text-gray-400 hover:text-orange-600 hover:bg-orange-100/70 transition-colors cursor-pointer"
                      title="Edit naming criteria"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </SelectContent>
      </Select>

      {/* View Form Details Modal */}
      <CaseFormDetailsModal
        open={Boolean(viewingCase)}
        onClose={() => setViewingCase(null)}
        caseData={viewingCase}
        caseId={viewingCase?.case_id}
      />

      {/* Edit Naming Criteria Modal */}
      <EditNamingCriteriaModal
        open={Boolean(editingCase)}
        onClose={() => setEditingCase(null)}
        caseData={editingCase}
        onSaveSuccess={(updated) => {
          if (value === updated.case_id) {
            onSelect(updated);
          }
        }}
      />
    </div>
  );
}
