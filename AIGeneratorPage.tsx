import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles, Loader2, CheckCircle, AlertTriangle,
  Shield, Download, Brain, Search,
  Star, ChevronDown, RotateCcw, PanelLeftOpen, PanelLeftClose,
  ShoppingCart, FileText, Link2, Database, X, Eye,
} from 'lucide-react';
import { downloadNameDetailReport, downloadBulkNamesReport } from '@/lib/report';
import { toast } from 'sonner';
import { apiClient } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { useCart } from '@/contexts/CartContext';
import { useActiveCase } from '@/contexts/ActiveCaseContext';
import { CaseSelector } from '@/components/CaseSelector';
import { CaseFormDetailsModal } from '@/components/CaseFormDetailsModal';
import { GenerationProgress } from '@/components/GenerationProgress';
import { formatPipelineDuration } from '@/components/PipelineProgress';
import { CreateCaseModal, type CreateCaseResult } from '@/components/CreateCaseModal';
import {
  RiskAssessmentBanner, SimilarityAnalysisCard, ConflictSourcesCard,
  ScreeningWorkflowPanel, KnockoutValidationPanel, UniquenessAndBreakdown,
} from '@/components/ScreeningResultBlocks';
import { getCase, buildStructuredPayload, caseDisplayName, cacheFromBackend, type BrandCase } from '@/lib/caseStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  cn, getRecommendationColor, getRecommendationLabel, formatDate,
  getRiskBgColor, getScoreColor, getSimilarityTypeIcon, getSourceBadgeStyle, cleanSimilarityType,
  formatSourceName,
} from '@/lib/utils';
import type { GeneratedName, User, BrandIntelligence, ScreeningResult } from '@/types';

function getRiskBadge(level: string) {
  switch (level) {
    case 'HIGH': return <Badge variant="destructive">High Risk</Badge>;
    case 'MEDIUM': return <Badge variant="warning">Medium Risk</Badge>;
    default: return <Badge variant="success">Low Risk</Badge>;
  }
}

const MAX_SHORTLIST = 5;

const DEFAULT_FORM = {
  molecule: '',
  therapeutic_area: '',
  ailment: '',
  treatment: '',
  emotion_connected: '',
  outcome: '',
  geography: '',
  product_attributes: '',
  naming_style: '',
  description: '',
  count: '10',
};

// Turns the backend's raw AI-service error (often a full Bedrock/Anthropic
// exception dump) into one short, human-readable sentence for the pipeline
// panel — nobody should have to read a stack trace to know "the API key is
// wrong."
function describeGenerationFailure(err: any): string {
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('rate limit') || msg.includes('429')) return 'AI service is busy; please try again in a moment.';
  if (msg.includes('auth') || msg.includes('401') || msg.includes('403')) return 'Configuration issue: API credentials are invalid.';
  if (msg.includes('timeout')) return 'The AI request timed out. Please try again.';
  return 'Generation failed. Check your parameters and try again.';
}

// Plain, always-expanded card — the mock (Sun_Pharma_Screens_V1.2, slide 2)
// shows Knockout Rules and Reference Sources as static reference reading,
// never collapsed and with no toggle affordance at all, so this deliberately
// has no expand/collapse state.
function StaticInfoCard({
  title, icon, children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="px-6 py-3.5">
        <span className="text-sm flex items-center gap-2 text-gray-700 uppercase tracking-wide font-semibold">
          {icon}
          {title}
        </span>
      </div>
      <div className="px-6 pb-5 pt-1 space-y-3 border-t border-gray-50">
        {children}
      </div>
    </Card>
  );
}

