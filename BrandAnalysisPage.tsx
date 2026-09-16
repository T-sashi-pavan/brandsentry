import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import {
  Search, AlertTriangle, CheckCircle, Shield, Loader2, Zap,
  BarChart2, Brain, ShoppingCart,
  Download,
  FileText, Link2, XCircle, X, Eye,
} from 'lucide-react';
import { downloadBrandAnalysisReport } from '@/lib/report';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiClient } from '@/api/client';
import { CaseSelector } from '@/components/CaseSelector';
import { CaseFormDetailsModal } from '@/components/CaseFormDetailsModal';
import { CreateCaseModal } from '@/components/CreateCaseModal';
import { ScreeningProgress } from '@/components/ScreeningProgress';
import {
  RiskAssessmentBanner, SimilarityAnalysisCard, ConflictSourcesCard,
  ScreeningWorkflowPanel, KnockoutValidationPanel,
  UniquenessAndBreakdown,
} from '@/components/ScreeningResultBlocks';
import { useCart } from '@/contexts/CartContext';
import { useAuth } from '@/contexts/AuthContext';
import { useActiveCase } from '@/contexts/ActiveCaseContext';
import { getCase, caseDisplayName, type BrandCase } from '@/lib/caseStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  cn, getRiskBgColor, getScoreColor, formatDate,
  getSimilarityTypeIcon, getSourceBadgeStyle, cleanSimilarityType, formatSourceName,
} from '@/lib/utils';

function getRiskBadge(level: string) {
  switch (level) {
    case 'HIGH': return <Badge variant="destructive">High Risk</Badge>;
    case 'MEDIUM': return <Badge variant="warning">Medium Risk</Badge>;
    default: return <Badge variant="success">Low Risk</Badge>;
  }
}

// Note: the old "Submit for Legal Review" modal that used to live here was
// removed along with its trigger button (see BrandAnalysisPage's action bar)
// — that flow now belongs to the future Trademark Review page. The backend
// `POST /legal/submit` endpoint itself is untouched; it simply has no caller
// in this file until that page exists.

// ─── Main Page ─────────────────────────────────────────────────────────────────

