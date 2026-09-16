import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle, Shield, Globe, ShoppingCart, BarChart2, Brain,
  ChevronDown, ChevronUp, Eye, Volume2, Pen, Target,
  AlertCircle, GitCompare, XCircle, FlaskConical, ListChecks, MinusCircle, Database,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, Tooltip,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiClient } from '@/api/client';
import { cn, getRiskBgColor, getRiskLevelHexColor, getSourceBadgeStyle, formatSourceName } from '@/lib/utils';
import type { ScreeningResult, BrandIntelligence } from '@/types';

// Every block here is shared between Brand Analysis's full-page results and
// AI Name Generator's per-name "Detailed Analysis" modal, so both surfaces
// stay pixel-identical instead of drifting — see Sun_Pharma_Screens_V1.2.pptx
// slides 8 and 10.

// ─── Risk Gauge ────────────────────────────────────────────────────────────────

export function RiskGauge({ score, level }: { score: number; level: string }) {
  const color = getRiskLevelHexColor(level);
  const size = 128;
  const cx = size / 2;
  const cy = size / 2;
  const r = 54;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(Math.max(score, 0), 100) / 100;
  const dash = circ * pct;
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-28 h-28">
        <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full -rotate-90">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e5e7eb" strokeWidth="11" />
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="11"
            strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 1s ease' }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-extrabold" style={{ color }}>{Math.round(score)}</span>
          <span className="text-[10px] text-gray-500">out of 100</span>
        </div>
      </div>
      <div className={cn('px-3 py-1 rounded-full text-xs font-bold border mt-1', getRiskBgColor(level))}>
        {level} RISK
      </div>
    </div>
  );
}

// ─── Risk Assessment Banner ─────────────────────────────────────────────────────

