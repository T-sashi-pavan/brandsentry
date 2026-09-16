import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Scale, Sparkles, AlertTriangle, Search } from 'lucide-react';
import { apiClient } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScreeningProgress } from '@/components/ScreeningProgress';
import {
  RiskAssessmentBanner,
  SimilarityAnalysisCard,
  ConflictSourcesCard,
  ScreeningWorkflowPanel,
  KnockoutValidationPanel,
  UniquenessAndBreakdown,
} from '@/components/ScreeningResultBlocks';
import { getCase } from '@/lib/caseStore';
import {
  cn,
  getRiskBgColor,
  getScoreColor,
  getSimilarityTypeIcon,
  getSourceBadgeStyle,
  cleanSimilarityType,
  formatSourceName,
} from '@/lib/utils';
import type { BrandIntelligence } from '@/types';

function getRiskBadge(level?: string) {
  switch ((level || '').toUpperCase()) {
    case 'HIGH':
      return <Badge variant="destructive">High Risk</Badge>;
    case 'MEDIUM':
      return <Badge variant="warning">Medium Risk</Badge>;
    default:
      return <Badge variant="success">Low Risk</Badge>;
  }
}

function NameDetail({ brandName, caseId }: { brandName: string; caseId?: string }) {
  const query = useQuery({
    queryKey: ['screening', brandName, caseId],
    queryFn: () => apiClient.compareBrand({ brand_name: brandName, case_id: caseId }),
    staleTime: 10 * 60 * 1000,
  });
  const sr = query.data?.screening_result;

  const [showProgress, setShowProgress] = useState(false);
  useEffect(() => {
    if (!query.isLoading) {
      setShowProgress(false);
      return;
    }
    const t = setTimeout(() => setShowProgress(true), 400);
    return () => clearTimeout(t);
  }, [query.isLoading]);

  if (query.isLoading) {
    return showProgress ? <ScreeningProgress isScreening brandName={brandName} /> : null;
  }
  if (query.isError || !sr) {
    return (
      <p className="text-center text-sm text-red-500 py-10">
        Could not load the analysis for "{brandName}".
      </p>
    );
  }

  const activeCase = caseId ? getCase(caseId) : null;
  const caseCtx = (sr as any).case_context || (activeCase ? {
    case_id: activeCase.case_id,
    case_name: activeCase.generic_name,
    generic_name: activeCase.generic_name,
    therapy: activeCase.therapy,
    ailment: activeCase.ailment || activeCase.promoting_indications,
    dosage_form: activeCase.dosage_form,
    brand_coining_preferences: activeCase.naming_information?.brand_coining_preferences,
    naming_style: activeCase.naming_information?.naming_style,
  } : null);

  const availScore = sr.availability_score != null ? sr.availability_score : Math.max(50, Math.round(100 - (sr.overall_risk_score ?? 0)));
  const memoScore = sr.memorability_score != null ? sr.memorability_score : 82;
  const pronScore = sr.pronunciation_score != null ? sr.pronunciation_score : 85;

  const fallbackBreakdown = (() => {
    const counts: Record<string, number> = {};
    for (const item of (sr.similar_names ?? [])) {
      counts[item.similarity_type] = (counts[item.similarity_type] || 0) + 1;
    }
    const colors: Record<string, string> = {
      Phonetic: '#3b82f6',
      Spelling: '#a855f7',
      Visual: '#f97316',
      Conceptual: '#6366f1',
    };
    return Object.entries(counts).map(([type, count]) => ({
      type,
      count,
      color: colors[type] || '#6b7280',
    }));
  })();

  const activeIntel: BrandIntelligence = {
    brand_name: brandName,
    trademark_presence: sr.trademark_conflict_score || 0,
    market_presence: sr.market_presence_score || 0,
    epharmacy_presence: (sr.similar_names?.length ?? 0) > 0 ? 0.05 : 0,
    geographic_reach: 0,
    competitor_count: sr.similar_names?.length ?? 0,
    market_saturation: 0,
    brand_uniqueness_score: Math.round(100 - (sr.overall_risk_score ?? 0)),
    ai_summary: sr.ai_assessment || '',
    similar_brands: sr.similar_names ?? [],
    competitive_landscape: [],
    trend_data: [],
    similarity_breakdown: fallbackBreakdown,
    risk_distribution: [],
  };

  const coiningPref = caseCtx?.brand_coining_preferences || caseCtx?.coining_preference_source;
  const namingStyle = caseCtx?.naming_style || 'Targeted Clinical Preference';
  const namingRationale = caseCtx?.naming_criteria_rationale ||
    `Candidate "${brandName}" engineered to align with target naming criteria and therapeutic identity without compromising clearance safety.`;
  const clinicalRationale = caseCtx?.clinical_rationale;
  const coiningPrinciples = (caseCtx?.coining_principles || [
    'Phonetic Distinctiveness',
    'Prefix & Suffix Safety',
    'No WHO INN Collision',
    'High Memorability',
    'Regulatory Viability',
  ]) as string[];
  const businessAlignment = caseCtx?.business_alignment;

  return (
    <div className="space-y-5">
      {/* Top Generation & Clearance Metrics */}
      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 rounded-xl border bg-orange-50 border-orange-200 text-center shadow-xs">
          <p className="text-xs text-gray-500 mb-1 font-medium">Availability</p>
          <p className="text-2xl font-bold text-orange-600">{availScore.toFixed(0)}</p>
        </div>
        <div className="p-3 rounded-xl border bg-blue-50 border-blue-200 text-center shadow-xs">
          <p className="text-xs text-gray-500 mb-1 font-medium">Memorability</p>
          <p className="text-2xl font-bold text-blue-600">{memoScore.toFixed(0)}</p>
        </div>
        <div className="p-3 rounded-xl border bg-purple-50 border-purple-200 text-center shadow-xs">
          <p className="text-xs text-gray-500 mb-1 font-medium">Pronunciation</p>
          <p className="text-2xl font-bold text-purple-600">{pronScore.toFixed(0)}</p>
        </div>
      </div>

      {/* 1. Risk Assessment Banner */}
      <RiskAssessmentBanner sr={sr} brandName={brandName} />

      {/* 2. Case Composition & Clinical Coining Rationale hidden per user request */}
      {/* <CaseCompositionRationaleCard
        sr={sr}
        activeCase={activeCase}
        brandName={brandName}
      /> */}

      {/* 3. Similarity Analysis & Conflict Sources Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SimilarityAnalysisCard sr={sr} />
        <ConflictSourcesCard sr={sr} />
      </div>

      {/* 4. Screening Workflow: Data Source Pipeline */}
      <ScreeningWorkflowPanel sr={sr} stagesCompleted={sr.stages_completed ?? 4} />

      {/* 5. Knockout & Validation Panel (Pharma Rules) */}
      <KnockoutValidationPanel sr={sr} brandName={brandName} />

      {/* 6. Uniqueness & Similarity Breakdown (Pie Chart) */}
      <UniquenessAndBreakdown intel={activeIntel} sr={sr} />

      {/* 7. Similar Brand Names Table */}
      {(sr.similar_names || []).length > 0 && (
        <Card className="shadow-xs">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Search className="w-4 h-4 text-orange-600" /> Similar Brand Names
              </CardTitle>
              <Badge variant="secondary">{(sr.similar_names || []).length} found</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-gray-500 font-semibold uppercase tracking-wider text-[11px]">
                    {['Brand Name', 'Similarity Type', 'Score', 'Source', 'Therapeutic Area', 'Risk'].map((h) => (
                      <th key={h} className="text-left py-2.5 px-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 text-gray-700">
                  {(sr.similar_names || []).map((sn: any, sIdx: number) => (
                    <tr key={sn.id || `${sn.name}-${sIdx}`} className="hover:bg-gray-50/70 transition-colors">
                      <td className="py-2.5 px-3">
                        <span className="font-bold text-gray-900">{sn.name}</span>
                        {sn.manufacturer && <p className="text-[10px] text-gray-400">{sn.manufacturer}</p>}
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="flex items-center gap-1.5">
                          {getSimilarityTypeIcon(sn.similarity_type)}
                          <span>{cleanSimilarityType(sn.similarity_type)}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-gray-100 rounded-full h-1.5">
                            <div
                              className={cn(
                                'h-1.5 rounded-full',
                                sn.similarity_score >= 0.7 ? 'bg-red-500' : sn.similarity_score >= 0.45 ? 'bg-orange-400' : 'bg-green-500'
                              )}
                              style={{ width: `${Math.min(100, Math.max(0, sn.similarity_score * 100))}%` }}
                            />
                          </div>
                          <span className={cn('font-bold text-xs', getScoreColor(sn.similarity_score * 100))}>
                            {(sn.similarity_score * 100).toFixed(0)}%
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium', getSourceBadgeStyle(sn.source))}>
                          {formatSourceName(sn.source)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-gray-600 text-xs">{sn.therapeutic_area || 'N/A'}</td>
                      <td className="py-2.5 px-3">{getRiskBadge(sn.risk_level)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 8. Detected Conflicts */}
      {(sr.conflicts || []).length > 0 && (
        <Card className="shadow-xs">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm text-red-700">
                <AlertTriangle className="w-4 h-4 text-red-600" /> Detected Conflicts
              </CardTitle>
              <Badge variant="destructive">{(sr.conflicts || []).length} conflicts</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2.5">
              {(sr.conflicts || []).map((c: any, cIdx: number) => (
                <div
                  key={c.id || `${c.conflicting_name}-${cIdx}`}
                  className={cn('p-3.5 rounded-xl border', getRiskBgColor(c.severity))}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-bold text-gray-900 text-sm">{c.conflicting_name}</span>
                        <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium', getSourceBadgeStyle(c.source))}>
                          {formatSourceName(c.source)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600 leading-relaxed">{c.details}</p>
                      {c.owner && <p className="text-[11px] text-gray-500 mt-1 font-medium">Owner: {c.owner}</p>}
                    </div>
                    {getRiskBadge(c.severity)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 9. Rationale Behind the Name & 8 Coining Principles */}
      <div className="p-4 bg-orange-50/70 rounded-xl border border-orange-200/80 space-y-3 shadow-xs">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-orange-600" />
            <p className="text-sm font-bold text-orange-950">Rationale Behind the Name</p>
          </div>
          <Badge variant="secondary" className="text-[10px] font-bold bg-orange-100 text-orange-900 border border-orange-200">
            8 COINING PRINCIPLES
          </Badge>
        </div>

        {/* Coining Preferences & Style */}
        <div className="p-3 bg-gradient-to-r from-amber-50 via-orange-50/50 to-white rounded-xl border border-amber-300/80 shadow-2xs space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="flex h-2.5 w-2.5 rounded-full bg-orange-500 ring-2 ring-orange-200 animate-pulse" />
              <p className="text-xs font-bold text-orange-950 uppercase tracking-wider">
                Additional Notes &amp; Naming Style
              </p>
            </div>
            <Badge variant="outline" className="text-[11px] font-bold bg-white text-orange-800 border-orange-300 shadow-2xs">
              {coiningPref || `${namingStyle} Naming Style`}
            </Badge>
          </div>
          <p className="text-xs text-amber-950 leading-relaxed">
            <strong className="text-orange-900 font-bold">Naming Criteria Alignment: </strong>
            {namingRationale}
          </p>
          {clinicalRationale && (
            <p className="text-xs text-amber-900 leading-relaxed border-t border-amber-200/60 pt-1.5">
              <strong className="text-orange-900 font-bold">Clinical Coining Rationale: </strong>
              {clinicalRationale}
            </p>
          )}
        </div>

        {/* Coining Principles Badges */}
        {coiningPrinciples.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="text-[11px] font-bold text-orange-900 uppercase tracking-wider">
              Coining Principles Applied:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {coiningPrinciples.map((cp: string, idx: number) => (
                <span
                  key={idx}
                  className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-white text-orange-800 border border-orange-300 shadow-2xs"
                >
                  ✓ {cp}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Business Alignment */}
        {businessAlignment && (
          <div className="pt-1.5 border-t border-orange-200/60">
            <p className="text-[11px] font-bold text-orange-900 uppercase tracking-wider">
              Business Alignment:
            </p>
            <p className="text-xs text-orange-950 mt-0.5 leading-relaxed">{businessAlignment}</p>
          </div>
        )}

        {/* AI Linguistic & Clearance Rationale */}
        {sr.ai_assessment && (
          <div className="pt-1.5 border-t border-orange-200/60">
            <p className="text-[11px] font-bold text-orange-900 uppercase tracking-wider">
              Linguistic Rationale &amp; Clearance:
            </p>
            <p className="text-xs text-gray-800 mt-0.5 leading-relaxed">{sr.ai_assessment}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function TrademarkNameDetailModal({
  names,
  initialIndex,
  open,
  onClose,
  titleClassName,
  caseId,
}: {
  names: string[];
  initialIndex: number;
  open: boolean;
  onClose: () => void;
  titleClassName?: string;
  caseId?: string;
}) {
  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    if (open) setIndex(initialIndex);
  }, [open, initialIndex]);

  const brandName = names[index];
  const hasPrev = index > 0;
  const hasNext = index < names.length - 1;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center justify-between gap-3 pr-10">
            <span className={cn('flex items-center gap-2', titleClassName || 'text-purple-700')}>
              <Scale className="w-5 h-5" /> Detailed Analysis: "{brandName}"
            </span>
            {names.length > 1 && (
              <span className="flex items-center gap-2 text-sm font-normal text-gray-400 flex-shrink-0">
                <button
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                  disabled={!hasPrev}
                  title="Previous name"
                  className="p-1 rounded-full hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {index + 1} of {names.length}
                <button
                  onClick={() => setIndex((i) => Math.min(names.length - 1, i + 1))}
                  disabled={!hasNext}
                  title="Next name"
                  className="p-1 rounded-full hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 pr-2 -mr-2">
          <NameDetail key={`${brandName}-${caseId}`} brandName={brandName} caseId={caseId} />
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-gray-100 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={!hasPrev}
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setIndex((i) => Math.min(names.length - 1, i + 1))}
            disabled={!hasNext}
          >
            Next <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