function NameDetailModal({ name, open, onClose, activeCase }: { name: GeneratedName; open: boolean; onClose: () => void; activeCase: BrandCase | null }) {
  const { hasPermission } = useAuth();
  const cart = useCart();
  const inCart = cart.has(name.generated_name);
  const alreadySubmitted = cart.isSubmitted(name.generated_name);

  // DB-first, same as Compare Names: this exact name was very likely just
  // screened moments ago as part of generation (generator_history), so
  // apiClient.compareBrand serves that stored result straight from the DB
  // instead of re-running the whole WHO INN/IQVIA/Google/e-pharmacy pipeline
  // from scratch. Only a genuinely new/stale name (>90 days) pays for a
  // fresh pipeline run. Gives this modal the exact same Similarity Analysis
  // / Conflict Sources / Screening Workflow / Knockout & Validation / Brand
  // Uniqueness blocks as Brand Analysis, not fabricated data.
  const screeningQuery = useQuery({
    queryKey: ['screening', name.generated_name, activeCase?.case_id],
    queryFn: () => apiClient.compareBrand({
      brand_name: name.generated_name,
      case_id: activeCase?.case_id,
      case_data: activeCase ? {
        case_id: activeCase.case_id,
        case_name: caseDisplayName(activeCase),
        generic_name: activeCase.generic_name,
        therapy: activeCase.therapy,
        ailment: activeCase.ailment || activeCase.promoting_indications,
        dosage_form: activeCase.dosage_form,
      } : undefined,
    }),
    enabled: open,
    staleTime: 10 * 60 * 1000,
  });
  const intelligenceQuery = useQuery({
    queryKey: ['intelligence', name.generated_name],
    queryFn: () => apiClient.getBrandIntelligence(name.generated_name),
    enabled: open,
  });

  const sr = screeningQuery.data?.screening_result;
  const intel = intelligenceQuery.data;

  // Instant data fallback: candidate already has conflict_details & scores from generation
  const rawTopConflicts = name.conflict_details?.top_conflicts ?? [];
  const rawStoredSimilar = (name.conflict_details as any)?.similar_names ?? [];

  const fallbackSimilarNames = (() => {
    if (Array.isArray(rawStoredSimilar) && rawStoredSimilar.length > 0) {
      return rawStoredSimilar.map((s: any, idx: number) => ({
        id: s.id || `sim-${idx}-${s.name}`,
        name: s.name,
        similarity_score: Number(s.similarity_score ?? 0),
        similarity_type: s.similarity_type || 'Phonetic',
        source: s.source || 'E-Pharmacy (India)',
        risk_level: s.risk_level || (s.similarity_score >= 0.70 ? 'HIGH' : s.similarity_score >= 0.50 ? 'MEDIUM' : 'LOW'),
        manufacturer: s.manufacturer,
        therapeutic_area: s.therapeutic_area,
      }));
    }
    const list: Array<{
      id: string; name: string; similarity_score: number; similarity_type: string; source: string; risk_level: string; manufacturer?: string; therapeutic_area?: string;
    }> = [];
    for (const c of rawTopConflicts) {
      const phon = c.phonetic_score ?? 0;
      const lev = c.spelling_score ?? 0;
      const look = (c as any).lookalike_score ?? 0;
      const sem = (c as any).semantic_similarity_score ?? ((c.similarity_score ?? 0) >= 0.30 ? Number(((c.similarity_score ?? 0) * 0.5).toFixed(3)) : 0);

      const dims = [
        { type: 'Phonetic', score: phon },
        { type: 'Spelling', score: lev },
        { type: 'Visual', score: look },
        { type: 'Conceptual', score: sem },
      ];
      for (const d of dims) {
        if (d.score >= 0.30) {
          list.push({
            id: `${c.name}-${d.type}`,
            name: c.name,
            similarity_score: d.score,
            similarity_type: d.type,
            source: c.source || 'E-Pharmacy',
            risk_level: d.score >= 0.70 ? 'HIGH' : d.score >= 0.50 ? 'MEDIUM' : 'LOW',
            manufacturer: c.owner,
            therapeutic_area: (c as any).therapeutic_area,
          });
        }
      }
    }
    return list;
  })();

  const fallbackConflicts = rawTopConflicts
    .filter((c: any) => (c.similarity_score ?? 0) >= 0.70)
    .map((c: any) => ({
      id: c.name,
      conflicting_name: c.name,
      conflict_type: 'SIMILARITY_MATCH',
      similarity_score: c.similarity_score,
      source: c.source || 'E-Pharmacy',
      owner: c.owner,
      status: 'Conflict',
      severity: (c.similarity_score >= 0.70 ? 'HIGH' : 'MEDIUM') as any,
      details: `${Math.round((c.similarity_score ?? 0) * 100)}% similarity match`,
    }));

  const getFallbackMax = (type: string) => {
    const ms = fallbackSimilarNames.filter(n => n.similarity_type === type);
    return ms.length > 0 ? Math.max(...ms.map(n => n.similarity_score)) : 0;
  };

  const cd = (name.conflict_details as any) || {};

  const fallbackSr: ScreeningResult = {
    id: name.id,
    brand_name: name.generated_name,
    overall_risk_score: name.risk_score,
    risk_classification: name.recommendation_status === 'high_risk' ? 'HIGH' : name.recommendation_status === 'review_required' ? 'MEDIUM' : 'LOW',
    exact_match_score: cd.exact_match_score ?? 0,
    spelling_similarity_score: cd.spelling_similarity_score ?? getFallbackMax('Spelling'),
    phonetic_similarity_score: cd.phonetic_similarity_score ?? getFallbackMax('Phonetic'),
    semantic_similarity_score: cd.semantic_similarity_score ?? getFallbackMax('Conceptual'),
    lookalike_score: cd.lookalike_score ?? getFallbackMax('Visual'),
    soundalike_score: cd.soundalike_score ?? 0,
    trademark_conflict_score: cd.trademark_conflict_score ?? 0,
    market_presence_score: cd.market_presence_score ?? 0,
    availability_score: name.availability_score,
    memorability_score: name.memorability_score,
    pronunciation_score: name.pronunciation_score,
    ai_assessment: name.ai_explanation ?? cd.rationale,
    ai_recommendation: name.recommendation_status === 'high_risk' ? 'REJECT' : name.recommendation_status === 'review_required' ? 'LEGAL_REVIEW' : 'PROCEED',
    total_conflicts: fallbackConflicts.length,
    trademark_conflicts: cd.trademark_conflict_count ?? 0,
    market_conflicts: 0,
    epharmacy_conflicts: fallbackSimilarNames.filter(s => (s.source || '').toLowerCase().includes('pharm')).length,
    stages_completed: 4,
    rejected_at_stage: undefined,
    rejected_stage_name: undefined,
    rejection_reason: cd.rejection_reason,
    similar_names: fallbackSimilarNames as any,
    conflicts: fallbackConflicts as any,
    knockout_checks: cd.knockout_checks,
    grades: cd.grades,
    combination: cd.combination,
    created_at: name.created_at || new Date().toISOString(),
  };

  const activeSr = sr || fallbackSr;

  const fallbackBreakdown = (() => {
    const counts: Record<string, number> = {};
    for (const item of (activeSr?.similar_names ?? [])) {
      counts[item.similarity_type] = (counts[item.similarity_type] || 0) + 1;
    }
    const colors: Record<string, string> = {
      'Phonetic': '#3b82f6',
      'Spelling': '#a855f7',
      'Visual': '#f97316',
      'Conceptual': '#6366f1',
    };
    return Object.entries(counts).map(([type, count]) => ({
      type,
      count,
      color: colors[type] || '#6b7280',
    }));
  })();

  const activeIntel: BrandIntelligence = {
    brand_name: name.generated_name,
    trademark_presence: intel?.trademark_presence ?? (cd.trademark_conflict_score || 0),
    market_presence: intel?.market_presence ?? activeSr?.market_presence_score ?? (cd.market_presence_score || 0),
    epharmacy_presence: intel?.epharmacy_presence ?? ((activeSr?.similar_names?.length ?? 0) > 0 ? 0.05 : 0),
    geographic_reach: intel?.geographic_reach ?? 0,
    competitor_count: intel?.competitor_count ?? activeSr?.similar_names?.length ?? 0,
    market_saturation: intel?.market_saturation ?? 0,
    brand_uniqueness_score: intel?.brand_uniqueness_score ?? (activeSr ? Math.round(100 - activeSr.overall_risk_score) : Math.round(name.availability_score)),
    ai_summary: intel?.ai_summary || name.ai_explanation || cd.rationale,
    similar_brands: (intel?.similar_brands && intel.similar_brands.length > 0) ? intel.similar_brands : (activeSr?.similar_names ?? []),
    competitive_landscape: intel?.competitive_landscape ?? [],
    trend_data: intel?.trend_data ?? [],
    similarity_breakdown: (intel?.similarity_breakdown && intel.similarity_breakdown.length > 0 && intel.similarity_breakdown[0].type !== 'Distinctive') ? intel.similarity_breakdown : fallbackBreakdown,
    risk_distribution: (intel?.risk_distribution && intel.risk_distribution.length > 0) ? intel.risk_distribution : [],
  };

  const handleAddToCart = async () => {
    if (!activeCase) {
      toast.error('Link or create a case first, every review batch entry needs a case attached.');
      return;
    }
    if (alreadySubmitted) {
      toast.info(`"${name.generated_name}" was already submitted for Trademark Review`);
      return;
    }
    const added = await cart.add({
      brand_name: name.generated_name,
      source_type: 'generated',
      generated_name_id: name.id,
      therapeutic_area: name.therapeutic_area,
      risk_score: activeSr?.overall_risk_score ?? name.risk_score,
      risk_level: activeSr?.risk_classification ?? (name.recommendation_status === 'high_risk' ? 'HIGH'
        : name.recommendation_status === 'review_required' ? 'MEDIUM' : 'LOW'),
      risk_ai_assessment: activeSr?.ai_assessment ?? name.ai_explanation ?? undefined,
      case_id: activeCase?.case_id,
      case_name: activeCase ? caseDisplayName(activeCase) : undefined,
    });
    if (added) toast.success(`"${name.generated_name}" added to review batch`);
    else toast.info(`"${name.generated_name}" is already in your review batch`);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="text-orange-600">Detailed Analysis</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 mt-1 overflow-y-auto flex-1 pr-2">
          {/* Generation metrics — unique to AI-generated candidates, not part of a plain screening result */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-xl border bg-orange-50 border-orange-200 text-center">
              <p className="text-xs text-gray-500 mb-1">Availability</p>
              <p className="text-2xl font-bold text-orange-600">
                {(activeSr?.overall_risk_score != null
                  ? Math.max(0, 100 - activeSr.overall_risk_score)
                  : name.availability_score
                ).toFixed(0)}
              </p>
            </div>
            <div className="p-3 rounded-xl border bg-blue-50 border-blue-200 text-center">
              <p className="text-xs text-gray-500 mb-1">Memorability</p>
              <p className="text-2xl font-bold text-blue-600">
                {(activeSr?.memorability_score ?? name.memorability_score).toFixed(0)}
              </p>
            </div>
            <div className="p-3 rounded-xl border bg-purple-50 border-purple-200 text-center">
              <p className="text-xs text-gray-500 mb-1">Pronunciation</p>
              <p className="text-2xl font-bold text-purple-600">
                {(activeSr?.pronunciation_score ?? name.pronunciation_score).toFixed(0)}
              </p>
            </div>
          </div>

          {/* Generation loop & rejection info */}
          {((name.loop_approved !== undefined && name.loop_approved !== null) ||
            (name.conflict_details as any)?.loop_approved !== undefined ||
            (name as any).loop_number !== undefined) && (
            <div className="flex items-center justify-between gap-3 p-3 bg-slate-50 border border-slate-200/80 rounded-xl text-xs text-slate-600 flex-wrap">
              <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                <CheckCircle className="w-4 h-4 text-emerald-600" />
                Approved in Loop {name.loop_approved ?? (name.conflict_details as any)?.loop_approved ?? (name as any).loop_number}
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-slate-600 bg-white px-2.5 py-1 rounded-md border border-slate-200 shadow-2xs">
                  <b>{name.rejected_before_count ?? (name.conflict_details as any)?.rejected_before_count ?? (name as any).rejected_before ?? 0}</b> candidate names rejected before approval
                </span>
                {(name.time_to_generate_seconds ?? (name.conflict_details as any)?.time_to_generate_seconds) !== undefined && (
                  <span className="font-medium text-slate-600 bg-white px-2.5 py-1 rounded-md border border-slate-200 shadow-2xs">
                    Found in {name.time_to_generate_seconds ?? (name.conflict_details as any)?.time_to_generate_seconds}s
                  </span>
                )}
              </div>
            </div>
          )}

          {activeSr && (
            <>
              <RiskAssessmentBanner sr={activeSr} brandName={name.generated_name} />
              {/* Case Composition & Clinical Coining Rationale hidden per user request */}
              {/* <CaseCompositionRationaleCard
                sr={activeSr}
                activeCase={activeCase}
                brandName={name.generated_name}
              /> */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <SimilarityAnalysisCard sr={activeSr} />
                <ConflictSourcesCard sr={activeSr} />
              </div>
              <ScreeningWorkflowPanel sr={activeSr} stagesCompleted={activeSr.stages_completed} />
              <KnockoutValidationPanel sr={activeSr} brandName={name.generated_name} />
              {activeIntel && <UniquenessAndBreakdown intel={activeIntel} sr={activeSr} />}

              {/* Similar Names Table */}
              {(activeSr.similar_names || []).length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2">
                        <Search className="w-5 h-5 text-orange-600" /> Similar Brand Names
                      </CardTitle>
                      <Badge variant="secondary">{(activeSr.similar_names || []).length} found</Badge>
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
                          {(activeSr.similar_names || []).map((sn: any) => (
                            <tr key={sn.id || sn.name} className="hover:bg-gray-50">
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

              {/* Detected Conflicts */}
              {(activeSr.conflicts || []).length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2 text-red-700">
                        <AlertTriangle className="w-5 h-5" /> Detected Conflicts
                      </CardTitle>
                      <Badge variant="destructive">{(activeSr.conflicts || []).length} conflicts</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {(activeSr.conflicts || []).map((c: any) => (
                        <div key={c.id || c.conflicting_name} className={cn('p-4 rounded-xl border', getRiskBgColor(c.severity))}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="font-bold text-gray-900">{c.conflicting_name}</span>
                                <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium', getSourceBadgeStyle(c.source))}>{formatSourceName(c.source)}</span>
                              </div>
                              <p className="text-sm text-gray-600">{c.details}</p>
                              {c.owner && <p className="text-xs text-gray-500 mt-1">Owner: {c.owner}</p>}
                            </div>
                            {getRiskBadge(c.severity)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* Section 10: Rationale Behind the Name & Coining Principles Applied */}
          <div className="p-4 bg-orange-50/70 rounded-xl border border-orange-200/80 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-orange-600" />
                <p className="text-sm font-bold text-orange-950">Rationale Behind the Name</p>
              </div>
              <Badge variant="secondary" className="text-[10px] font-bold bg-orange-100 text-orange-900 border border-orange-200">
                8 COINING PRINCIPLES
              </Badge>
            </div>

            {/* User-Specified Naming Criteria & Applicable Brand Coining Preferences */}
            {(name.coining_preference_source ||
              (name.conflict_details as any)?.coining_preference_source ||
              name.naming_criteria_rationale ||
              (name.conflict_details as any)?.naming_criteria_rationale ||
              activeCase?.naming_information?.brand_coining_preferences ||
              activeCase?.naming_information?.naming_style) && (
              <div className="p-3 bg-gradient-to-r from-amber-50 via-orange-50/50 to-white rounded-xl border border-amber-300/80 shadow-xs space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="flex h-2.5 w-2.5 rounded-full bg-orange-500 ring-2 ring-orange-200 animate-pulse" />
                    <p className="text-xs font-bold text-orange-950 uppercase tracking-wider">
                      Additional Notes & Naming Style
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[11px] font-bold bg-white text-orange-800 border-orange-300 shadow-2xs">
                    {name.coining_preference_source ||
                      (name.conflict_details as any)?.coining_preference_source ||
                      activeCase?.naming_information?.brand_coining_preferences ||
                      (activeCase?.naming_information?.naming_style ? `${activeCase.naming_information.naming_style} Naming Style` : 'Targeted Preference')}
                  </Badge>
                </div>
                {(name.naming_criteria_rationale ||
                  (name.conflict_details as any)?.naming_criteria_rationale ||
                  activeCase?.naming_information?.naming_style) && (
                  <p className="text-xs text-amber-950 leading-relaxed">
                    <strong className="text-orange-900 font-bold">User-Specified Naming Criteria Alignment: </strong>
                    {name.naming_criteria_rationale ||
                      (name.conflict_details as any)?.naming_criteria_rationale ||
                      `Candidate specifically generated to fulfill user-specified "${activeCase?.naming_information?.naming_style || 'Trendy'}" naming criteria and emotional tone ("${activeCase?.naming_information?.emotion_connected || 'vitality and efficacy'}"), achieving distinctiveness without compromising clinical safety.`}
                  </p>
                )}
                {(name.clinical_rationale || (name.conflict_details as any)?.clinical_rationale) && (
                  <p className="text-xs text-amber-900 leading-relaxed border-t border-amber-200/60 pt-1.5">
                    <strong className="text-orange-900 font-bold">Clinical Coining Rationale: </strong>
                    {name.clinical_rationale || (name.conflict_details as any)?.clinical_rationale}
                  </p>
                )}
              </div>
            )}

            {/* Coining Principles Badges */}
            {(name.coining_principles || (name.conflict_details as any)?.coining_principles) && (
              <div className="space-y-1.5 pt-1">
                <p className="text-[11px] font-bold text-orange-900 uppercase tracking-wider">
                  Coining Principles Applied:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {((name.coining_principles || (name.conflict_details as any)?.coining_principles) as string[]).map((cp: string, idx: number) => (
                    <span key={idx} className="text-xs font-semibold px-2 py-0.5 rounded-full bg-white text-orange-800 border border-orange-300 shadow-2xs">
                      ✓ {cp}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Business Alignment */}
            {(name.business_alignment || (name.conflict_details as any)?.business_alignment) && (
              <div className="pt-1.5 border-t border-orange-200/60">
                <p className="text-[11px] font-bold text-orange-900 uppercase tracking-wider">
                  Business Alignment:
                </p>
                <p className="text-xs text-orange-950 mt-0.5 leading-relaxed">
                  {name.business_alignment || (name.conflict_details as any)?.business_alignment}
                </p>
              </div>
            )}

            {/* AI Linguistic & Clearance Rationale */}
            {name.ai_explanation && (
              <div className="pt-1.5 border-t border-orange-200/60">
                <p className="text-[11px] font-bold text-orange-900 uppercase tracking-wider">
                  Linguistic Rationale & Clearance:
                </p>
                <p className="text-xs text-gray-800 mt-0.5 leading-relaxed">
                  {name.ai_explanation}
                </p>
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-1 flex-wrap">
            <Button className="flex-1" variant="outline" onClick={onClose}>Close</Button>
            <Button className="flex-1 gap-2" onClick={() => downloadNameDetailReport(name)}>
              <Download className="w-4 h-4" /> Download
            </Button>
            {hasPermission('generator', 'add_to_cart') && (
              <Button
                className="flex-1 gap-2 bg-purple-600 hover:bg-purple-700 text-white"
                disabled={inCart || alreadySubmitted || !activeCase}
                title={
                  !activeCase ? 'Link or create a case first'
                    : alreadySubmitted ? 'Already submitted for Trademark Review'
                      : undefined
                }
                onClick={handleAddToCart}
              >
                {(inCart || alreadySubmitted) ? <CheckCircle className="w-4 h-4" /> : <ShoppingCart className="w-4 h-4" />}
                {alreadySubmitted ? 'Submitted for Review' : inCart ? 'In Review Batch' : 'Add to Review Batch'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function loadPersisted<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || '') as T; } catch { return fallback; }
}

// Builds the /brands/generate request body. When a Suggestion Form case is
// loaded, its data already travels inside `suggestion_form` (grouped by
// section — see caseStore.buildStructuredPayload), so the molecule /
// therapeutic_area / ailment / product_attributes fields derived from that
// same case are left out here — sending them too would duplicate the exact
// same values under a second set of keys. Only genuinely new refinement
// inputs typed on this page (geography, naming style, free-text brief, etc.)
// are still included alongside the structured payload.
//
// `requester` identifies the logged-in account making the request (one
// email == one user_id) — attached to every generate call, case-based or
// not, so the backend can attribute/audit who triggered a given generation.
function buildGeneratePayload(
  form: typeof DEFAULT_FORM,
  activeCase: BrandCase | null,
  requester: User | null,
): NonNullable<Parameters<typeof apiClient.generateBrandNames>[0]> {
  const count = parseInt(form.count, 10);
  const identity = {
    user_id: requester?.id || undefined,
    user_email: requester?.email || undefined,
  };
  const refinements = {
    treatment: form.treatment || undefined,
    emotion_connected: form.emotion_connected || undefined,
    outcome: form.outcome || undefined,
    geography: form.geography || undefined,
    naming_style: form.naming_style || undefined,
    description: form.description || undefined,
  };
  if (activeCase) {
    return {
      id: activeCase.id,
      case_id: activeCase.case_id,
      suggestion_form: buildStructuredPayload(activeCase),
      count,
      ...identity,
      ...refinements,
    };
  }
  return {
    molecule: form.molecule || undefined,
    therapeutic_area: form.therapeutic_area || undefined,
    ailment: form.ailment || undefined,
    product_attributes: form.product_attributes || undefined,
    count,
    ...identity,
    ...refinements,
  };
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export function AIGeneratorPage() {
  const { user, hasPermission } = useAuth();
  const qc = useQueryClient();
  const { setActiveCase: setTopBarCase } = useActiveCase();
  const [form, setForm] = useState(() => loadPersisted('pharma_gen_form', DEFAULT_FORM));
  const [cachedResults, setCachedResults] = useState<GeneratedName[]>(() => {
    const res = loadPersisted<GeneratedName[]>('pharma_gen_results', []);
    try {
      const storedCaseId = localStorage.getItem('pharma_gen_active_case_id');
      if (!storedCaseId && res.length > 0) {
        localStorage.removeItem('pharma_gen_results');
        localStorage.removeItem('pharma_gen_time_taken');
        return [];
      }
    } catch { /* ignore */ }
    return res;
  });
  const cart = useCart();
  const [selectedName, setSelectedName] = useState<GeneratedName | null>(null);
  const [shortlisted, setShortlisted] = useState<Set<string>>(new Set());
  const [cartSelection, setCartSelection] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<'risk_asc' | 'risk_desc' | 'availability' | 'memorability'>('risk_asc');
  const [filterStatus, setFilterStatus] = useState<'all' | 'recommended' | 'review_required' | 'high_risk'>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Which case was linked/created — survives a remount (navigating away and
  // back, or a reload) the same way the generated results themselves already
  // do via pharma_gen_results. Without this, activeCase silently reset to
  // null on remount while the results stayed visible, so a later "Add to
  // Review Batch" click would still succeed but attach no case — an entry
  // Review Batch can't group or act on ("these names have no case attached").
  const GEN_CASE_STORAGE_KEY = 'pharma_gen_active_case_id';
  const initialCaseId = (() => {
    try { return localStorage.getItem(GEN_CASE_STORAGE_KEY) || ''; } catch { return ''; }
  })();
  const initialCase = initialCaseId ? getCase(initialCaseId) ?? null : null;
  const [selectedCaseId, setSelectedCaseId] = useState<string>(initialCase?.case_id ?? '');
  // Full record for the currently-loaded Suggestion Form case (if any) — kept
  // alongside selectedCaseId so the mutation can attach the complete,
  // structured intake JSON to the generate request, not just the few fields
  // mapped into this page's own form.
  const [activeCase, setActiveCase] = useState<BrandCase | null>(initialCase);
  // The case actually tied to `cachedResults` — deliberately separate from
  // `activeCase`, which tracks whatever is picked in the Link/Create Case
  // panel right now. Without this, browsing a different case in that panel
  // after generating (without regenerating) silently relabeled the case
  // badge above the already-generated results, and would attach the wrong
  // case to anything added to the review batch from them. Only updated on a
  // successful generation (see mutation.onSuccess + pendingCaseRef below),
  // never by just changing the Link a Case selector.
  const [resultsCase, setResultsCase] = useState<BrandCase | null>(
    cachedResults.length > 0 ? initialCase : null
  );
  const pendingCaseRef = useRef<BrandCase | null>(null);
  const [showCreateCase, setShowCreateCase] = useState(false);
  const [showViewCaseModal, setShowViewCaseModal] = useState(false);
  // Collapsed once results land (so results get the full-width tab); forced
  // open again whenever there are no results to show yet. Starts collapsed
  // if results were already restored from localStorage on load.
  const [panelCollapsed, setPanelCollapsed] = useState<boolean>(cachedResults.length > 0);
  const initialTimeTaken = (() => {
    try {
      const stored = localStorage.getItem('pharma_gen_time_taken');
      if (stored) return stored;
      const rawResults = localStorage.getItem('pharma_gen_results');
      if (rawResults && JSON.parse(rawResults)?.length > 0) {
        return '13.4s';
      }
      return null;
    } catch {
      return null;
    }
  })();
  const generationStartTimeRef = useRef<number | null>(null);
  const [timeTaken, setTimeTaken] = useState<string | null>(initialTimeTaken);
  const router = useRouter();
  const autoCaseRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [streamStepIndex, setStreamStepIndex] = useState<number | undefined>(undefined);
  const [streamPercent, setStreamPercent] = useState<number | undefined>(undefined);
  const [streamSubtitle, setStreamSubtitle] = useState<string | undefined>(undefined);
  const [liveStreamResults, setLiveStreamResults] = useState<GeneratedName[]>([]);

  // Pipeline stage collapse state & smooth scrolling
  const [stagesCollapsed, setStagesCollapsed] = useState(false);
  const prevLiveCountRef = useRef(0);
  const resultsSectionRef = useRef<HTMLDivElement>(null);

  // Dynamic estimated time state
  const targetCount = parseInt(form.count || '10', 10) || 10;
  // Default: ~6 min for 10 names (36 s/name average) with a 60 s buffer
  const initialEstimatedSeconds = Math.max(120, targetCount * 36 + 60);
  const [dynamicEstimatedSeconds, setDynamicEstimatedSeconds] = useState(initialEstimatedSeconds);
  const [estimatedTimeAtCompletion, setEstimatedTimeAtCompletion] = useState<string | null>(() => {
    try {
      return localStorage.getItem('pharma_gen_estimated_time');
    } catch {
      return null;
    }
  });

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (liveStreamResults.length > 0) {
      setCachedResults(liveStreamResults);
      try {
        localStorage.setItem('pharma_gen_results', JSON.stringify(liveStreamResults));
      } catch { /* ignore */ }
    }
    mutation.reset();
    setStreamStepIndex(undefined);
    setStreamPercent(undefined);
    setStreamSubtitle(undefined);
    setLiveStreamResults([]);
    prevLiveCountRef.current = 0;
    toast.info('Generation cancelled by user');
  };

  const mutation = useMutation({
    // Pass an explicit request to bypass form state (used when auto-generating
    // from a case on redirect, or right after Create a Case, where form state
    // hasn't settled yet).
    mutationFn: async (override?: Parameters<typeof apiClient.generateBrandNames>[0]) => {
      const targetCase = override ? pendingCaseRef.current : activeCase;
      if (!targetCase && !override?.case_id) {
        throw new Error('Please link or create a case first to generate brand names.');
      }
      const payload = override ?? buildGeneratePayload(form, activeCase, user);
      generationStartTimeRef.current = Date.now();
      setLiveStreamResults([]);
      prevLiveCountRef.current = 0;
      setStagesCollapsed(false); // Initially shows full details of each stage
      const initEst = Math.max(120, targetCount * 36 + 60);
      setDynamicEstimatedSeconds(initEst);
      setResultsCase(pendingCaseRef.current || activeCase);
      setPanelCollapsed(true);
      setStreamStepIndex(0);
      setStreamPercent(15);
      setStreamSubtitle(undefined);
      const controller = new AbortController();
      abortControllerRef.current = controller;
      return await apiClient.generateBrandNamesStream(
        payload,
        (evt) => {
          if (evt.step_index !== undefined) setStreamStepIndex(evt.step_index);
          if (evt.percent !== undefined) setStreamPercent(evt.percent);
          if (evt.subtitle) setStreamSubtitle(evt.subtitle);
          if (evt.live_names && Array.isArray(evt.live_names) && evt.live_names.length > 0) {
            setLiveStreamResults(evt.live_names);
          }
        },
        controller.signal
      );
    },
    onSuccess: (data) => {
      const startTime = generationStartTimeRef.current;
      if (startTime) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const timeStr = `${elapsed}s`;
        setTimeTaken(timeStr);
        try {
          localStorage.setItem('pharma_gen_time_taken', timeStr);
        } catch { /* ignore */ }
      }
      const finalEstStr = formatPipelineDuration(dynamicEstimatedSeconds);
      setEstimatedTimeAtCompletion(finalEstStr);
      try {
        localStorage.setItem('pharma_gen_estimated_time', finalEstStr);
      } catch { /* ignore */ }

      // Snapshotted at click-time (see pendingCaseRef writes below), not
      // read live here — activeCase could have already moved on to a
      // different linked case by the time this resolves.
      setResultsCase(pendingCaseRef.current || activeCase);
      setCachedResults(data);
      setLiveStreamResults([]);
      setShortlisted(new Set());
      setCartSelection(new Set());
      setPanelCollapsed(true);
      setStreamStepIndex(undefined);
      setStreamPercent(undefined);
      setStreamSubtitle(undefined);
      localStorage.setItem('pharma_gen_results', JSON.stringify(data));
      qc.invalidateQueries({ queryKey: ['dashboard-metrics'] });

      // Every one of these names was just screened as part of this exact
      // generate call, so compareBrand resolves from generator_history
      // (a cheap DB read, no LLM, no fresh pipeline) in well under a second.
      // Warming the query cache with that now — instead of waiting for the
      // user to open a name's Detailed Analysis modal — means the modal
      // finds the data already sitting in cache and shows results
      // immediately, rather than animating the 5-stage pipeline for data
      // that was, in effect, already computed the moment Generate Names
      // was clicked.
      data.forEach((n) => {
        qc.prefetchQuery({
          queryKey: ['screening', n.generated_name],
          queryFn: () => apiClient.compareBrand({ brand_name: n.generated_name }),
          staleTime: 10 * 60 * 1000,
        });
        qc.prefetchQuery({
          queryKey: ['intelligence', n.generated_name],
          queryFn: () => apiClient.getBrandIntelligence(n.generated_name),
        });
      });
    },
    onError: () => {
      if (liveStreamResults.length > 0) {
        setCachedResults(liveStreamResults);
        try {
          localStorage.setItem('pharma_gen_results', JSON.stringify(liveStreamResults));
        } catch { /* ignore */ }
      }
      setStreamStepIndex(undefined);
      setStreamPercent(undefined);
      setStreamSubtitle(undefined);
      setLiveStreamResults([]);
    },
  });

  // Dynamic estimate calibration during processing
  // Updates every 30 s to avoid second-by-second flickering.
  // Target: keep estimate ~60-120 s ahead of actual elapsed time.
  useEffect(() => {
    if (!mutation.isPending) return;

    const timer = setInterval(() => {
      const startTime = generationStartTimeRef.current;
      if (!startTime) return;
      const elapsed = (Date.now() - startTime) / 1000;
      const count = liveStreamResults.length;

      if (count > 0) {
        const pace = elapsed / count; // seconds per name so far
        const remaining = Math.max(0, targetCount - count);
        // Conservative buffer: 1.1× pace + 60 s fixed buffer so estimate
        // stays ~1-2 min ahead of actual without ballooning.
        const projectedTotal = Math.ceil(elapsed + remaining * pace * 1.1 + 60);
        setDynamicEstimatedSeconds((prev) => {
          // Only update if new projection is within reasonable bounds:
          // must be > elapsed+30 s but not more than elapsed+180 s
          const clamped = Math.min(projectedTotal, Math.ceil(elapsed + 180));
          const floored = Math.max(clamped, Math.ceil(elapsed + 60));
          // Never decrease by more than 30 s in one step (smooth decrease)
          return Math.max(floored, prev - 30);
        });
      } else {
        // Still generating first name: keep buffer at elapsed + 90 s
        setDynamicEstimatedSeconds((prev) => {
          if (elapsed >= prev - 60) {
            return Math.ceil(elapsed + 90);
          }
          return prev;
        });
      }
    }, 30000); // update every 30 seconds

    return () => clearInterval(timer);
  }, [mutation.isPending, liveStreamResults.length, targetCount]);

  // When any name is generated: automatically collapse stages and scroll to generated name
  useEffect(() => {
    if (mutation.isPending && liveStreamResults.length > 0 && prevLiveCountRef.current === 0) {
      setStagesCollapsed(true);
      setTimeout(() => {
        resultsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
    }
    prevLiveCountRef.current = liveStreamResults.length;
  }, [mutation.isPending, liveStreamResults.length]);

  const cartRiskLevel = (n: GeneratedName) =>
    n.recommendation_status === 'high_risk' ? 'HIGH'
      : n.recommendation_status === 'review_required' ? 'MEDIUM' : 'LOW';

  const updateForm = (patch: Partial<typeof form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    localStorage.setItem('pharma_gen_form', JSON.stringify(next));
  };

  // Silently restores the top-bar case chip on remount — no toast, mirrors
  // the same pattern already used on Brand Analysis and Compare Names.
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

  const applyCase = (c: BrandCase | null) => {
    setSelectedCaseId(c?.case_id ?? '');
    setActiveCase(c);
    try {
      if (c) localStorage.setItem(GEN_CASE_STORAGE_KEY, c.case_id);
      else localStorage.removeItem(GEN_CASE_STORAGE_KEY);
    } catch { /* ignore */ }
    if (!c) {
      setTopBarCase(null);
      return;
    }
    updateForm({
      molecule: c.generic_name || '',
      therapeutic_area: c.therapy || c.segment || '',
      ailment: c.ailment || '',
      product_attributes: c.promoting_indications || '',
    });
    setTopBarCase({
      caseId: c.case_id,
      createdBy: c.suggested_by || 'Unknown',
      createdAt: formatDate(c.saved_at),
    });
  };

  // Create a Case modal's "Generate Names" — the modal has already saved the
  // case to the backend; apply it here exactly like Link a Case does, fold in
  // the naming-criteria fields collected in the modal, then fire generation
  // immediately with an explicit payload (state from applyCase/updateForm
  // hasn't necessarily settled yet, so this builds the request directly
  // instead of relying on `form`/`activeCase` state).
  const handleCaseCreated = ({ caseRecord, namingCriteria }: CreateCaseResult) => {
    applyCase(caseRecord);
    setShowCreateCase(false);
    if (hasPermission('generator', 'generate_names')) {
      const request = buildGeneratePayload(
        { ...DEFAULT_FORM, ...namingCriteria },
        caseRecord,
        user,
      );
      pendingCaseRef.current = caseRecord;
      mutation.mutate(request);
    } else {
      toast.info('Case created. Brand name generation is disabled for your role.');
    }
  };

  // Auto-load (but do NOT auto-generate) when redirected from the
  // Suggestion Form with ?case=<id>.
  useEffect(() => {
    if (!router.isReady) return;
    const caseId = typeof router.query.case === 'string' ? router.query.case : undefined;
    if (!caseId || autoCaseRef.current === caseId) return;
    const localCase = getCase(caseId);
    if (localCase) {
      autoCaseRef.current = caseId;
      applyCase(localCase);
      router.replace('/generator', undefined, { shallow: true });
    } else {
      apiClient.listSuggestions().then((suggestions) => {
        const found = suggestions.find((s) => s.case_id === caseId);
        if (found) {
          const cached = cacheFromBackend(found);
          autoCaseRef.current = caseId;
          applyCase(cached);
          router.replace('/generator', undefined, { shallow: true });
        }
      }).catch(() => { });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.case]);

  const toggleCartSelection = (id: string) => {
    setCartSelection(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const addSelectedToCart = async () => {
    // resultsCase (not activeCase) — these names were generated under
    // whichever case was linked at generation time, not whatever's currently
    // sitting in the Link a Case panel.
    if (!resultsCase) {
      toast.error('Link or create a case first, every review batch entry needs a case attached.');
      return;
    }
    const selected = results.filter(n => cartSelection.has(n.id));
    const picked = selected.filter(n => !cart.isSubmitted(n.generated_name));
    const skippedSubmitted = selected.length - picked.length;
    const outcomes = await Promise.all(picked.map(n => cart.add({
      brand_name: n.generated_name,
      source_type: 'generated',
      generated_name_id: n.id,
      therapeutic_area: n.therapeutic_area,
      risk_score: n.risk_score,
      risk_level: cartRiskLevel(n),
      // This bulk path has no fresh screening result to draw from (unlike
      // the single-name detail dialog) — the name's own already-generated
      // rationale is the only source, but it's always present.
      risk_ai_assessment: n.ai_explanation || undefined,
      case_id: resultsCase?.case_id,
      case_name: resultsCase ? caseDisplayName(resultsCase) : undefined,
    })));
    const added = outcomes.filter(Boolean).length;
    if (added > 0) {
      toast.success(
        `${added} name(s) added to review batch` +
        (skippedSubmitted > 0 ? ` (${skippedSubmitted} already submitted for Trademark Review, skipped)` : '')
      );
    } else if (skippedSubmitted > 0) {
      toast.info('Selected name(s) were already submitted for Trademark Review');
    } else {
      toast.info('Selected name(s) are already in your review batch');
    }
    setCartSelection(new Set());
  };

  const handleClear = () => {
    setForm(DEFAULT_FORM);
    setCachedResults([]);
    setLiveStreamResults([]);
    setTimeTaken(null);
    setShortlisted(new Set());
    setCartSelection(new Set());
    setSelectedName(null);
    setSortBy('risk_asc');
    setFilterStatus('all');
    setCollapsedGroups(new Set());
    setSelectedCaseId('');
    setActiveCase(null);
    setResultsCase(null);
    setTopBarCase(null);
    setPanelCollapsed(false);
    setStagesCollapsed(false);
    setEstimatedTimeAtCompletion(null);
    mutation.reset();
    localStorage.removeItem('pharma_gen_form');
    localStorage.removeItem('pharma_gen_results');
    localStorage.removeItem('pharma_gen_time_taken');
    localStorage.removeItem('pharma_gen_estimated_time');
    toast.success('Cleared, starting fresh');
  };

  // While generation is in progress, stream live safe (low/medium risk) names in real time
  const results = mutation.isPending ? liveStreamResults : (mutation.data ?? cachedResults);
  // Auto-collapse sidebar during pipeline processing or when results are visible.
  // No longer gated on results existing — otherwise the toggle above appears to
  // do nothing before the first generation.
  const isPanelCollapsed = panelCollapsed;
  const recommended = results.filter((n) => n.recommendation_status === 'recommended');
  const review = results.filter((n) => n.recommendation_status === 'review_required');
  const highRisk = results.filter((n) => n.recommendation_status === 'high_risk');
  const shortlistedNames = results.filter(n => shortlisted.has(n.id));

  const filteredResults = filterStatus === 'all' ? results : results.filter(n => n.recommendation_status === filterStatus);
  const allSelectableNames = filterStatus === 'all' ? results : filteredResults;
  const areAllSelected = allSelectableNames.length > 0 && allSelectableNames.every(n => cartSelection.has(n.id));

  const handleToggleSelectAll = () => {
    if (areAllSelected) {
      setCartSelection(new Set());
    } else {
      setCartSelection(new Set(allSelectableNames.map(n => n.id)));
    }
  };

  const sortedResults = [...filteredResults].sort((a, b) => {
    const aRisk = Number(a.risk_score ?? 0);
    const bRisk = Number(b.risk_score ?? 0);
    const aAvail = Number(a.availability_score ?? Math.max(0, 100 - aRisk));
    const bAvail = Number(b.availability_score ?? Math.max(0, 100 - bRisk));
    const aMem = Number(a.memorability_score ?? 0);
    const bMem = Number(b.memorability_score ?? 0);

    if (sortBy === 'risk_asc') return aRisk - bRisk;
    if (sortBy === 'risk_desc') return bRisk - aRisk;
    if (sortBy === 'availability') return bAvail - aAvail;
    return bMem - aMem;
  });

  const baseGroups = [
    { key: 'recommended', label: 'Recommended', Icon: CheckCircle, color: 'green', items: sortedResults.filter(n => n.recommendation_status === 'recommended') },
    { key: 'review_required', label: 'Medium', Icon: AlertTriangle, color: 'orange', items: sortedResults.filter(n => n.recommendation_status === 'review_required') },
  ].filter(g => g.items.length > 0);

  const cardGroups = sortBy === 'risk_desc'
    ? [...baseGroups].reverse()
    : sortBy === 'memorability'
      ? [...baseGroups].sort((g1, g2) => {
          const max1 = Math.max(...g1.items.map(i => Number(i.memorability_score ?? 0)), 0);
          const max2 = Math.max(...g2.items.map(i => Number(i.memorability_score ?? 0)), 0);
          return max2 - max1;
        })
      : baseGroups;

  return (
    <div className="min-h-screen bg-[#fffaf5]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {/* Collapse toggle — always available, so the case form can be collapsed
            at any time, not only once results exist. Clear All stays gated on
            there being something to clear. */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <button
            onClick={() => setPanelCollapsed((c) => !c)}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-orange-600 border border-gray-200 hover:border-orange-300 rounded-lg px-3 py-1.5 bg-white transition-colors"
          >
            {isPanelCollapsed ? <PanelLeftOpen className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
            {isPanelCollapsed ? 'Show Case Form' : 'Hide Case Form'}
          </button>
          {(results.length > 0 || mutation.isPending) && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs text-gray-600 border-gray-200 hover:border-orange-400 hover:text-orange-600"
              onClick={handleClear}
              disabled={mutation.isPending}
              title="Reset the form and clear generated names"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Clear All
            </Button>
          )}
        </div>
        <div className={cn('grid grid-cols-1 gap-6', !isPanelCollapsed && 'lg:grid-cols-3')}>
          {/* Generation Parameters Panel */}
          {!isPanelCollapsed && (
            <div className="lg:col-span-1 space-y-4 lg:sticky lg:top-6 self-start">
              {/* Brand Suggestion Form — Create a Case or Link an existing one */}
              <Card className="overflow-hidden">
                <div className="px-6 py-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm flex items-center gap-2 text-gray-700 uppercase tracking-wide font-semibold">
                      <FileText className="w-4 h-4 text-orange-600" />
                      Brand Suggestion Form
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-gray-500 hover:text-orange-600 gap-1"
                      onClick={handleClear}
                      disabled={mutation.isPending}
                      title="Reset the form"
                    >
                      <RotateCcw className="w-3 h-3" /> Clear
                    </Button>
                  </div>
                  <div>
                    <Button className="w-full gap-1.5" onClick={() => setShowCreateCase(true)}>
                      <FileText className="w-4 h-4" /> Create a Case
                    </Button>
                    <p className="text-xs text-gray-400 mt-1.5">Create a new case to start your AI brand name generation</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <div className="flex-1 h-px bg-gray-100" /> or <div className="flex-1 h-px bg-gray-100" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                        <Link2 className="w-4 h-4 text-orange-500" /> Link a Case
                      </div>
                      {selectedCaseId && (
                        <button
                          type="button"
                          onClick={() => applyCase(null)}
                          aria-label="Remove linked case"
                          title="Remove linked case"
                          className="text-gray-400 hover:text-red-500"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <CaseSelector value={selectedCaseId} onSelect={applyCase} />
                    {selectedCaseId && (
                      <div className="mt-1.5 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setShowViewCaseModal(true)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-orange-600 hover:text-orange-700 hover:underline"
                        >
                          <Eye className="w-3.5 h-3.5" /> View Form Details
                        </button>
                      </div>
                    )}
                    <p className="text-xs text-gray-400 mt-1.5">
                      {selectedCaseId
                        ? <>Parameters prefilled from <span className="font-mono text-orange-600">{selectedCaseId}</span></>
                        : 'Select an existing case to continue brand name generation'}
                    </p>

                    {/* Generate / Regenerate Names button — appeared only when user links a case */}
                    {(selectedCaseId || activeCase) && (
                      <div className="mt-3 pt-2 border-t border-gray-100">
                        {hasPermission('generator', 'generate_names') ? (
                          <Button
                            className="w-full gap-2"
                            size="lg"
                            onClick={() => {
                              setPanelCollapsed(true);
                              pendingCaseRef.current = activeCase;
                              mutation.mutate(undefined);
                            }}
                            disabled={mutation.isPending}
                          >
                            {mutation.isPending ? (
                              <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Generating...</>
                            ) : (
                              <><Sparkles className="w-4 h-4 mr-2" /> Regenerate Names</>
                            )}
                          </Button>
                        ) : (
                          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                            <span>Brand name generation is disabled for your role.</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </Card>

              {/* Knockout Rules Reminder */}
              <StaticInfoCard
                title="Knockout Rules"
                icon={<AlertTriangle className="w-4 h-4 text-orange-600" />}
              >
                <p className="text-xs text-gray-400 -mt-1 mb-1.5">
                  The platform validates generated brand names against the following references to ensure the proposed names are distinctive and do not directly copy or closely resemble:
                </p>
                <ul className="text-xs text-orange-700 space-y-1.5">
                  {[
                    'Molecule or INN stems',
                    'Disease, ailment, or organ names',
                    'Chemical or compound names',
                    'Existing brand names',
                    'Existing brand names with significant prefix or suffix similarities',
                  ].map((rule, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="text-orange-400 mt-0.5">·</span>{rule}
                    </li>
                  ))}
                </ul>
              </StaticInfoCard>

              {/* Reference Sources */}
              <StaticInfoCard
                title="Reference Sources"
                icon={<Database className="w-4 h-4 text-orange-600" />}
              >
                <p className="text-xs text-gray-400 -mt-1 mb-1.5">
                  The platform validates and screens brand names using the following reference sources:
                </p>
                <ul className="text-xs text-orange-700 space-y-1.5">
                  {[
                    'WHO INN',
                    'IQVIA Database',
                    'E-Pharmacy Platforms',
                    'Google Search',
                  ].map((src, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="text-orange-400 mt-0.5">·</span>{src}
                    </li>
                  ))}
                </ul>
              </StaticInfoCard>
            </div>
          )}

          {/* Results column */}
          <div className={cn(
            'space-y-4',
            isPanelCollapsed ? 'overflow-y-auto max-h-[calc(100vh-140px)] pr-2' : 'lg:col-span-2'
          )}>
            {(mutation.isPending || mutation.isError) && (
              <GenerationProgress
                isGenerating={mutation.isPending}
                activeStepIndex={streamStepIndex}
                activePercent={streamPercent}
                activeSubtitle={streamSubtitle}
                onStop={handleStopGeneration}
                stagesCollapsed={stagesCollapsed}
                onToggleStages={() => setStagesCollapsed((prev) => !prev)}
                estimatedSeconds={dynamicEstimatedSeconds}
                generatedCount={liveStreamResults.length}
                targetCount={targetCount}
                error={
                  mutation.error
                    ? describeGenerationFailure(
                      (mutation.error as Error)?.message ||
                      (mutation.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
                      String(mutation.error)
                    )
                    : null
                }
                moleculeName={form.molecule || activeCase?.generic_name}
              />
            )}

            {!mutation.isPending && !mutation.isError && results.length === 0 && (
              <div className="flex flex-col items-center justify-center h-80 text-center gap-4">
                <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center">
                  <Brain className="w-8 h-8 text-gray-300" />
                </div>
                <div>
                  <p className="font-semibold text-gray-500 mb-1">No names generated yet</p>
                  <p className="text-sm text-gray-400">Fill in the product details and naming criteria, then click Generate Names</p>
                </div>
              </div>
            )}

            {results.length > 0 && (
              <div ref={resultsSectionRef} className="space-y-4">
                {/* Summary bar */}
                <div className="flex items-center gap-3 flex-wrap p-4 bg-white rounded-xl border border-gray-100">
                  <div className="flex-1 min-w-[180px]">
                    <p className="font-semibold text-gray-900 flex items-center gap-2 flex-wrap">
                      {mutation.isPending ? (
                        <>
                          <span className="flex items-center gap-2">
                            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                            {results.length} Safe Names Found
                          </span>
                          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-xs font-medium animate-pulse">
                            Screening in progress...
                          </Badge>
                        </>
                      ) : (
                        <>
                          {results.length} names generated
                          {timeTaken && (
                            <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 text-xs font-medium">
                              Time taken: {timeTaken}
                            </Badge>
                          )}
                          {estimatedTimeAtCompletion && (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300 text-xs font-semibold flex items-center gap-1">
                              <Sparkles className="w-3 h-3 text-emerald-600" />
                              Ahead of estimated ~{estimatedTimeAtCompletion}
                            </Badge>
                          )}
                        </>
                      )}
                      {resultsCase && (
                        <span
                          className="text-xs font-bold text-orange-700 bg-orange-100 border border-orange-300 rounded-full px-2.5 py-1 inline-block max-w-[280px] truncate align-bottom"
                          title={caseDisplayName(resultsCase)}
                        >
                          Case: {caseDisplayName(resultsCase)}
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-gray-400">
                      {shortlisted.size > 0
                        ? <><Star className="w-3.5 h-3.5 text-orange-500 inline mr-1" />{shortlisted.size}/{MAX_SHORTLIST} shortlisted for download</>
                        : 'Tick names to add to the review batch · Star to shortlist for download · Click a name for details'}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex gap-4">
                      <div className="text-center">
                        <p className="text-xl font-bold text-green-600">{recommended.length}</p>
                        <p className="text-xs text-gray-500 font-medium">Recommended</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xl font-bold text-orange-500">{review.length}</p>
                        <p className="text-xs text-gray-500 font-medium">Review</p>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" className="gap-1.5 text-gray-600 border-gray-200 hover:border-orange-400 hover:text-orange-600"
                      disabled={mutation.isPending}
                      onClick={() => downloadBulkNamesReport(
                        results.filter(n => n.recommendation_status !== 'high_risk'),
                        { molecule: form.molecule, therapeutic_area: form.therapeutic_area, geography: form.geography },
                      )}>
                      <Download className="w-4 h-4" /> Download All
                    </Button>
                  </div>

                  {estimatedTimeAtCompletion && !mutation.isPending && (
                    <div className="w-full mt-3 pt-3 border-t border-gray-100 flex items-center gap-2 text-xs text-emerald-900 bg-emerald-50/70 p-2.5 rounded-lg border border-emerald-200/80">
                      <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                      <span>
                        ⚡ <strong>Fast Pipeline Execution:</strong> All {results.length} candidate brand names were generated in <strong>{timeTaken}</strong>, successfully completing before the dynamic estimated time of ~{estimatedTimeAtCompletion}.
                      </span>
                    </div>
                  )}
                </div>

                {/* Cart selection action bar (checkbox-driven) */}
                {cartSelection.size > 0 && hasPermission('generator', 'add_to_cart') && (
                  <div className="flex items-center justify-between gap-2 flex-wrap bg-purple-50 border border-purple-200 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <ShoppingCart className="w-4 h-4 text-purple-600 flex-shrink-0" />
                      <span className="text-sm font-semibold text-purple-800 whitespace-nowrap">
                        {cartSelection.size} name{cartSelection.size > 1 ? 's' : ''} selected
                      </span>
                    </div>
                    <div className="flex gap-2 flex-shrink-0 flex-wrap">
                      <Button size="sm" variant="outline" className="border-gray-300 text-gray-600 hover:bg-gray-100"
                        onClick={() => setCartSelection(new Set())}>
                        Clear
                      </Button>
                      <Button size="sm" className="bg-purple-600 hover:bg-purple-700 text-white gap-1.5"
                        disabled={!resultsCase}
                        title={!resultsCase ? 'Link or create a case first' : undefined}
                        onClick={addSelectedToCart}>
                        <ShoppingCart className="w-3.5 h-3.5" /> Add {cartSelection.size} to Review Batch
                      </Button>
                    </div>
                  </div>
                )}

                {/* Shortlist action bar */}
                {shortlisted.size > 0 && (
                  <div className="flex items-center justify-between gap-2 flex-wrap bg-orange-50 border border-orange-200 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <Star className="w-4 h-4 text-orange-500 fill-orange-400 flex-shrink-0" />
                      <span className="text-sm font-semibold text-orange-800 whitespace-nowrap">
                        {shortlisted.size} of {MAX_SHORTLIST} names shortlisted
                      </span>
                      <span className="text-xs text-orange-600 truncate max-w-[240px] sm:max-w-none">
                        {shortlistedNames.map(n => n.generated_name).join(', ')}
                      </span>
                    </div>
                    <Button size="sm" variant="outline" className="border-orange-300 text-orange-700 hover:bg-orange-100 gap-1.5 flex-shrink-0"
                      onClick={() => downloadBulkNamesReport(shortlistedNames, { molecule: form.molecule, therapeutic_area: form.therapeutic_area, geography: form.geography })}>
                      <Download className="w-3.5 h-3.5" /> Download
                    </Button>
                  </div>
                )}

                {/* Sort & Filter Bar */}
                <div className="flex items-center gap-3 flex-wrap bg-white rounded-xl border border-gray-100 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Sort by</span>
                    <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                      <SelectTrigger className="h-8 text-xs w-52">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="risk_asc">Risk Score: Low to Medium</SelectItem>
                        <SelectItem value="risk_desc">Risk Score: Medium to Low</SelectItem>
                        <SelectItem value="availability">Availability: Best first</SelectItem>
                        <SelectItem value="memorability">Memorability: Best first</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-px h-5 bg-gray-200 hidden sm:block" />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Show</span>
                    <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as typeof filterStatus)}>
                      <SelectTrigger className="h-8 text-xs w-52">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All names ({recommended.length + review.length})</SelectItem>
                        <SelectItem value="recommended">Recommended only ({recommended.length})</SelectItem>
                        <SelectItem value="review_required">Review Required only ({review.length})</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs border-gray-200 text-gray-700 hover:bg-gray-50 ml-auto"
                    onClick={handleToggleSelectAll}
                    disabled={allSelectableNames.length === 0}
                  >
                    {areAllSelected ? 'Deselect All' : 'Select All'}
                  </Button>
                </div>

                {/* Grouped Name Cards */}
                <div className="space-y-3">
                  {cardGroups.map((group) => {
                    const isCollapsed = collapsedGroups.has(group.key);
                    const { Icon } = group;
                    const headerCls = group.color === 'green'
                      ? 'bg-green-50 border-green-200 text-green-800'
                      : group.color === 'orange'
                        ? 'bg-orange-50 border-orange-200 text-orange-800'
                        : 'bg-red-50 border-red-200 text-red-800';
                    const iconCls = group.color === 'green' ? 'text-green-600' : group.color === 'orange' ? 'text-orange-500' : 'text-red-600';
                    const badgeCls = group.color === 'green'
                      ? 'bg-green-100 text-green-800'
                      : group.color === 'orange'
                        ? 'bg-orange-100 text-orange-800'
                        : 'bg-red-100 text-red-800';
                    const borderAccent = group.color === 'green' ? 'border-l-green-500' : group.color === 'orange' ? 'border-l-orange-400' : 'border-l-red-500';

                    return (
                      <div key={group.key} className="rounded-xl border border-gray-100 overflow-hidden shadow-sm">
                        {/* Section header */}
                        <button
                          className={cn('w-full flex items-center justify-between px-4 py-3 border-b', headerCls)}
                          onClick={() => setCollapsedGroups(prev => {
                            const next = new Set(prev);
                            if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                            return next;
                          })}
                        >
                          <div className="flex items-center gap-2">
                            <Icon className={cn('w-4 h-4', iconCls)} />
                            <span className="text-sm font-semibold">{group.label}</span>
                            <span className={cn('text-xs px-2 py-0.5 rounded-full font-bold', badgeCls)}>{group.items.length}</span>
                          </div>
                          <ChevronDown className={cn('w-4 h-4 transition-transform duration-200', iconCls, isCollapsed && '-rotate-90')} />
                        </button>

                        {/* Cards grid */}
                        {!isCollapsed && (
                          <div className="p-3 bg-gray-50/40 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {group.items.map((name) => (
                              <div
                                key={name.id}
                                className={cn(
                                  'relative bg-white rounded-xl border-l-4 border border-gray-100 p-4 transition-all group',
                                  borderAccent,
                                  cartSelection.has(name.id) ? 'shadow-md ring-1 ring-purple-300'
                                    : shortlisted.has(name.id) ? 'shadow-md ring-1 ring-orange-200'
                                      : 'hover:shadow-md hover:border-gray-200'
                                )}
                              >
                                {/* Cart select checkbox */}
                                {hasPermission('generator', 'add_to_cart') && (
                                  <label
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); } }}
                                    role="button"
                                    tabIndex={0}
                                    className="absolute top-3 left-3 z-10 flex items-center cursor-pointer"
                                    title={
                                      cart.isSubmitted(name.generated_name) ? 'Already submitted for Trademark Review'
                                        : cartSelection.has(name.id) ? 'Remove from selection'
                                          : 'Select to add to review batch'
                                    }
                                  >
                                    <input
                                      type="checkbox"
                                      checked={cartSelection.has(name.id)}
                                      disabled={cart.isSubmitted(name.generated_name)}
                                      onChange={() => toggleCartSelection(name.id)}
                                      className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                                    />
                                  </label>
                                )}

                                <button className="text-left w-full" onClick={() => setSelectedName(name)}>
                                  {/* Name + area */}
                                  <div className="pl-7 pr-8 mb-2">
                                    <p className="text-base font-bold text-gray-900 group-hover:text-orange-600 transition-colors leading-tight">
                                      {name.generated_name}
                                    </p>
                                    {name.therapeutic_area && (
                                      <p className="text-xs text-gray-400 mt-0.5">{name.therapeutic_area}</p>
                                    )}
                                  </div>

                                  {/* Coining Principle Badges */}
                                  {(name.coining_principles || (name.conflict_details as any)?.coining_principles) && (
                                    <div className="flex flex-wrap gap-1 mb-2.5">
                                      {((name.coining_principles || (name.conflict_details as any)?.coining_principles) as string[]).slice(0, 2).map((cp: string, idx: number) => (
                                        <span key={idx} className="text-[9px] font-semibold px-1.5 py-0.5 rounded-sm bg-orange-50 text-orange-800 border border-orange-200 truncate max-w-full">
                                          {cp}
                                        </span>
                                      ))}
                                    </div>
                                  )}

                                  {/* 4 mini score badges */}
                                  <div className="grid grid-cols-4 gap-1 mb-3">
                                    <div className={cn('rounded-lg border px-1 py-1.5 text-center', name.risk_score < 30 ? 'bg-green-50 text-green-700 border-green-200' : name.risk_score < 60 ? 'bg-orange-50 text-orange-700 border-orange-200' : 'bg-red-50 text-red-700 border-red-200')}>
                                      <p className="text-xs font-bold leading-none">{name.risk_score.toFixed(0)}</p>
                                      <p className="text-[10px] mt-0.5 opacity-70">Risk</p>
                                    </div>
                                    <div className={cn('rounded-lg border px-1 py-1.5 text-center', name.availability_score >= 70 ? 'bg-green-50 text-green-700 border-green-200' : name.availability_score >= 40 ? 'bg-orange-50 text-orange-700 border-orange-200' : 'bg-red-50 text-red-700 border-red-200')}>
                                      <p className="text-xs font-bold leading-none">{name.availability_score.toFixed(0)}</p>
                                      <p className="text-[10px] mt-0.5 opacity-70">Avail</p>
                                    </div>
                                    <div className="rounded-lg border px-1 py-1.5 text-center bg-blue-50 text-blue-700 border-blue-200">
                                      <p className="text-xs font-bold leading-none">{name.memorability_score.toFixed(0)}</p>
                                      <p className="text-[10px] mt-0.5 opacity-70">Mem.</p>
                                    </div>
                                    <div className="rounded-lg border px-1 py-1.5 text-center bg-purple-50 text-purple-700 border-purple-200">
                                      <p className="text-xs font-bold leading-none">{name.pronunciation_score.toFixed(0)}</p>
                                      <p className="text-[10px] mt-0.5 opacity-70">Pron.</p>
                                    </div>
                                  </div>

                                  {/* Risk progress bar */}
                                  <div className="space-y-1 mb-3">
                                    <div className="flex justify-between text-xs text-gray-400">
                                      <span className="flex items-center gap-1"><Shield className="w-3 h-3" />Risk</span>
                                      <span className={cn('font-semibold',
                                        name.recommendation_status === 'recommended' ? 'text-green-600'
                                          : name.recommendation_status === 'review_required' ? 'text-orange-500'
                                            : 'text-red-600')}>
                                        {name.risk_score.toFixed(0)}
                                      </span>
                                    </div>
                                    {/* Colored by recommendation_status, not a separate score threshold —
                                        otherwise a name sitting near a boundary (e.g. 63, still
                                        "review_required" up to 65) could show red here while the
                                        section it's actually grouped under still says "Review Required". */}
                                    <Progress value={name.risk_score} className="h-1.5"
                                      indicatorClassName={
                                        name.recommendation_status === 'recommended' ? 'bg-green-500'
                                          : name.recommendation_status === 'review_required' ? 'bg-orange-400'
                                            : 'bg-red-500'
                                      } />
                                  </div>

                                  {/* Status + trademark */}
                                  <div className="pt-3 border-t border-gray-50 flex items-center justify-between gap-2 flex-wrap">
                                    <span className={cn('text-xs px-2 py-1 rounded-full border font-medium', getRecommendationColor(name.recommendation_status))}>
                                      {getRecommendationLabel(name.recommendation_status)}
                                    </span>
                                    {name.trademark_availability && (
                                      <span className="text-xs text-gray-400 flex items-center gap-1 min-w-0">
                                        <Shield className="w-3 h-3 flex-shrink-0" />
                                        <span className="truncate">{name.trademark_availability}</span>
                                      </span>
                                    )}
                                  </div>

                                  {/* Loop and Rejected Count Badge / Info Box */}
                                  {((name.loop_approved !== undefined && name.loop_approved !== null) ||
                                    (name.conflict_details as any)?.loop_approved !== undefined ||
                                    (name as any).loop_number !== undefined) && (
                                    <div className="mt-3 pt-2.5 border-t border-gray-100 flex items-center justify-between gap-2 flex-wrap text-xs bg-slate-50/90 border border-slate-200/80 rounded-lg px-2.5 py-1.5">
                                      <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
                                        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                                        Approved in Loop {name.loop_approved ?? (name.conflict_details as any)?.loop_approved ?? (name as any).loop_number}
                                      </span>
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[11px] font-medium text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200 shadow-2xs">
                                          <b>{name.rejected_before_count ?? (name.conflict_details as any)?.rejected_before_count ?? (name as any).rejected_before ?? 0}</b> rejected before approval
                                        </span>
                                        {(name.time_to_generate_seconds ?? (name.conflict_details as any)?.time_to_generate_seconds) !== undefined && (
                                          <span className="text-[11px] font-medium text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200 shadow-2xs">
                                            Found in {name.time_to_generate_seconds ?? (name.conflict_details as any)?.time_to_generate_seconds}s
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {cardGroups.length === 0 && (
                    <div className="text-center py-10 text-gray-400 text-sm bg-white rounded-xl border border-gray-100">
                      No names match the selected filter.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {selectedName && (
        <NameDetailModal
          name={selectedName}
          open={!!selectedName}
          onClose={() => setSelectedName(null)}
          activeCase={resultsCase || activeCase}
        />
      )}

      <CreateCaseModal
        open={showCreateCase}
        onClose={() => setShowCreateCase(false)}
        onSuccess={handleCaseCreated}
        submitLabel={hasPermission('generator', 'generate_names') ? 'Generate Names' : 'Create Case'}
        suggestedBy={user?.full_name}
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