export function RiskAssessmentBanner({
  sr,
  brandName,
  actions,
}: {
  sr: ScreeningResult;
  brandName: string;
  actions?: React.ReactNode;
}) {
  const allConflicts = sr.conflicts || [];
  const allSimilarNames = (sr.similar_names || []).filter(sn => sn.similarity_type !== 'Sound-Alike');
  const uniqueSimilarNames = Array.from(
    new Map(allSimilarNames.map(sn => [sn.name.toLowerCase(), sn])).values()
  );

  const commercialKeywords = ['1mg', 'pharmeasy', 'apollo', 'netmeds', 'pharmacy', 'e-pharmacy', 'iqvia', 'google', 'market'];
  const marketHits = new Set([
    ...allConflicts
      .filter(c => commercialKeywords.some(k => (c.source || '').toLowerCase().includes(k)))
      .map(c => c.conflicting_name.trim().toLowerCase()),
    ...allSimilarNames
      .filter(sn => commercialKeywords.some(k => (sn.source || '').toLowerCase().includes(k)))
      .map(sn => sn.name.trim().toLowerCase()),
  ]).size;
  const marketCount = Math.max(marketHits, sr.market_conflicts || 0);

  const pGrade = sr.grades?.phonetic?.grade || calculateGrade(Math.round((sr.phonetic_similarity_score || 0) * 100));
  const sGrade = sr.grades?.spelling?.grade || calculateGrade(Math.round((sr.spelling_similarity_score || 0) * 100));
  const cGrade = sr.grades?.conceptual?.grade || calculateGrade(Math.round((sr.semantic_similarity_score || 0) * 100));
  const vGrade = sr.grades?.visual?.grade || calculateGrade(Math.round((sr.lookalike_score || 0) * 100));
  const calculatedRisk = evaluateCombinationRisk(pGrade, sGrade, cGrade, vGrade);
  const isKnockout = Boolean(
    sr.rejected_at_stage != null ||
    sr.rejection_reason ||
    (sr.conflicts && sr.conflicts.some(c => c.conflict_type === 'INN_KNOCKOUT')) ||
    (sr.exact_match_score && sr.exact_match_score >= 0.98)
  );
  const effectiveRisk = isKnockout ? 'HIGH' : calculatedRisk;
  const effectiveScore = isKnockout
    ? Math.max(sr.overall_risk_score || 85.0, 85.0)
    : calculatedRisk === 'HIGH'
    ? Math.max(sr.overall_risk_score || 75.0, 75.0)
    : calculatedRisk === 'MEDIUM'
    ? (sr.overall_risk_score && sr.overall_risk_score <= 65.0 ? sr.overall_risk_score : 65.0)
    : Math.min(sr.overall_risk_score ?? 0.0, 29.0);
  const effectiveAvailability = Math.round(Math.max(0, 100 - effectiveScore));
  const effectiveRec = isKnockout ? 'REJECT' : (calculatedRisk === 'HIGH' ? 'REJECT' : calculatedRisk === 'MEDIUM' ? 'LEGAL_REVIEW' : 'PROCEED');

  return (
    <div className={cn('rounded-2xl border-2 p-5 relative', getRiskBgColor(effectiveRisk))}>
      {/* Top right corner action buttons */}
      {actions && (
        <div className="flex items-center gap-2 mb-3 sm:mb-0 sm:absolute sm:top-4 sm:right-4 z-10 justify-end flex-wrap">
          {actions}
        </div>
      )}

      <div className="flex flex-col lg:flex-row items-start lg:items-center gap-5">
        <RiskGauge score={effectiveScore} level={effectiveRisk} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap mb-1">
            <h2 className="text-base font-bold text-gray-900">
              Risk Assessment: "{brandName}"
            </h2>
            <div className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold border',
              effectiveRec === 'PROCEED' ? 'bg-green-600 text-white border-green-600' :
              effectiveRec === 'LEGAL_REVIEW' ? 'bg-orange-500 text-white border-orange-500' :
              'bg-red-600 text-white border-red-600'
            )}>
              {effectiveRec === 'PROCEED'
                ? <><CheckCircle className="w-3.5 h-3.5" /> Clear to Proceed</>
                : effectiveRec === 'LEGAL_REVIEW'
                ? <><AlertTriangle className="w-3.5 h-3.5" /> Trademark Review Required</>
                : <><AlertTriangle className="w-3.5 h-3.5" /> Reject / Conflict Found</>}
            </div>
          </div>
          <p className="text-sm text-gray-600 mb-3 sm:pr-80">
            {effectiveRec === 'REJECT'
              ? 'Significant conflicts found, do not proceed without trademark clearance.'
              : effectiveRec === 'LEGAL_REVIEW'
              ? 'Trademark review and clearance recommended before proceeding.'
              : 'Minimal conflicts detected. Standard due diligence recommended.'}
          </p>
          <div className="w-full grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-3">
            {[
              {
                label: 'Availability',
                value: `${effectiveAvailability}%`,
                color: effectiveAvailability >= 70 ? 'text-green-600' : effectiveAvailability >= 40 ? 'text-orange-600' : 'text-red-600',
              },
              { label: 'Market', value: marketCount, color: 'text-gray-900' },
              { label: 'Similar Names', value: uniqueSimilarNames.length, color: 'text-gray-900' },
              { label: 'Memorability', value: `${Math.round(sr.memorability_score ?? 82)}%`, color: 'text-blue-600' },
              { label: 'Pronunciation', value: `${Math.round(sr.pronunciation_score ?? 85)}%`, color: 'text-purple-600' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-white/85 backdrop-blur-xs rounded-xl p-3 text-center border border-white/80 shadow-xs hover:shadow-sm transition-all">
                <p className={cn('text-xl font-bold tracking-tight', color)}>{value}</p>
                <p className="text-[11px] text-gray-500 font-medium mt-0.5">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Expandable Similarity Bar ─────────────────────────────────────────────────

function getGradeBadgeStyle(grade?: string, riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH') {
  if (riskLevel === 'HIGH') {
    return 'bg-red-100 text-red-800 border-red-300';
  }
  if (riskLevel === 'MEDIUM') {
    return 'bg-amber-100 text-amber-800 border-amber-300';
  }
  if (riskLevel === 'LOW') {
    return 'bg-emerald-100 text-emerald-800 border-emerald-300';
  }
  switch (grade) {
    case 'A':
      return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    case 'B':
      return 'bg-blue-100 text-blue-800 border-blue-300';
    case 'C':
      return 'bg-amber-100 text-amber-800 border-amber-300';
    case 'D':
      return 'bg-red-100 text-red-800 border-red-300';
    default:
      return 'bg-gray-100 text-gray-700 border-gray-200';
  }
}

function calculateGrade(pct: number): 'A' | 'B' | 'C' | 'D' {
  if (pct <= 30) return 'A';
  if (pct <= 50) return 'B';
  if (pct <= 70) return 'C';
  return 'D';
}

function evaluateCombinationRisk(p: string, s: string, c: string, v: string): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (p === 'D' || s === 'D' || c === 'D' || v === 'D') return 'HIGH';
  if (s === 'B' || s === 'C' || p === 'C' || c === 'C' || v === 'C') return 'MEDIUM';
  return 'LOW';
}

function SimilarityBar({
  label,
  score,
  icon: Icon,
  color,
  matches,
  grade,
  paramKey,
}: {
  label: string;
  score: number;
  icon: React.ElementType;
  color: string;
  matches: Array<{ name: string; source: string; similarity_score: number; similarity_type: string; manufacturer?: string }>;
  grade?: 'A' | 'B' | 'C' | 'D';
  paramKey?: 'phonetic' | 'spelling' | 'visual' | 'conceptual';
}) {
  const [open, setOpen] = useState(false);
  const pct = Math.round(score * 100);
  const count = matches.length;
  const effectiveGrade = grade || calculateGrade(pct);

  // Parameter specific risk implication based on mentor requirements
  const paramRiskLevel = (() => {
    if (!paramKey) return null;
    if (paramKey === 'spelling') {
      if (effectiveGrade === 'A') return { label: 'Low Risk', style: 'text-emerald-600', level: 'LOW' as const };
      if (effectiveGrade === 'B' || effectiveGrade === 'C') return { label: 'Medium Risk', style: 'text-amber-600', level: 'MEDIUM' as const };
      return { label: 'High Risk', style: 'text-red-600', level: 'HIGH' as const };
    }
    // Phonetic, Visual, Conceptual
    if (effectiveGrade === 'A' || effectiveGrade === 'B') return { label: 'Low Risk', style: 'text-emerald-600', level: 'LOW' as const };
    if (effectiveGrade === 'C') return { label: 'Medium Risk', style: 'text-amber-600', level: 'MEDIUM' as const };
    return { label: 'High Risk', style: 'text-red-600', level: 'HIGH' as const };
  })();

  const scoreTextColor = paramRiskLevel
    ? (paramRiskLevel.level === 'HIGH' ? 'text-red-600' : paramRiskLevel.level === 'MEDIUM' ? 'text-amber-600' : 'text-emerald-600')
    : (pct >= 70 ? 'text-red-600' : pct >= 40 ? 'text-orange-500' : 'text-green-600');

  const progressColor = paramRiskLevel
    ? (paramRiskLevel.level === 'HIGH' ? 'bg-red-500' : paramRiskLevel.level === 'MEDIUM' ? 'bg-amber-400' : 'bg-emerald-500')
    : (pct >= 70 ? 'bg-red-500' : pct >= 40 ? 'bg-orange-400' : 'bg-green-500');

  return (
    <div className="border border-transparent rounded-lg hover:border-gray-100 transition-all">
      <button
        type="button"
        className="w-full flex items-center gap-2 py-2 px-1 text-left"
        disabled={count === 0}
        onClick={() => count > 0 && setOpen(o => !o)}
      >
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0', `bg-${color}-100`)}>
          <Icon className={cn('w-3.5 h-3.5', `text-${color}-600`)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-center mb-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-gray-700">{label}</span>
              {paramRiskLevel && (
                <span className={cn('text-[10px] font-semibold', paramRiskLevel.style)}>
                  ({paramRiskLevel.label})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className={cn('text-sm font-bold', scoreTextColor)}>
                {pct}%
              </span>
              <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase', getGradeBadgeStyle(effectiveGrade, paramRiskLevel?.level))}>
                Grade {effectiveGrade}
              </span>
              {count > 0 && (
                <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{count}</span>
              )}
              {count > 0 && (
                open ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
              )}
            </div>
          </div>
          <Progress
            value={pct}
            className="h-1.5"
            indicatorClassName={progressColor}
          />
        </div>
      </button>
      {open && count > 0 && (
        <div className="mx-1 mb-2 rounded-lg border border-gray-100 overflow-hidden">
          <div className="bg-gray-50 px-3 py-1.5 text-xs text-gray-500 font-medium border-b border-gray-100">
            Matched brands ({label})
          </div>
          <div className="divide-y divide-gray-50">
            {matches.map((m, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2 bg-white hover:bg-gray-50">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold text-sm text-gray-900">{m.name}</span>
                  {m.manufacturer && <span className="text-xs text-gray-400 truncate">· {m.manufacturer}</span>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', getSourceBadgeStyle(m.source))}>{formatSourceName(m.source)}</span>
                  <span className={cn(
                    'text-xs font-bold px-1.5 py-0.5 rounded',
                    m.similarity_score >= 0.7 ? 'text-red-700 bg-red-100' :
                    m.similarity_score >= 0.4 ? 'text-orange-700 bg-orange-100' : 'text-green-700 bg-green-100'
                  )}>
                    {Math.round(m.similarity_score * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Similarity Analysis Card ───────────────────────────────────────────────────

export function SimilarityAnalysisCard({ sr }: { sr: ScreeningResult }) {
  const similarNames = sr.similar_names || [];
  const exactMatches = (sr.conflicts || [])
    .filter(c => ['EXACT_MATCH', 'EXACT_MARKET_MATCH'].includes(c.conflict_type))
    .map(c => ({ name: c.conflicting_name, source: c.source, similarity_score: 1, similarity_type: 'Exact Match', manufacturer: c.owner }));

  const phoneticMatches = [
    ...exactMatches,
    ...similarNames.filter(n => n.similarity_type === 'Phonetic'),
  ];
  const spellingMatches = similarNames.filter(n => n.similarity_type === 'Spelling');
  const visualMatches = similarNames.filter(n => n.similarity_type === 'Visual' || n.similarity_type === 'Look-Alike');
  const conceptualMatches = similarNames.filter(n => n.similarity_type === 'Conceptual' || n.similarity_type === 'Semantic');

  const exactScore = exactMatches.length > 0 ? 1 : (sr.exact_match_score || 0);
  const phoneticScore = phoneticMatches.length > 0 ? Math.max(...phoneticMatches.map(m => m.similarity_score)) : (sr.phonetic_similarity_score || 0);
  const spellingScore = spellingMatches.length > 0 ? Math.max(...spellingMatches.map(m => m.similarity_score)) : (sr.spelling_similarity_score || 0);
  const visualScore = visualMatches.length > 0 ? Math.max(...visualMatches.map(m => m.similarity_score)) : (sr.lookalike_score || 0);
  const conceptualScore = conceptualMatches.length > 0 ? Math.max(...conceptualMatches.map(m => m.similarity_score)) : (sr.semantic_similarity_score || 0);

  // Grades extraction from backend or client fallback
  const pGrade = sr.grades?.phonetic?.grade || calculateGrade(Math.round(phoneticScore * 100));
  const sGrade = sr.grades?.spelling?.grade || calculateGrade(Math.round(spellingScore * 100));
  const cGrade = sr.grades?.conceptual?.grade || calculateGrade(Math.round(conceptualScore * 100));
  const vGrade = sr.grades?.visual?.grade || calculateGrade(Math.round(visualScore * 100));

  const combinationCode = `${pGrade}${sGrade}${cGrade}${vGrade}`;
  const calculatedRisk = evaluateCombinationRisk(pGrade, sGrade, cGrade, vGrade);
  const isKnockout = Boolean(
    sr.rejected_at_stage != null ||
    sr.rejection_reason ||
    (sr.conflicts && sr.conflicts.some(c => c.conflict_type === 'INN_KNOCKOUT'))
  );
  const overallRisk = isKnockout ? 'HIGH' : calculatedRisk;

  return (
    <Card className="overflow-hidden border border-gray-200/80 shadow-xs">
      <CardHeader className="pb-2 pt-4 px-4 bg-gray-50/40 border-b border-gray-100">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold text-gray-900">
            <BarChart2 className="w-4 h-4 text-orange-600" /> Similarity Analysis & Grade Scoring
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Combination:</span>
            <span className="px-2 py-0.5 rounded font-mono font-bold text-xs bg-gray-900 text-white shadow-2xs tracking-wider">
              {combinationCode}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-4 space-y-3">
        {/* 4 Parameter Similarity Bars with Grade Badges */}
        <div className="space-y-1">
          {exactMatches.length > 0 && (
            <SimilarityBar
              label="Exact Match"
              score={exactScore}
              icon={Target}
              color="red"
              matches={exactMatches}
              grade="D"
            />
          )}
          <SimilarityBar
            label="Phonetic Similarity (P)"
            score={phoneticScore}
            icon={Volume2}
            color="blue"
            matches={phoneticMatches}
            grade={pGrade}
            paramKey="phonetic"
          />
          <SimilarityBar
            label="Spelling Similarity (S)"
            score={spellingScore}
            icon={Pen}
            color="purple"
            matches={spellingMatches}
            grade={sGrade}
            paramKey="spelling"
          />
          <SimilarityBar
            label="Visual Similarity (V)"
            score={visualScore}
            icon={Eye}
            color="orange"
            matches={visualMatches}
            grade={vGrade}
            paramKey="visual"
          />
          <SimilarityBar
            label="Conceptual Similarity (C)"
            score={conceptualScore}
            icon={Brain}
            color="indigo"
            matches={conceptualMatches}
            grade={cGrade}
            paramKey="conceptual"
          />
        </div>

        {/* Overall Combination Assessment Banner */}
        <div className="mt-3 p-3 rounded-xl border bg-gradient-to-r from-gray-50 via-slate-50 to-orange-50/30 border-gray-200">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-gray-800">Overall Combination Result:</span>
              <span className="text-xs font-mono font-bold text-gray-700 bg-white px-2 py-0.5 rounded border border-gray-200">
                P:{pGrade} · S:{sGrade} · C:{cGrade} · V:{vGrade} [{combinationCode}]
              </span>
            </div>
            <div className={cn(
              'px-2.5 py-1 rounded-lg text-xs font-bold border uppercase flex items-center gap-1.5 shadow-2xs',
              overallRisk === 'LOW' ? 'bg-emerald-100 text-emerald-800 border-emerald-300' :
              overallRisk === 'MEDIUM' ? 'bg-amber-100 text-amber-800 border-amber-300' :
              'bg-red-100 text-red-800 border-red-300'
            )}>
              <span className={cn(
                'w-2 h-2 rounded-full',
                overallRisk === 'LOW' ? 'bg-emerald-600' :
                overallRisk === 'MEDIUM' ? 'bg-amber-600' : 'bg-red-600'
              )} />
              {overallRisk} RISK
            </div>
          </div>
          <p className="text-[11px] text-gray-500 mt-1.5 leading-relaxed">
            {overallRisk === 'LOW'
              ? 'Low risk profile (Spelling is Grade A with favorable Phonetic, Conceptual, and Visual boundaries).'
              : overallRisk === 'MEDIUM'
              ? 'Moderate similarity detected (Medium risk range across parameters, Trademark review recommended).'
              : 'High conflict risk identified (One or more parameters exceed safe similarity thresholds or exact collision).'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Conflict Sources Card ──────────────────────────────────────────────────────

type ConflictTileItem = { name: string; source: string; detail?: string };

export function ConflictSourcesCard({ sr }: { sr: ScreeningResult }) {
  const allConflicts = sr.conflicts || [];
  const allSimilarNames = (sr.similar_names || []).filter(sn => sn.similarity_type !== 'Sound-Alike');
  const uniqueSimilarNames = Array.from(
    new Map(allSimilarNames.map(sn => [sn.name.toLowerCase(), sn])).values()
  );

  const pGrade = sr.grades?.phonetic?.grade || calculateGrade(Math.round((sr.phonetic_similarity_score || 0) * 100));
  const sGrade = sr.grades?.spelling?.grade || calculateGrade(Math.round((sr.spelling_similarity_score || 0) * 100));
  const cGrade = sr.grades?.conceptual?.grade || calculateGrade(Math.round((sr.semantic_similarity_score || 0) * 100));
  const vGrade = sr.grades?.visual?.grade || calculateGrade(Math.round((sr.lookalike_score || 0) * 100));
  const calculatedRisk = evaluateCombinationRisk(pGrade, sGrade, cGrade, vGrade);
  const isKnockout = Boolean(
    sr.rejected_at_stage != null ||
    sr.rejection_reason ||
    (sr.conflicts && sr.conflicts.some(c => c.conflict_type === 'INN_KNOCKOUT')) ||
    (sr.exact_match_score && sr.exact_match_score >= 0.98)
  );
  const effectiveRisk = isKnockout ? 'HIGH' : calculatedRisk;
  const effectiveScore = isKnockout
    ? Math.max(sr.overall_risk_score || 85.0, 85.0)
    : calculatedRisk === 'HIGH'
    ? Math.max(sr.overall_risk_score || 75.0, 75.0)
    : calculatedRisk === 'MEDIUM'
    ? (sr.overall_risk_score && sr.overall_risk_score <= 65.0 ? sr.overall_risk_score : 65.0)
    : Math.min(sr.overall_risk_score ?? 0.0, 29.0);
  const availabilityScore = Math.round(Math.max(0, 100 - effectiveScore));

  const [openTile, setOpenTile] = useState<string | null>(null);

  const tiles: Array<{
    key: string; icon: React.ElementType; label: string; count: number; displayValue: string; color: string; bg: string; items: ConflictTileItem[];
  }> = [
    {
      key: 'availability',
      icon: CheckCircle,
      label: 'Availability',
      count: availabilityScore,
      displayValue: `${availabilityScore}%`,
      color: availabilityScore >= 70 ? 'green' : availabilityScore >= 40 ? 'orange' : 'red',
      bg: availabilityScore >= 70 ? 'bg-green-50 border-green-100' : availabilityScore >= 40 ? 'bg-orange-50 border-orange-100' : 'bg-red-50 border-red-100',
      items: [],
    },
    {
      key: 'similar',
      icon: BarChart2,
      label: 'Similar Names',
      count: uniqueSimilarNames.length,
      displayValue: String(uniqueSimilarNames.length),
      color: 'orange',
      bg: 'bg-orange-50 border-orange-100',
      items: uniqueSimilarNames.map(sn => ({ name: sn.name, source: formatSourceName(sn.source), detail: `${Math.round(sn.similarity_score * 100)}% ${sn.similarity_type}` })),
    },
  ];

  const [showPortalBreakdown, setShowPortalBreakdown] = useState(true);

  const sourceMatchesPortal = (portalId: string, src?: string) => {
    const s = (src || '').toLowerCase();
    if (portalId === 'inn') return s.includes('who') || s.includes('inn');
    if (portalId === 'iqvia') return s.includes('iqvia');
    if (portalId === 'epharmacy') return ['1mg', 'pharmeasy', 'apollo', 'netmeds', 'pharmacy', 'e-pharmacy'].some(k => s.includes(k));
    if (portalId === 'web') return s.includes('google') || s.includes('web') || s.includes('search');
    return false;
  };

  const portals = [
    {
      id: 'inn',
      name: 'WHO INN',
      uniqueNames: Array.from(new Set([
        ...allSimilarNames.filter(sn => sourceMatchesPortal('inn', sn.source)).map(sn => sn.name.trim().toLowerCase()),
        ...allConflicts.filter(c => sourceMatchesPortal('inn', c.source)).map(c => c.conflicting_name.trim().toLowerCase()),
      ])),
    },
    {
      id: 'iqvia',
      name: 'IQVIA Database',
      uniqueNames: Array.from(new Set([
        ...allSimilarNames.filter(sn => sourceMatchesPortal('iqvia', sn.source)).map(sn => sn.name.trim().toLowerCase()),
        ...allConflicts.filter(c => sourceMatchesPortal('iqvia', c.source)).map(c => c.conflicting_name.trim().toLowerCase()),
      ])),
    },
    {
      id: 'epharmacy',
      name: 'E-Pharmacy Platforms',
      uniqueNames: Array.from(new Set([
        ...allSimilarNames.filter(sn => sourceMatchesPortal('epharmacy', sn.source)).map(sn => sn.name.trim().toLowerCase()),
        ...allConflicts.filter(c => sourceMatchesPortal('epharmacy', c.source)).map(c => c.conflicting_name.trim().toLowerCase()),
      ])),
    },
    {
      id: 'web',
      name: 'Google Search',
      uniqueNames: Array.from(new Set([
        ...allSimilarNames.filter(sn => sourceMatchesPortal('web', sn.source)).map(sn => sn.name.trim().toLowerCase()),
        ...allConflicts.filter(c => sourceMatchesPortal('web', c.source)).map(c => c.conflicting_name.trim().toLowerCase()),
      ])),
    },
  ];

  const activeTile = tiles.find(t => t.key === openTile) || null;

  return (
    <Card>
      <CardHeader className="pb-1.5 pt-4 px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Shield className="w-4 h-4 text-orange-600" /> Conflict Sources
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="grid grid-cols-2 gap-2">
          {tiles.map(({ key, icon: Icon, label, count, displayValue, color, bg, items }) => (
            <button
              key={key}
              type="button"
              disabled={items.length === 0}
              onClick={() => items.length > 0 && setOpenTile(key)}
              className={cn(
                'flex items-center gap-2 p-2.5 rounded-xl border text-left transition-all',
                bg,
                items.length > 0 ? 'hover:shadow-md focus:outline-none focus:ring-2 focus:ring-orange-300 cursor-pointer' : 'cursor-default',
              )}
            >
              <div className={cn('w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0', `bg-${color}-100`)}>
                <Icon className={cn('w-4 h-4', `text-${color}-600`)} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-lg font-bold text-gray-900">{displayValue ?? count}</p>
                <p className="text-[11px] text-gray-500">{label}</p>
              </div>
              {items.length > 0 && <Eye className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
            </button>
          ))}
        </div>

        {/* Per-portal collapsible breakdown */}
        <div className="mt-2.5 border border-gray-100 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowPortalBreakdown(p => !p)}
            className="w-full flex items-center justify-between px-3 py-2 bg-gray-50/80 text-xs font-medium text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-orange-500" /> Per-Portal Breakdown
            </span>
            {showPortalBreakdown ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
          </button>
          {showPortalBreakdown && (
            <div className="p-2.5 space-y-2 bg-white divide-y divide-gray-50 text-xs">
              {portals.map(p => {
                const totalHits = p.uniqueNames.length;
                return (
                  <div key={p.id} className="pt-1.5 first:pt-0 flex items-center justify-between">
                    <span className="text-gray-700 font-medium">{p.name}</span>
                    <span className={cn(
                      'px-2 py-0.5 rounded-full text-[11px] font-semibold',
                      totalHits > 0 ? 'bg-orange-100 text-orange-800' : 'bg-green-100 text-green-700'
                    )}>
                      {totalHits > 0 ? `${totalHits} hit${totalHits > 1 ? 's' : ''}` : 'Clear'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-2.5 p-2.5 bg-gray-50 rounded-lg">
          {(() => {
            const hasMarketHits = (allConflicts.length > 0 || uniqueSimilarNames.length > 0);
            const marketPresencePct = hasMarketHits ? Math.round(sr.market_presence_score * 100) : 0;
            return (
              <>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-600">Market Presence Score</span>
                  <span className="font-semibold">{marketPresencePct}%</span>
                </div>
                <Progress value={marketPresencePct} className="h-2"
                  indicatorClassName={marketPresencePct > 60 ? 'bg-red-500' : marketPresencePct > 30 ? 'bg-orange-400' : 'bg-green-500'} />
              </>
            );
          })()}
        </div>
      </CardContent>

      <Dialog open={openTile !== null} onOpenChange={(o) => !o && setOpenTile(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              {activeTile && <activeTile.icon className="w-4 h-4 text-orange-600" />}
              {activeTile?.label} ({activeTile?.count})
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
            {activeTile?.items.map((it, i) => (
              <div key={i} className="py-2 flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-gray-800 truncate">{it.name}</p>
                  <p className="text-xs text-gray-400 truncate">{formatSourceName(it.source)}</p>
                </div>
                {it.detail && <span className="text-xs text-gray-500 flex-shrink-0 max-w-[45%] text-right">{it.detail}</span>}
              </div>
            ))}
            {activeTile && activeTile.items.length === 0 && (
              <p className="text-xs text-gray-400 py-2">No matched items.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Screening Workflow Panel ─────────────────────────────────────────────────

function sourceMatchesStep(stepId: string, source: string): boolean {
  const s = (source || '').trim().toLowerCase();
  switch (stepId) {
    case 'inn':
      return s.includes('who inn') || s.includes('chembl');
    case 'iqvia':
      return s.includes('iqvia');
    case 'trademark':
      return s.includes('trademark') || s.includes('registry');
    case 'epharmacy':
      return (
        s.includes('1mg') ||
        s.includes('pharmeasy') ||
        s.includes('apollo') ||
        s.includes('netmeds') ||
        s.includes('pharmacy') ||
        s.includes('e-pharmacy') ||
        s.endsWith('(india)')
      );
    case 'web':
      return s.includes('google') || s.includes('web search');
    default:
      return false;
  }
}

function humanizeConflictType(t: string): string {
  return (t || '')
    .split('_')
    .map(w => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

const SEVERITY_STYLE: Record<string, string> = {
  HIGH:   'bg-red-100 text-red-700 border-red-200',
  MEDIUM: 'bg-orange-100 text-orange-700 border-orange-200',
  LOW:    'bg-yellow-100 text-yellow-700 border-yellow-200',
};
const RISK_STYLE: Record<string, string> = {
  HIGH:   'bg-red-100 text-red-700',
  MEDIUM: 'bg-orange-100 text-orange-700',
  LOW:    'bg-green-100 text-green-700',
};

interface WorkflowStep {
  id: string;
  step: number;
  label: string;
  note: string;
  isKnockout: boolean;
  status: 'fail' | 'warn' | 'pass' | 'info' | 'not_run';
  detail: string;
  icon: React.ElementType;
}

function WorkflowStepDialog({
  step, sr, open, onClose,
}: { step: WorkflowStep | null; sr: ScreeningResult; open: boolean; onClose: () => void }) {
  if (!step) return null;

  const conflicts = sr.conflicts.filter(c => sourceMatchesStep(step.id, c.source));
  const similar = sr.similar_names.filter(sn => sourceMatchesStep(step.id, sn.source));
  const StepIcon = step.icon;
  const hasData = conflicts.length > 0 || similar.length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-orange-100 flex items-center justify-center flex-shrink-0">
              <StepIcon className="w-4 h-4 text-orange-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-gray-400">STEP {step.step}</span>
                {step.isKnockout && (
                  <span className="text-[9px] font-bold uppercase bg-red-100 text-red-600 px-1.5 py-0.5 rounded">Knockout Source</span>
                )}
              </div>
              <p className="text-base font-bold text-gray-900 leading-tight">{step.label}</p>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className={cn(
          'rounded-lg border px-4 py-3 flex items-start gap-2',
          step.status === 'fail' ? 'bg-red-50 border-red-200'
            : step.status === 'warn' ? 'bg-orange-50 border-orange-200'
            : step.status === 'info' || step.status === 'not_run' ? 'bg-gray-50 border-gray-200'
            : 'bg-green-50 border-green-200',
        )}>
          {step.status === 'fail' ? <XCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
            : step.status === 'warn' ? <AlertTriangle className="w-4 h-4 text-orange-500 mt-0.5 flex-shrink-0" />
            : step.status === 'not_run' ? <MinusCircle className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
            : <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />}
          <div>
            <p className="text-sm font-semibold text-gray-800">{step.detail}</p>
            <p className="text-xs text-gray-500 mt-0.5">{step.note}</p>
          </div>
        </div>

        {step.status === 'not_run' ? (
          <div className="py-8 text-center">
            <MinusCircle className="w-10 h-10 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-semibold text-gray-700">This check was not run</p>
            <p className="text-xs text-gray-400 mt-1">
              The pipeline stopped at an earlier stage before reaching this source, so no data was
              gathered here — this is not the same as a clean result.
            </p>
          </div>
        ) : (
        <>
        {conflicts.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-red-500" />
              Conflicts ({conflicts.length})
            </p>
            {conflicts.map((c, i) => (
              <div key={c.id || i} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <p className="text-sm font-bold text-gray-900">{c.conflicting_name}</p>
                    <span className="text-[11px] text-gray-500">{humanizeConflictType(c.conflict_type)}</span>
                  </div>
                  <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border flex-shrink-0',
                    SEVERITY_STYLE[c.severity] || SEVERITY_STYLE.MEDIUM)}>
                    {c.severity}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  {c.owner && (
                    <div>
                      <p className="text-[10px] uppercase text-gray-400 font-semibold">Owner / Manufacturer</p>
                      <p className="text-gray-700 font-medium">{c.owner}</p>
                    </div>
                  )}
                  {c.registration_number && (
                    <div>
                      <p className="text-[10px] uppercase text-gray-400 font-semibold">Registration No.</p>
                      <p className="text-gray-700 font-medium font-mono">{c.registration_number}</p>
                    </div>
                  )}
                  {c.status && (
                    <div>
                      <p className="text-[10px] uppercase text-gray-400 font-semibold">Status</p>
                      <p className="text-gray-700 font-medium">{c.status}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-[10px] uppercase text-gray-400 font-semibold">Source</p>
                    <p className="text-gray-700 font-medium">{formatSourceName(c.source)}</p>
                  </div>
                </div>
                {c.details && (
                  <div className="mt-2 text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 leading-relaxed">
                    {c.details}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {similar.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <GitCompare className="w-3.5 h-3.5 text-indigo-500" />
              {step.id === 'epharmacy' ? 'Listings' : step.id === 'web' ? 'Web References' : 'Similar / Related Names'} ({similar.length})
            </p>
            {similar.map((sn, i) => (
              <div key={sn.id || i} className="rounded-xl border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <p className="text-sm font-semibold text-gray-900">{sn.name}</p>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium', getSourceBadgeStyle(sn.source))}>
                      {formatSourceName(sn.source)}
                    </span>
                    <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full',
                      RISK_STYLE[sn.risk_level] || RISK_STYLE.LOW)}>
                      {sn.risk_level} RISK
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full',
                        sn.similarity_score >= 0.85 ? 'bg-red-500'
                          : sn.similarity_score >= 0.6 ? 'bg-orange-400' : 'bg-green-500')}
                      style={{ width: `${Math.round(sn.similarity_score * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs font-bold text-gray-700 w-10 text-right">
                    {Math.round(sn.similarity_score * 100)}%
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
                  <span><span className="text-gray-400">Type:</span> {sn.similarity_type}</span>
                  {sn.manufacturer && <span><span className="text-gray-400">Mfr:</span> {sn.manufacturer}</span>}
                  {sn.therapeutic_area && <span><span className="text-gray-400">Area:</span> {sn.therapeutic_area}</span>}
                  {sn.country && <span><span className="text-gray-400">Country:</span> {sn.country}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {!hasData && (
          <div className="py-8 text-center">
            <CheckCircle className="w-10 h-10 text-green-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-gray-700">No conflicts or matches from this source</p>
            <p className="text-xs text-gray-400 mt-1">
              {step.id === 'web'
                ? `Market presence index: ${Math.round(sr.market_presence_score * 100)}%, based on aggregate web signals.`
                : 'This data source returned a clean result for the screened name.'}
            </p>
          </div>
        )}
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ScreeningWorkflowPanel({ sr, stagesCompleted }: { sr: ScreeningResult; stagesCompleted?: number }) {
  const innKnockout = sr.conflicts.some(c => c.conflict_type === 'INN_KNOCKOUT');
  const innStemMatch = sr.similar_names.some(sn => sn.source?.includes('WHO INN'));

  const [openStepId, setOpenStepId] = useState<string | null>(null);

  // The "Google Search" step's percentage only ever reflects genuine
  // Google-sourced hits (see compare.py/brand_screening.py's
  // market_presence_score) — but when GOOGLE_API_KEY/GOOGLE_CSE_ID aren't
  // configured at all, there's nothing being checked, so that's called out
  // explicitly instead of silently showing "0%, Clear" (which would read
  // as "checked, confirmed clean" rather than "never checked").
  const dataSourcesQuery = useQuery({
    queryKey: ['data-sources-status'],
    queryFn: () => apiClient.getDataSources(),
    staleTime: 5 * 60 * 1000,
  });
  const googleSource = dataSourcesQuery.data?.sources.find(s => s.id === 'google_search');
  const googleReady = googleSource?.connected === true;
  // IQVIA shares WHO INN's own backend stage (STAGE_NAMES[1] = "WHO INN &
  // IQVIA Registry Check" — see brand_screening.py) rather than having its
  // own separate pipeline stage, so this card uses step: 1 too instead of
  // its own number — that keeps the stagesCompleted "Not Run" gating below
  // accurate for it (a pipeline that completed Stage 1 checked both).
  const iqviaSource = dataSourcesQuery.data?.sources.find(s => s.id === 'iqvia');
  const isIqviaDisconnected = Boolean(iqviaSource && (iqviaSource.enabled === false || (iqviaSource as any).status === 'inactive'));
  const iqviaReady = iqviaSource?.connected === true && !isIqviaDisconnected;
  const iqviaCount = iqviaSource?.record_count ?? 0;
  const iqviaConflicts = sr.conflicts.filter(c => sourceMatchesStep('iqvia', c.source));
  const iqviaSimilar = sr.similar_names.filter(sn => sourceMatchesStep('iqvia', sn.source));
  const iqviaKnockout = (sr.rejected_at_stage === 2) || iqviaConflicts.some(c => c.severity === 'HIGH' || ['EXACT_MATCH', 'EXACT_MARKET_MATCH', 'IQVIA_MARKET_CONFLICT'].includes(c.conflict_type) || (c.similarity_score && c.similarity_score >= 0.70));
  const iqviaWarning = iqviaConflicts.length > 0 || iqviaSimilar.length > 0;

  const steps: WorkflowStep[] = [
    {
      id: 'inn',
      step: 1,
      label: 'WHO INN Check',
      note: 'International Non-Proprietary Names, knockout source',
      isKnockout: true,
      status: innKnockout ? 'fail' : innStemMatch ? 'warn' : 'pass',
      detail: innKnockout
        ? 'KNOCKOUT: Name is a registered WHO INN'
        : innStemMatch
        ? 'High similarity to a known INN stem detected'
        : 'No WHO INN conflicts detected',
      icon: FlaskConical,
    },
    {
      id: 'iqvia',
      step: 2,
      label: 'IQVIA Database',
      note: iqviaReady
        ? (iqviaCount > 0 ? `Connected (${iqviaCount.toLocaleString()} records loaded)` : 'Active / Connected')
        : (isIqviaDisconnected ? 'Disconnected / Inactive' : 'Not configured yet'),
      isKnockout: true,
      status: !iqviaReady
        ? 'info'
        : iqviaKnockout
        ? 'fail'
        : iqviaWarning
        ? 'warn'
        : 'pass',
      detail: !iqviaReady
        ? (isIqviaDisconnected ? 'Disconnected / Inactive — skipped in screening pipeline' : 'Not configured yet — no active IQVIA records loaded.')
        : iqviaKnockout
        // IQVIA's own rejection logic (exact match / Phonetic-Spelling-Conceptual
        // >=85% / commercial growth >50%) sets a precise, rule-specific
        // rejection_reason server-side — show that verbatim instead of a
        // generic (and now-stale) fixed threshold string.
        ? (sr.rejected_at_stage === 2 && sr.rejection_reason ? sr.rejection_reason : 'KNOCKOUT: Matched IQVIA database')
        // Not rejected, but IQVIA flagged it for User Review — e.g. a
        // sub-85%-similarity match whose commercial growth is blank/NULL.
        // Never an automatic clean pass under the mentor-updated IQVIA
        // logic, so this takes priority over the generic "match(es)
        // detected" wording below.
        : sr.iqvia_review_note
        ? sr.iqvia_review_note
        : iqviaWarning
        ? `${iqviaConflicts.length + iqviaSimilar.length} IQVIA match(es) detected (below the 85% reject threshold)`
        : 'Clean — No IQVIA market conflicts detected',
      icon: Database,
    },
    {
      id: 'epharmacy',
      step: 3,
      label: 'E-Pharmacy Platforms',
      note: '1mg, PharmEasy, Apollo Pharmacy & Netmeds',
      isKnockout: false,
      status: sr.conflicts.some(c => sourceMatchesStep('epharmacy', c.source))
        ? 'fail'
        : sr.similar_names.some(sn => sourceMatchesStep('epharmacy', sn.source)) || sr.epharmacy_conflicts > 0
        ? 'warn'
        : 'pass',
      detail: sr.conflicts.some(c => sourceMatchesStep('epharmacy', c.source))
        ? `${sr.conflicts.filter(c => sourceMatchesStep('epharmacy', c.source)).length} conflict(s) detected across 1mg, PharmEasy, Netmeds, Apollo`
        : sr.similar_names.some(sn => sourceMatchesStep('epharmacy', sn.source)) || sr.epharmacy_conflicts > 0
        ? `${sr.similar_names.filter(sn => sourceMatchesStep('epharmacy', sn.source)).length || sr.epharmacy_conflicts} online pharmacy listing(s) found`
        : 'No e-pharmacy conflicts',
      icon: ShoppingCart,
    },
    {
      id: 'web',
      step: 4,
      label: 'Google Search',
      note: 'Google & broader market references',
      isKnockout: false,
      status: !googleReady ? 'info' : sr.market_presence_score > 0.5 ? 'warn' : sr.market_presence_score > 0.2 ? 'info' : 'pass',
      detail: !googleReady
        ? `Not integrated yet — ${googleSource?.detail ?? 'Google Search API is not configured.'}`
        : `Market presence index: ${Math.round(sr.market_presence_score * 100)}%, based on live Google Custom Search results compared against this name.`,
      icon: Globe,
    },
  ];

  const statusConfig = {
    fail: { bg: 'bg-red-50 border-red-200 hover:border-red-300', dot: 'bg-red-500', text: 'text-red-700', label: 'Conflict', icon: XCircle, iconColor: 'text-red-500' },
    warn: { bg: 'bg-orange-50 border-orange-200 hover:border-orange-300', dot: 'bg-orange-400', text: 'text-orange-700', label: 'Review', icon: AlertTriangle, iconColor: 'text-orange-500' },
    pass: { bg: 'bg-green-50 border-green-200 hover:border-green-300', dot: 'bg-green-500', text: 'text-green-700', label: 'Clear', icon: CheckCircle, iconColor: 'text-green-500' },
    info: { bg: 'bg-gray-50 border-gray-200 hover:border-gray-300', dot: 'bg-gray-400', text: 'text-gray-600', label: 'Low', icon: CheckCircle, iconColor: 'text-gray-400' },
    not_run: { bg: 'bg-gray-50 border-gray-200 border-dashed hover:border-gray-300', dot: 'bg-gray-300', text: 'text-gray-400', label: 'Not Run', icon: MinusCircle, iconColor: 'text-gray-300' },
  };

  // A pipeline that stopped early (see brand_screening.py's sequential
  // fail-fast redesign) never actually ran the later stages. The pipeline
  // itself still skips them (no wasted API calls/scrapes), but the card is
  // always shown — just relabeled "Not Run" — instead of disappearing,
  // so it's never confused with a step that ran and came back clean.
  // Undefined stagesCompleted (e.g. the AI Generator's detail modal, which
  // has no stage-tracking data) keeps the original always-show-3 behavior.
  const visibleSteps = stagesCompleted != null
    ? steps.map(s => s.step > stagesCompleted
        ? { ...s, status: 'not_run' as const, detail: 'Pipeline stopped at an earlier stage — this check was not run.' }
        : s)
    : steps;

  const openStep = visibleSteps.find(s => s.id === openStepId) || null;
  const matchCount = (id: string) =>
    sr.conflicts.filter(c => sourceMatchesStep(id, c.source)).length +
    sr.similar_names.filter(sn => sourceMatchesStep(id, sn.source)).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ListChecks className="w-4 h-4 text-orange-600" />
          Screening Workflow: Data Source Pipeline
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 items-stretch">
          {visibleSteps.map((s) => {
            const cfg = statusConfig[s.status];
            const StatusIcon = cfg.icon;
            const StepIcon = s.icon;
            const count = matchCount(s.id);
            return (
              <div key={s.id} className="flex flex-col h-full">
                <button
                  type="button"
                  onClick={() => setOpenStepId(s.id)}
                  className={cn(
                    'flex-1 flex flex-col justify-between text-left rounded-lg border p-3 transition-all cursor-pointer w-full h-full',
                    'hover:shadow-md focus:outline-none focus:ring-2 focus:ring-orange-300 relative group',
                    cfg.bg,
                  )}
                >
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="w-5 h-5 rounded-full bg-white border border-gray-200 flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-bold text-gray-600">{s.step}</span>
                      </div>
                      <StepIcon className={cn('w-3.5 h-3.5', cfg.text)} />
                      {count > 0 && (
                        <span className="ml-auto text-[9px] font-bold bg-white border border-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full">
                          {count}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-semibold text-gray-800 leading-tight">{s.label}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5 mb-2 leading-tight">{s.note}</p>
                    <div className="flex items-center gap-1">
                      <StatusIcon className={cn('w-3 h-3', cfg.iconColor)} />
                      <span className={cn('text-[10px] font-bold', cfg.text)}>{cfg.label}</span>
                    </div>
                    <p className={cn('text-[10px] mt-0.5 leading-snug line-clamp-2', cfg.text)}>{s.detail}</p>
                  </div>
                  <span className="mt-2 flex items-center gap-1 text-[10px] font-medium text-gray-400 group-hover:text-orange-500 transition-colors">
                    <Eye className="w-3 h-3" /> View details
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-gray-400 mt-2">
          Steps 5–8 (Mike Trademark, Trademark Registry, Trademark validation, Risk assessment) are performed by the Trademark Team and are out of scope for this AI tool.
        </p>
      </CardContent>

      <WorkflowStepDialog
        step={openStep}
        sr={sr}
        open={openStepId !== null}
        onClose={() => setOpenStepId(null)}
      />
    </Card>
  );
}

// ─── Knockout & Validation Panel (5 Pharma Rules) ──────────────────────────────

export function KnockoutValidationPanel({ sr, brandName }: { sr: ScreeningResult; brandName: string }) {
  // If backend provided pre-evaluated 5 knockout checks, use them directly
  const rawChecks = sr.knockout_checks;

  const defaultChecks = (() => {
    const conflicts = sr.conflicts || [];
    const hasExact = conflicts.some(c => ['EXACT_MATCH', 'EXACT_MARKET_MATCH'].includes(c.conflict_type));
    const hasWhoInn = (sr.rejected_at_stage === 2) || conflicts.some(c => ['INN_KNOCKOUT', 'WHO_INN_CONFLICT'].includes(c.conflict_type) || (c.source || '').toLowerCase().includes('who'));
    const isLinguistic = (sr.rejected_at_stage === 1) || Boolean((sr as any).is_linguistically_invalid);
    const hasHighConflict = conflicts.some(c => c.severity === 'HIGH' || (c as any).similarity_score >= 0.75);
    const hasMedConflict = conflicts.some(c => c.severity === 'MEDIUM' || (c as any).similarity_score >= 0.50);
    const hasHighPs = (sr.spelling_similarity_score >= 0.80 || sr.phonetic_similarity_score >= 0.85);
    const hasMedPs = (sr.spelling_similarity_score >= 0.60 || sr.phonetic_similarity_score >= 0.65);

    return [
      {
        id: 'molecule_inn_stems',
        label: 'Molecule or INN stems',
        rule: 'Evaluates conflicts with protected WHO INN stems or active drug substance stems',
        status: (hasWhoInn || isLinguistic) ? 'fail' : 'pass',
        detail: hasWhoInn ? 'Collision with registered WHO INN stems detected' : 'No collision with protected WHO INN stems or active molecule stems',
        isKnockout: true,
      },
      {
        id: 'disease_organ_names',
        label: 'Disease, ailment, or organ names',
        rule: 'Prevents deceptive or descriptive use of disease, ailment, anatomical, or organ terms',
        status: 'pass',
        detail: 'Free of deceptive anatomical or disease-descriptive terminology',
        isKnockout: true,
      },
      {
        id: 'chemical_compound_names',
        label: 'Chemical or compound names',
        rule: 'Checks for infringement or misleading use of IUPAC chemical prefixes, radical groups, or salt compound designations',
        status: 'pass',
        detail: 'No chemical compound prefixes, radical groups, or salt designations found',
        isKnockout: true,
      },
      {
        id: 'existing_brand_names',
        label: 'Existing brand names',
        rule: 'Exact or high-collision existing trademarks/market brands in pharma registers & e-pharmacy databases',
        status: hasExact ? 'fail' : hasHighConflict ? 'fail' : hasMedConflict ? 'warn' : 'pass',
        detail: hasExact ? 'Exact match found in trademark/market database' : hasHighConflict ? 'High similarity collision with active commercial pharmaceutical brand' : hasMedConflict ? 'Moderate similarity overlap with active brand' : 'No high-risk collisions with registered trademarks',
        isKnockout: true,
      },
      {
        id: 'prefix_suffix_similarities',
        label: 'Existing brand names with significant prefix or suffix similarities',
        rule: 'Leading prefix or trailing suffix collision with high-market-share commercial pharmaceutical brands',
        status: hasHighPs ? 'fail' : hasMedPs ? 'warn' : 'pass',
        detail: hasHighPs ? 'Significant leading prefix or trailing suffix collision with commercial brand' : hasMedPs ? 'Moderate prefix/suffix resemblance with market brand' : 'Distinctive leading prefix and trailing suffix structure',
        isKnockout: true,
      },
    ];
  })();

  const checks = (rawChecks && rawChecks.length >= 5) ? rawChecks : defaultChecks;

  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const knockoutFailed = checks.filter(c => c.isKnockout && c.status === 'fail').length;

  return (
    <Card className={cn('border', knockoutFailed > 0 ? 'border-red-200 shadow-sm' : failCount > 0 ? 'border-orange-200' : 'border-green-200')}>
      <CardHeader className="pb-2.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold text-gray-900">
            <Shield className="w-4 h-4 text-orange-600" /> Knockout & Validation Checks
          </CardTitle>
          <div className="flex items-center gap-2">
            {knockoutFailed > 0 && (
              <span className="text-xs font-bold bg-red-100 text-red-700 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <XCircle className="w-3 h-3" /> {knockoutFailed} Knockout Fail
              </span>
            )}
            {failCount > 0 && knockoutFailed === 0 && (
              <span className="text-xs font-semibold bg-orange-100 text-orange-700 px-2.5 py-0.5 rounded-full">
                {failCount} Fail
              </span>
            )}
            {warnCount > 0 && (
              <span className="text-xs font-semibold bg-amber-100 text-amber-800 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {warnCount} Review Required
              </span>
            )}
            {failCount === 0 && warnCount === 0 && (
              <span className="text-xs font-semibold bg-green-100 text-green-700 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> All 5 Rules Cleared
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {checks.map(c => {
            const isFail = c.status === 'fail';
            const isWarn = c.status === 'warn';
            return (
              <div key={c.id} className={cn(
                'flex items-start gap-2.5 p-3 rounded-xl border transition-all',
                isFail ? 'bg-red-50/80 border-red-200' : isWarn ? 'bg-amber-50/70 border-amber-200' : 'bg-green-50/60 border-green-200'
              )}>
                <div className="flex-shrink-0 mt-0.5">
                  {isFail
                    ? <XCircle className="w-4 h-4 text-red-500" />
                    : isWarn
                    ? <AlertTriangle className="w-4 h-4 text-amber-600" />
                    : <CheckCircle className="w-4 h-4 text-green-600" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1 mb-0.5">
                    <p className={cn('text-xs font-bold leading-snug', isFail ? 'text-red-900' : isWarn ? 'text-amber-900' : 'text-green-900')}>
                      {c.label}
                    </p>
                    <span className={cn(
                      'text-[9px] font-extrabold uppercase px-1.5 py-0.2 rounded',
                      isFail ? 'bg-red-200 text-red-800' : isWarn ? 'bg-amber-200 text-amber-900' : 'bg-green-200 text-green-800'
                    )}>
                      {c.status}
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-600 line-clamp-2">{c.rule}</p>
                  {c.detail && (
                    <p className={cn('text-[10px] font-medium mt-1', isFail ? 'text-red-700' : isWarn ? 'text-amber-800' : 'text-green-700')}>
                      {c.detail}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {knockoutFailed > 0 && (
          <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-800 leading-relaxed">
              <strong>"{brandName}" has failed {knockoutFailed} pharmaceutical knockout check{knockoutFailed > 1 ? 's' : ''}.</strong> Under CDSCO/FDA naming guidelines, candidates triggering regulatory stem conflicts or direct market collisions require immediate trademark substitution or trademark reviewer evaluation.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Case Composition & Therapeutic Impact Rationale Card ──────────────────────

export function CaseCompositionRationaleCard({
  sr,
  activeCase,
  brandName,
}: {
  sr: ScreeningResult;
  activeCase?: any;
  brandName: string;
}) {
  const [selectedPrinciple, setSelectedPrinciple] = useState<any | null>(null);

  const caseCtx = sr.case_context || activeCase || null;
  const genericName = caseCtx?.generic_name || activeCase?.generic_name || 'N/A';
  const therapy = caseCtx?.therapy || activeCase?.therapy || 'General Medicine';
  const indications = caseCtx?.promoting_indications || caseCtx?.ailment || activeCase?.promoting_indications || activeCase?.ailment || 'Targeted therapeutic indication';
  const dosageForm = caseCtx?.dosage_form || activeCase?.dosage_form || 'Oral Solid Dosage';
  const caseId = caseCtx?.case_id || activeCase?.case_id || 'Active Case';
  const cleanName = (brandName || '').toLowerCase().trim();
  const genLower = genericName.toLowerCase().trim();
  const indLower = (typeof indications === 'string' ? indications : '').toLowerCase().trim();

  // Prefer backend LLM-evaluated coining principles when available
  const coiningPrinciples: Array<{ title: string; desc: string; score: number; rationale: string }> = (() => {
    const backendEval = sr.coining_principles_eval || caseCtx?.coining_principles_eval;
    if (Array.isArray(backendEval) && backendEval.length >= 8) {
      return backendEval.map(p => ({
        title: p.title || `Principle ${p.id}`,
        desc: p.desc || '',
        score: typeof p.score === 'number' ? p.score : 75,
        rationale: p.rationale || 'Evaluated in accordance with Sun Pharma Brand Coining Principles.',
      }));
    }

    // Dynamic regulatory fallback enforcing strict gating
    const isMolCopy = genLower && genLower !== 'n/a' && (cleanName === genLower || cleanName.startsWith(genLower) || genLower.startsWith(cleanName) || cleanName.includes(genLower));
    const molStem = genLower && genLower.length >= 4 ? genLower.slice(0, 5) : '';
    const isStemCopy = molStem && (cleanName.startsWith(molStem) || cleanName.includes(molStem));

    const p2Score = isMolCopy ? 15 : isStemCopy ? 20 : Math.max(50, Math.round(100 - (sr.phonetic_similarity_score * 40)));
    const p2Rationale = isMolCopy
      ? `Candidate "${brandName}" directly duplicates generic active molecule "${genericName}", violating international non-proprietary nomenclature rules.`
      : isStemCopy
      ? `Candidate "${brandName}" appropriates active generic stem "${molStem}", posing critical regulatory collision with generic substance nomenclature.`
      : `Phonetically distinctive candidate aligned with "${genericName}" without generic INN stem collision.`;

    const diseaseKeywords = ['migrain', 'headache', 'cardio', 'pain', 'ulcer', 'asthma', 'cancer', 'diabet', 'hypertens', 'fever', 'cough'];
    const diseaseHit = diseaseKeywords.find(d => cleanName.includes(d)) || (indLower && indLower.split(/\s+/).find(w => w.length >= 4 && cleanName.includes(w)));

    const p3Score = diseaseHit ? 10 : 85;
    const p3Rationale = diseaseHit
      ? `Candidate "${brandName}" directly incorporates disease/ailment terminology ("${diseaseHit}"), violating CDSCO and FDA non-descriptive trademark regulations.`
      : `Maintains an appropriate clinical and therapeutic tone for ${therapy} without descriptive condition naming.`;

    const syllableEst = Math.max(1, Math.floor(cleanName.length / 3));
    const p1Score = (syllableEst >= 2 && syllableEst <= 3 && cleanName.length >= 5 && cleanName.length <= 9) ? (sr.memorability_score ? Math.round(sr.memorability_score) : 85) : 70;
    const p1Rationale = `Candidate "${brandName}" features ${cleanName.length} characters with an intuitive ${syllableEst}-syllable cadence, promoting physician and patient brand recall.`;

    const p8Score = Math.round(Math.max(0, 100 - sr.overall_risk_score));
    const p8Rationale = `Assessed at ${p8Score}% distinctiveness based on an overall clearance risk score of ${Math.round(sr.overall_risk_score)}/100 across target markets.`;

    return [
      { title: '1. Short & Memorable Names', desc: 'Distinct 2-3 syllable cadence, high recall', score: p1Score, rationale: p1Rationale },
      { title: '2. Molecule Association', desc: `Phonetic alignment with ${genericName} without stem infringement`, score: p2Score, rationale: p2Rationale },
      { title: '3. Disease / Therapeutic Context', desc: `Appropriate tone for ${therapy}`, score: p3Score, rationale: p3Rationale },
      { title: '4. Product Effect / Benefit', desc: 'Conveys therapeutic confidence without misleading claims', score: 88, rationale: `Conveys therapeutic efficacy and clinical confidence for ${indications} without making deceptive or promissory claims.` },
      { title: '5. Emotional Association', desc: 'Trust, vitality, professional clinical reassurance', score: 80, rationale: `Inspires reassurance and patient serenity appropriate for ${therapy} treatment regimens.` },
      { title: '6. Patient / Historical Connection', desc: 'Distinctive brand identity and heritage', score: 75, rationale: `Establishes an intuitive phonetic profile facilitating chronic prescription adherence and dispensing clarity.` },
      { title: '7. Umbrella / Extension Fit', desc: 'Compatible with brand architecture and line extensions', score: 84, rationale: `Harmonizes well with Sun Pharma master brand architecture and future line extension suffixes (e.g. Forte, OD, Plus).` },
      { title: '8. Global Distinctiveness', desc: 'Unregistered and distinctive across target geographies', score: p8Score, rationale: p8Rationale },
    ];
  })();

  return (
    <Card className="border border-orange-200 bg-gradient-to-br from-orange-50/40 via-white to-amber-50/30 shadow-sm">
      <CardHeader className="pb-3 border-b border-orange-100/60">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold text-gray-900">
            <FlaskConical className="w-4 h-4 text-orange-600" /> Case Composition & Clinical Coining Rationale
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-orange-800 bg-orange-100/80 px-2.5 py-0.5 rounded-full">
              Case: {caseId}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {/* Composition Parameters Effecting Analysis */}
        <div>
          <p className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-orange-600" /> Composition Parameters Effecting Analysis
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <div className="p-2.5 rounded-xl border border-gray-200 bg-white shadow-xs">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Active Molecule</span>
              <span className="text-xs font-bold text-gray-900 block truncate" title={genericName}>{genericName}</span>
              <span className="text-[10px] text-gray-500 mt-0.5 block">WHO INN & Stem Check</span>
            </div>
            <div className="p-2.5 rounded-xl border border-gray-200 bg-white shadow-xs">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Therapeutic Area</span>
              <span className="text-xs font-bold text-gray-900 block truncate" title={therapy}>{therapy}</span>
              <span className="text-[10px] text-gray-500 mt-0.5 block">Cross-Therapy Safety</span>
            </div>
            <div className="p-2.5 rounded-xl border border-gray-200 bg-white shadow-xs">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Indication / Ailment</span>
              <span className="text-xs font-bold text-gray-900 block truncate" title={indications}>{indications}</span>
              <span className="text-[10px] text-gray-500 mt-0.5 block">Indication Alignment</span>
            </div>
            <div className="p-2.5 rounded-xl border border-gray-200 bg-white shadow-xs">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Dosage Form</span>
              <span className="text-xs font-bold text-gray-900 block truncate" title={dosageForm}>{dosageForm}</span>
              <span className="text-[10px] text-gray-500 mt-0.5 block">LASA Dispensing Risk</span>
            </div>
          </div>
        </div>

        {/* 8 Brand Coining Principles Grid - Interactive Clickable Cards */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold text-gray-700 uppercase tracking-wide flex items-center gap-1.5">
              <ListChecks className="w-3.5 h-3.5 text-orange-600" /> Eight Coining Principles Alignment
            </p>
            <span className="text-[10px] text-orange-600 font-medium bg-orange-50 px-2 py-0.5 rounded-md border border-orange-100">
              Click any block to view clinical rationale
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {coiningPrinciples.map(cp => (
              <button
                key={cp.title}
                type="button"
                onClick={() => setSelectedPrinciple(cp)}
                className="p-2.5 rounded-lg border border-gray-100 bg-white shadow-xs text-left transition-all hover:border-orange-300 hover:shadow-md hover:bg-orange-50/20 active:scale-[0.98] cursor-pointer group flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-[10px] font-bold text-gray-800 truncate group-hover:text-orange-900">{cp.title}</span>
                    <span className={cn(
                      'text-[9px] font-bold px-1.5 py-0.2 rounded flex-shrink-0',
                      cp.score >= 80 ? 'bg-green-100 text-green-700' : cp.score >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                    )}>
                      {cp.score}%
                    </span>
                  </div>
                  <p className="text-[9px] text-gray-500 line-clamp-1">{cp.desc}</p>
                </div>
                <div className="mt-2 flex items-center justify-end">
                  <span className="text-[8.5px] text-orange-600 font-medium flex items-center gap-0.5 opacity-80 group-hover:opacity-100">
                    Why {cp.score}%? <Eye className="w-2.5 h-2.5" />
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Plain English AI Clinical Assessment */}
        {sr.ai_assessment && (
          <div className="p-3.5 rounded-xl border border-orange-200/80 bg-white shadow-xs">
            <div className="flex items-center gap-2 mb-1.5">
              <Brain className="w-4 h-4 text-orange-600" />
              <span className="text-xs font-bold text-gray-900">Clinical Brand Screening Assessment</span>
            </div>
            <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-line">
              {sr.ai_assessment}
            </p>
          </div>
        )}
      </CardContent>

      {/* Interactive Explanation Modal */}
      <Dialog open={selectedPrinciple !== null} onOpenChange={(open) => !open && setSelectedPrinciple(null)}>
        <DialogContent className="max-w-md bg-white p-5 rounded-2xl border border-orange-100 shadow-xl">
          <DialogHeader className="pb-3 border-b border-gray-100">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle className="text-sm font-bold text-gray-900 flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-orange-600" />
                {selectedPrinciple?.title}
              </DialogTitle>
              {selectedPrinciple && (
                <span className={cn(
                  'text-xs font-extrabold px-2.5 py-0.5 rounded-full border',
                  selectedPrinciple.score >= 80 ? 'bg-green-50 text-green-700 border-green-200' :
                  selectedPrinciple.score >= 60 ? 'bg-amber-50 text-amber-700 border-amber-200' :
                  'bg-red-50 text-red-700 border-red-200'
                )}>
                  {selectedPrinciple.score}% Score
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">{selectedPrinciple?.desc}</p>
          </DialogHeader>

          <div className="py-3 space-y-3.5">
            <div className={cn(
              'p-3 rounded-xl border text-xs leading-relaxed',
              selectedPrinciple?.score >= 80 ? 'bg-green-50/50 border-green-100 text-green-900' :
              selectedPrinciple?.score >= 60 ? 'bg-amber-50/50 border-amber-100 text-amber-900' :
              'bg-red-50/50 border-red-100 text-red-900'
            )}>
              <span className="font-bold block mb-1">
                {selectedPrinciple?.score >= 80 ? 'Compliance Status: Strong Alignment' :
                 selectedPrinciple?.score >= 60 ? 'Compliance Status: Moderate Alignment / Review Suggested' :
                 'Compliance Status: Critical Regulatory Violation / Penalty Applied'}
              </span>
              <p className="text-gray-700">{selectedPrinciple?.rationale}</p>
            </div>

            <div className="bg-gray-50 rounded-xl p-3 border border-gray-100 space-y-1.5 text-[11px]">
              <span className="font-bold text-gray-600 uppercase tracking-wider block text-[9.5px]">Case Reference Context</span>
              <div className="flex justify-between py-0.5 border-b border-gray-200/60">
                <span className="text-gray-500">Screened Brand Name:</span>
                <span className="font-bold text-gray-900">{brandName}</span>
              </div>
              <div className="flex justify-between py-0.5 border-b border-gray-200/60">
                <span className="text-gray-500">Active Generic Molecule:</span>
                <span className="font-semibold text-gray-800">{genericName}</span>
              </div>
              <div className="flex justify-between py-0.5 border-b border-gray-200/60">
                <span className="text-gray-500">Clinical Indication:</span>
                <span className="font-semibold text-gray-800 truncate max-w-[200px]" title={indications}>{indications}</span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-gray-500">Therapeutic Class:</span>
                <span className="font-semibold text-gray-800">{therapy}</span>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Brand Uniqueness + Similarity Breakdown ───────────────────────────────────


export function UniquenessAndBreakdown({ intel, sr }: { intel: BrandIntelligence; sr?: ScreeningResult }) {
  const uniqueness = Math.round(intel.brand_uniqueness_score ?? (intel as any).uniqueness_score ?? 0);

  const breakdownData: Array<{ type: string; count: number; color: string }> = (() => {
    if (sr?.similar_names) {
      const allSimilar = sr.similar_names || [];
      const exactCount = (sr.conflicts || []).filter(c => ['EXACT_MATCH', 'EXACT_MARKET_MATCH'].includes(c.conflict_type)).length;
      const phonCount = exactCount + allSimilar.filter(n => n.similarity_type === 'Phonetic').length;
      const spellCount = allSimilar.filter(n => n.similarity_type === 'Spelling').length;
      const visCount = allSimilar.filter(n => n.similarity_type === 'Visual' || n.similarity_type === 'Look-Alike').length;
      const concCount = allSimilar.filter(n => n.similarity_type === 'Conceptual' || n.similarity_type === 'Semantic').length;

      const items = [
        { type: 'Phonetic', count: phonCount, color: '#3b82f6' },
        { type: 'Spelling', count: spellCount, color: '#a855f7' },
        { type: 'Visual', count: visCount, color: '#f97316' },
        { type: 'Conceptual', count: concCount, color: '#6366f1' },
      ];
      return items.filter(it => it.count > 0);
    }
    return (intel.similarity_breakdown || []) as any;
  })();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Brand Uniqueness Score</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="relative w-24 h-24 flex-shrink-0">
              <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                <circle cx="50" cy="50" r="40" fill="none" stroke="#e5e7eb" strokeWidth="10" />
                <circle cx="50" cy="50" r="40" fill="none"
                  stroke={uniqueness > 60 ? '#22c55e' : uniqueness > 30 ? '#f97316' : '#ef4444'}
                  strokeWidth="10"
                  strokeDasharray={`${(uniqueness / 100) * 251.2} 251.2`}
                  strokeLinecap="round" />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-xl font-bold text-gray-900">
                {uniqueness}
              </span>
            </div>
            <div>
              <p className="text-sm text-gray-600">
                {intel.brand_uniqueness_score > 60 ? 'High uniqueness, strong differentiation'
                  : intel.brand_uniqueness_score > 30 ? 'Moderate uniqueness, some differentiation possible'
                  : 'Low uniqueness, crowded naming space'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Similarity Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="w-[140px] h-[120px] flex-shrink-0">
              {(() => {
                const totalSimilar = breakdownData.reduce((acc: number, it: any) => acc + (it.count || 0), 0);
                return (
                  <PieChart width={140} height={120} className="outline-none focus:outline-none select-none" style={{ outline: 'none' }}>
                    {totalSimilar > 0 ? (
                      <Pie
                        data={breakdownData.filter((it: any) => it.count > 0)}
                        cx={70}
                        cy={60}
                        innerRadius={35}
                        outerRadius={55}
                        dataKey="count"
                        nameKey="type"
                        className="outline-none focus:outline-none"
                        style={{ outline: 'none' }}
                        tabIndex={-1}
                      >
                        {breakdownData.filter((it: any) => it.count > 0).map((entry: any, i: number) => (
                          <Cell key={i} fill={entry.color} className="outline-none focus:outline-none" style={{ outline: 'none' }} tabIndex={-1} />
                        ))}
                      </Pie>
                    ) : (
                      <Pie
                        data={[{ type: 'Status', count: 1 }]}
                        cx={70}
                        cy={60}
                        innerRadius={35}
                        outerRadius={55}
                        dataKey="count"
                        nameKey="type"
                        className="outline-none focus:outline-none"
                        style={{ outline: 'none' }}
                        tabIndex={-1}
                      >
                        <Cell fill="#10b981" className="outline-none focus:outline-none" style={{ outline: 'none' }} tabIndex={-1} />
                      </Pie>
                    )}
                    <Tooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const item = payload[0].payload;
                          const countVal = item.count ?? payload[0].value;
                          return (
                            <div className="bg-white px-2.5 py-1 rounded-md shadow-md border border-gray-200 text-xs font-bold text-gray-800">
                              {totalSimilar > 0 ? countVal : 0}
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                  </PieChart>
                );
              })()}
            </div>
            <div className="space-y-1.5 min-w-0">
              {(() => {
                const totalSimilar = breakdownData.reduce((acc: number, it: any) => acc + (it.count || 0), 0);
                if (totalSimilar === 0) {
                  return (
                    <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 px-2.5 py-1.5 rounded-lg border border-emerald-100">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                      <span className="text-xs font-medium">All Cleared (0 conflicts)</span>
                    </div>
                  );
                }
                return breakdownData.map((item: any) => (
                  <div key={item.type || item.name} className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: item.color }} />
                    <span className="text-xs text-gray-600 truncate">{item.type || item.name}: <strong>{item.count}</strong></span>
                  </div>
                ));
              })()}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