export function BrandAnalysisPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const cart = useCart();
  const { hasPermission } = useAuth();
  const { setActiveCase: setTopBarCase } = useActiveCase();
  // localStorage survives a full page reload (unlike sessionStorage in some
  // embeds) — guard the initial read so it doesn't crash during Next's
  // build-time static prerender (server-side, no localStorage there).
  const initialPersistedQ = (() => {
    try { return localStorage.getItem('pharma_last_query') || ''; } catch { return ''; }
  })();
  // Which case was linked/created — survives a remount the same way
  // pharma_last_query does, so navigating away and back (or a hard reload)
  // doesn't silently drop back to "Select a Case…" while the analyzed name
  // itself stays put. Cleared only by "New Search" or explicitly unlinking.
  const initialCaseId = (() => {
    try { return localStorage.getItem('pharma_active_case_id') || ''; } catch { return ''; }
  })();
  const initialCase = initialCaseId ? getCase(initialCaseId) ?? null : null;
  const [query, setQuery] = useState(initialPersistedQ);
  const [submittedName, setSubmittedName] = useState(initialPersistedQ);
  const [selectedCaseId, setSelectedCaseId] = useState<string>(initialCase?.case_id ?? '');
  // A case must be created or linked before a name can be screened, matching
  // the mock's Create New Case / Link Existing Case cards gating the search.
  const [activeCase, setActiveCase] = useState<BrandCase | null>(initialCase);
  const [showCreateCase, setShowCreateCase] = useState(false);
  const [showViewCaseModal, setShowViewCaseModal] = useState(false);

  // Restores the top-bar case chip on remount, silently — no toast, no
  // touching `query` (which already restored the actual searched name
  // independently and may differ from the case's own generic name).
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

  const applyCase = (c: BrandCase | null, opts?: { silent?: boolean }) => {
    if (!c) {
      setSelectedCaseId('');
      setActiveCase(null);
      setTopBarCase(null);
      setSubmittedName('');
      setQuery('');
      lastAnalyzedRef.current = '';
      setFrozenRejection(null);
      try {
        localStorage.removeItem('pharma_active_case_id');
        localStorage.removeItem('pharma_last_query');
      } catch { /* ignore */ }
      queryClient.removeQueries({ queryKey: ['screening'] });
      queryClient.removeQueries({ queryKey: ['intelligence'] });
      router.replace('/brand-analysis', undefined, { shallow: true });
      return;
    }

    setSelectedCaseId(c.case_id);
    setActiveCase(c);
    try { localStorage.setItem('pharma_active_case_id', c.case_id); } catch { /* ignore */ }
    setTopBarCase({
      caseId: c.case_id,
      createdBy: c.suggested_by || 'Unknown',
      createdAt: formatDate(c.saved_at),
    });

    const currentQ = (submittedName || query).trim();
    if (currentQ.length >= 2) {
      const href = `/brand-analysis?q=${encodeURIComponent(currentQ)}&case=${encodeURIComponent(c.case_id)}`;
      router.replace(href, undefined, { shallow: true });
    } else {
      const href = `/brand-analysis?case=${encodeURIComponent(c.case_id)}`;
      router.replace(href, undefined, { shallow: true });
    }

    if (!opts?.silent) toast.info(`Loaded ${c.case_id}. Enter a brand name to screen.`);
  };

  const handleCaseCreated = ({ caseRecord }: { caseRecord: BrandCase }) => {
    applyCase(caseRecord);
    setShowCreateCase(false);
  };

  // Brand Screening — DB-first with active case composition awareness
  const screeningQuery = useQuery({
    queryKey: ['screening', submittedName, activeCase?.case_id, activeCase?.generic_name, activeCase?.therapy],
    queryFn: () => apiClient.compareBrand({
      brand_name: submittedName,
      case_id: activeCase?.case_id,
      case_data: activeCase ? {
        case_id: activeCase.case_id,
        case_name: caseDisplayName(activeCase),
        generic_name: activeCase.generic_name,
        therapy: activeCase.therapy,
        segment: activeCase.segment,
        ailment: activeCase.ailment,
        dosage_form: activeCase.dosage_form,
        dose: activeCase.dose,
        promoting_indications: activeCase.promoting_indications,
        domestic_brand_names: activeCase.domestic_brand_names,
        international_brand_names: activeCase.international_brand_names,
        innovator_brands: activeCase.innovator_brands,
        parent_brand_owner: activeCase.parent_brand_owner,
        naming_information: activeCase.naming_information,
      } : undefined,
    }),
    enabled: !!activeCase && submittedName.trim().length >= 2,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  // Brand Intelligence query — fires when submittedName is set
  const intelligenceQuery = useQuery({
    queryKey: ['intelligence', submittedName],
    queryFn: () => apiClient.getBrandIntelligence(submittedName),
    enabled: !!activeCase && submittedName.trim().length >= 2,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const lastAnalyzedRef = useRef(initialPersistedQ);
  const [isManualRunning, setIsManualRunning] = useState(false);

  const handleAnalyze = (name?: string, addToHistory = false) => {
    if (!activeCase) return;
    const n = (name ?? query).trim();
    if (n.length < 2) return;
    setIsManualRunning(true);
    queryClient.invalidateQueries({ queryKey: ['screening'] });
    queryClient.invalidateQueries({ queryKey: ['intelligence'] });
    if (submittedName === n) {
      screeningQuery.refetch();
      intelligenceQuery.refetch();
    }
    setQuery(n);
    setSubmittedName(n);
    lastAnalyzedRef.current = n;
    try {
      localStorage.setItem('pharma_last_query', n);
      localStorage.setItem('pharma_active_case_id', activeCase.case_id);
    } catch { /* ignore */ }
    const href = `/brand-analysis?q=${encodeURIComponent(n)}&case=${encodeURIComponent(activeCase.case_id)}`;
    if (addToHistory) router.push(href); else router.replace(href, undefined, { shallow: true });
  };

  // Link a case carried over via ?case= before the ?q= auto-trigger below runs
  useEffect(() => {
    if (!router.isReady) return;
    const caseId = typeof router.query.case === 'string' ? router.query.case : '';
    if (caseId && caseId !== activeCase?.case_id) {
      const record = getCase(caseId);
      if (record) applyCase(record, { silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.case]);

  // Auto-trigger on URL ?q= param only when activeCase is present
  useEffect(() => {
    if (!router.isReady) return;
    const q = typeof router.query.q === 'string' ? router.query.q : '';
    if (q && activeCase && q !== lastAnalyzedRef.current) handleAnalyze(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.q, activeCase]);

  const screeningResult = screeningQuery.data ?? null;
  const sr = screeningResult?.screening_result;
  const intel = intelligenceQuery.data;
  const hasResults = !!activeCase && !!submittedName && submittedName.trim().length >= 2;

  useEffect(() => {
    if (screeningResult) {
      setIsManualRunning(false);
    }
  }, [screeningResult]);

  const screeningLoading = (!screeningResult && (screeningQuery.isLoading || screeningQuery.isFetching)) || isManualRunning;
  const intelLoading = intelligenceQuery.isFetching;

  // Briefly freeze the pipeline progress panel on the stage that actually
  // rejected the name, instead of letting it vanish straight to the results section
  const [frozenRejection, setFrozenRejection] = useState<{ stage: number; reason: string } | null>(null);
  const freezeShownForRef = useRef<string | null>(null);

  useEffect(() => {
    if (sr?.rejected_at_stage && sr.rejection_reason && sr.id !== freezeShownForRef.current) {
      freezeShownForRef.current = sr.id;
      setFrozenRejection({ stage: sr.rejected_at_stage, reason: sr.rejection_reason });
      const t = setTimeout(() => setFrozenRejection(null), 1800);
      return () => clearTimeout(t);
    }
  }, [sr]);

  const similarNames = sr ? (sr.similar_names || []) : [];
  const conflicts = sr ? (sr.conflicts || []) : [];

  const inCart = screeningResult ? cart.has(screeningResult.brand_name) : false;
  const alreadySubmitted = screeningResult ? cart.isSubmitted(screeningResult.brand_name) : false;

  const handleAddToReviewBatch = async () => {
    if (!screeningResult || !sr || inCart || alreadySubmitted) return;
    const added = await cart.add({
      brand_name: screeningResult.brand_name,
      source_type: 'screening',
      brand_search_id: screeningResult.id,
      risk_score: sr.overall_risk_score,
      risk_level: sr.risk_classification,
      risk_ai_assessment: sr.ai_assessment ?? undefined,
      case_id: activeCase?.case_id,
      case_name: activeCase ? caseDisplayName(activeCase) : undefined,
    });
    if (added) toast.success(`"${screeningResult.brand_name}" added to review batch`);
    else toast.info(`"${screeningResult.brand_name}" is already in your review batch`);
  };

  const handleClearQuery = () => {
    setSubmittedName('');
    setQuery('');
    lastAnalyzedRef.current = '';
    setFrozenRejection(null);
    try { localStorage.removeItem('pharma_last_query'); } catch { /* ignore */ }
    queryClient.removeQueries({ queryKey: ['screening'] });
    queryClient.removeQueries({ queryKey: ['intelligence'] });
    if (activeCase) {
      router.replace(`/brand-analysis?case=${encodeURIComponent(activeCase.case_id)}`, undefined, { shallow: true });
    } else {
      router.replace('/brand-analysis', undefined, { shallow: true });
    }
  };

  const handleNewSearch = () => {
    applyCase(null);
  };

  const handleStopScreening = () => {
    queryClient.cancelQueries({ queryKey: ['screening'] });
    queryClient.cancelQueries({ queryKey: ['intelligence'] });
    handleClearQuery();
    toast.info('Brand screening cancelled by user');
  };


  return (
    <div className="min-h-screen bg-[#fffaf5]">
      <div className="py-6 px-6">
        <div className="max-w-5xl mx-auto">
          {/* Create New Case / Link Existing Case — a case must be active before a name can be screened */}
          {!activeCase && (
            <div className="grid sm:grid-cols-2 gap-4 mb-6">
              <div className="bg-orange-50 border border-orange-200 rounded-2xl p-5">
                <p className="font-semibold text-gray-900 flex items-center gap-2 mb-1">
                  <FileText className="w-4 h-4 text-orange-600" /> Create New Case
                </p>
                <p className="text-sm text-gray-500 mb-3">Create a new case to start brand analysis</p>
                <Button className="gap-1.5" onClick={() => setShowCreateCase(true)}>
                  <FileText className="w-4 h-4" /> Create a Case
                </Button>
              </div>
              <div className="bg-white border border-gray-200 rounded-2xl p-5">
                <p className="font-semibold text-gray-900 flex items-center gap-2 mb-1">
                  <Link2 className="w-4 h-4 text-orange-500" /> Link Existing Case
                </p>
                <p className="text-sm text-gray-500 mb-3">Select an existing case to continue analysis</p>
                <CaseSelector value={selectedCaseId} onSelect={applyCase} />
              </div>
            </div>
          )}

          {/* Single responsive row — name input, case, action buttons (when results exist), Run Screening */}
          <div className="flex gap-2.5 items-end flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium text-gray-500 mb-1">Enter a Name to Screen</label>
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAnalyze()}
                  placeholder={activeCase ? 'e.g. Vivantor' : 'Create or link a case to begin screening'}
                  disabled={!activeCase}
                  className="w-full h-11 pl-10 pr-8 text-sm rounded-xl border border-gray-200 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-orange-300 placeholder:text-gray-400 disabled:opacity-60 disabled:cursor-not-allowed"
                />
                {query && activeCase && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      if (submittedName) {
                        handleClearQuery();
                      }
                    }}
                    aria-label="Clear search"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Case selector / pill */}
            {activeCase && (
              <div className="w-full sm:w-64 md:w-72 min-w-0 flex-shrink-0">
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-gray-500">Case</label>
                  <button
                    type="button"
                    onClick={() => setShowViewCaseModal(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-orange-600 hover:text-orange-700 hover:underline cursor-pointer"
                    title="View case form details"
                  >
                    <Eye className="w-3 h-3" /> View Form Details
                  </button>
                </div>
                <div className="h-11 px-3 rounded-xl border border-orange-200 bg-orange-50/70 shadow-sm flex items-center justify-between gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() => setShowViewCaseModal(true)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer group"
                    title="Click to view case form details"
                  >
                    <FileText className="w-3.5 h-3.5 text-orange-600 flex-shrink-0" />
                    <span className="text-xs font-semibold text-orange-950 truncate group-hover:underline">
                      {caseDisplayName(activeCase)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => applyCase(null)}
                    aria-label="Remove linked case"
                    title="Remove linked case"
                    className="flex-shrink-0 text-orange-400 hover:text-red-500 p-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Action buttons embedded directly in the same row when results exist */}
            {hasResults && (
              <Button
                variant="outline"
                size="sm"
                className="h-11 px-3.5 text-xs text-gray-700 bg-white border-gray-200 hover:border-orange-400 hover:text-orange-600 rounded-xl shadow-sm flex-shrink-0"
                onClick={handleNewSearch}
              >
                New Search
              </Button>
            )}

            <Button
              onClick={() => handleAnalyze()}
              disabled={!activeCase || query.trim().length < 2 || screeningLoading || !hasPermission('brand_analysis', 'run_analysis')}
              title={!hasPermission('brand_analysis', 'run_analysis') ? 'Permission required to run brand screening' : undefined}
              className="h-11 px-5 bg-orange-500 hover:bg-orange-600 text-white rounded-xl shadow font-semibold text-xs sm:text-sm flex-shrink-0 disabled:opacity-50"
            >
              {screeningLoading
                ? <><Loader2 className="w-4 h-4 animate-spin mr-1.5" /> Screening...</>
                : <><Zap className="w-4 h-4 mr-1.5" /> Run Screening</>}
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* ══ RISK SCREENING RESULTS ══ */}
        {hasResults && (
          <>
            {(screeningLoading || frozenRejection) ? (
              <ScreeningProgress
                isScreening={screeningLoading}
                brandName={submittedName}
                rejectedAt={frozenRejection}
                onStop={handleStopScreening}
              />
            ) : screeningQuery.isError ? (
              <div className="text-center py-20 text-red-500">
                <AlertTriangle className="w-10 h-10 mx-auto mb-3" />
                <p>Screening failed. Please try again.</p>
              </div>
            ) : sr ? (
              <div className="space-y-6 animate-fade-in">
                <RiskAssessmentBanner
                  sr={sr}
                  brandName={screeningResult?.brand_name ?? ''}
                  actions={
                    screeningResult ? (
                      <>
                        {hasPermission('brand_analysis', 'export_pdf') && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!intel || intelLoading}
                            title={!intel ? 'Waiting for analysis data…' : 'Download full screening report'}
                            className="h-8 px-3 flex items-center gap-1.5 text-xs text-gray-700 bg-white border-gray-200 hover:border-orange-400 hover:text-orange-600 disabled:opacity-50 rounded-lg shadow-sm"
                            onClick={() => intel && downloadBrandAnalysisReport(screeningResult, intel)}
                          >
                            <Download className="w-3.5 h-3.5" />
                            {intelLoading ? 'Preparing…' : 'Download Report'}
                          </Button>
                        )}
                        {hasPermission('generator', 'add_to_cart') && (
                          <Button
                            size="sm"
                            disabled={inCart || alreadySubmitted}
                            title={alreadySubmitted ? 'Already submitted for Trademark Review' : undefined}
                            className={cn(
                              'h-8 px-3.5 flex items-center gap-1.5 text-xs text-white rounded-lg shadow-sm font-medium',
                              (inCart || alreadySubmitted) ? 'bg-gray-400 hover:bg-gray-400 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-700'
                            )}
                            onClick={handleAddToReviewBatch}
                          >
                            {(inCart || alreadySubmitted) ? <CheckCircle className="w-3.5 h-3.5" /> : <ShoppingCart className="w-3.5 h-3.5" />}
                            {alreadySubmitted ? 'Submitted for Review' : inCart ? 'In Review Batch' : 'Add to Review Batch'}
                          </Button>
                        )}
                      </>
                    ) : undefined
                  }
                />

                {/* Sequential pipeline stopped early */}
                {sr.rejected_at_stage && sr.rejection_reason && (
                  <Card className="border-red-200 bg-red-50">
                    <CardContent className="py-4">
                      <div className="flex items-start gap-3">
                        <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="text-sm font-bold text-red-800">
                            Rejected at Stage {sr.rejected_at_stage}: {sr.rejected_stage_name}
                          </p>
                          <p className="text-sm text-red-700 mt-1">{sr.rejection_reason}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Similarity Analysis + Conflict Sources */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <SimilarityAnalysisCard sr={sr} />
                  <ConflictSourcesCard sr={sr} />
                </div>

                <ScreeningWorkflowPanel sr={sr} stagesCompleted={sr.stages_completed} />

                {/* Case Composition & Clinical Coining Rationale hidden per user request */}
                {/* <CaseCompositionRationaleCard sr={sr} activeCase={activeCase} brandName={screeningResult?.brand_name ?? submittedName} /> */}

                <KnockoutValidationPanel sr={sr} brandName={screeningResult?.brand_name ?? submittedName} />
                <UniquenessAndBreakdown
                  intel={intel || {
                    brand_name: screeningResult?.brand_name ?? submittedName,
                    brand_uniqueness_score: Math.max(0, 100 - Math.round(sr.overall_risk_score || 0)),
                    trademark_presence: sr.trademark_conflict_score || 0,
                    market_presence: sr.market_presence_score || 0,
                    epharmacy_presence: sr.epharmacy_conflicts > 0 ? 1.0 : 0.0,
                    geographic_reach: sr.epharmacy_conflicts > 0 ? 1 : 0,
                    competitor_count: (sr.conflicts || []).length,
                    market_saturation: Math.min(1.0, ((sr.conflicts || []).length + (sr.similar_names || []).length) / 10.0),
                    ai_summary: sr.ai_assessment || undefined,
                    similar_brands: (sr.similar_names || []).map(sn => ({ ...sn, id: sn.id || '' })),
                    competitive_landscape: [],
                    trend_data: [],
                    similarity_breakdown: [],
                    risk_distribution: [],
                  }}
                  sr={sr}
                />

                {/* Similar Names Table */}
                {similarNames.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                          <Search className="w-5 h-5 text-orange-600" /> Similar Brand Names
                        </CardTitle>
                        <Badge variant="secondary">{similarNames.length} found</Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-100">
                              {['Brand Name', 'Similarity Type', 'Score', 'Source', 'Therapeutic Area', 'Risk'].map(h => (
                                <th key={h} className="text-left py-3 px-2 text-gray-500 font-medium">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {similarNames.map(sn => (
                              <tr key={sn.id} className="hover:bg-gray-50">
                                <td className="py-3 px-2">
                                  <span className="font-semibold text-gray-900">{sn.name}</span>
                                  {sn.manufacturer && <p className="text-xs text-gray-400">{sn.manufacturer}</p>}
                                </td>
                                <td className="py-3 px-2">
                                  <span className="flex items-center gap-1.5">
                                    {getSimilarityTypeIcon(sn.similarity_type)}
                                    <span className="text-gray-700">{cleanSimilarityType(sn.similarity_type)}</span>
                                  </span>
                                </td>
                                <td className="py-3 px-2">
                                  <div className="flex items-center gap-2">
                                    <div className="w-16 bg-gray-100 rounded-full h-1.5">
                                      <div className={cn('h-1.5 rounded-full', sn.similarity_score >= 0.7 ? 'bg-red-500' : sn.similarity_score >= 0.45 ? 'bg-orange-400' : 'bg-green-500')}
                                        style={{ width: `${sn.similarity_score * 100}%` }} />
                                    </div>
                                    <span className={cn('font-semibold text-xs', getScoreColor(sn.similarity_score * 100))}>
                                      {(sn.similarity_score * 100).toFixed(0)}%
                                    </span>
                                  </div>
                                </td>
                                <td className="py-3 px-2"><span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium', getSourceBadgeStyle(sn.source))}>{formatSourceName(sn.source)}</span></td>
                                <td className="py-3 px-2 text-gray-600 text-xs">{sn.therapeutic_area || 'N/A'}</td>
                                <td className="py-3 px-2">{getRiskBadge(sn.risk_level)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Conflicts Detail */}
                {conflicts.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2 text-red-700">
                          <AlertTriangle className="w-5 h-5" /> Detected Conflicts
                        </CardTitle>
                        <Badge variant="destructive">{conflicts.length} conflicts</Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {conflicts.map(c => (
                          <div key={c.id} className={cn('p-4 rounded-xl border', getRiskBgColor(c.severity))}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="font-bold text-gray-900">{c.conflicting_name}</span>
                                  <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium', getSourceBadgeStyle(c.source))}>{formatSourceName(c.source)}</span>
                                </div>
                                <p className="text-sm text-gray-600">{c.details}</p>
                                {c.owner && <p className="text-xs text-gray-500 mt-1">Owner: {c.owner}</p>}
                                {c.registration_number && <p className="text-xs text-gray-500">Reg #: {c.registration_number}</p>}
                              </div>
                              <div className="flex flex-col items-end gap-1">
                                {getRiskBadge(c.severity)}
                                <span className="text-xs text-gray-500">{c.conflict_type.replace(/_/g, ' ')}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

              </div>
            ) : null}
          </>
        )}

        {/* Empty state */}
        {!hasResults && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
            {[
              { icon: Shield, title: 'Risk Screening', desc: 'Exact, phonetic, spelling & semantic conflict detection against connected sources', color: 'blue' },
              { icon: BarChart2, title: 'Uniqueness & Similarity', desc: 'Brand uniqueness score, market saturation and similarity breakdown across all sources', color: 'purple' },
              { icon: Brain, title: 'AI Assessment', desc: 'Claude Sonnet powered rationale explaining why a name is recommended, flagged or rejected', color: 'green' },
            ].map(({ icon: Icon, title, desc, color }) => (
              <div key={title} className="bg-white rounded-xl border border-gray-100 p-6 text-center">
                <div className={cn('w-12 h-12 rounded-xl mx-auto mb-4 flex items-center justify-center', `bg-${color}-100`)}>
                  <Icon className={cn('w-6 h-6', `text-${color}-600`)} />
                </div>
                <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
                <p className="text-sm text-gray-500">{desc}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <CreateCaseModal
        open={showCreateCase}
        onClose={() => setShowCreateCase(false)}
        onSuccess={handleCaseCreated}
        submitLabel="Create Case"
      />

      <CaseFormDetailsModal
        open={showViewCaseModal}
        onClose={() => setShowViewCaseModal(false)}
        caseData={activeCase}
        caseId={selectedCaseId}
      />
    </div>
  );
}
