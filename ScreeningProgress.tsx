import { Search, FlaskConical, Globe, ShoppingCart, ShieldCheck, Shield } from 'lucide-react';
import { PipelineProgress, type PipelineStep, type PipelineThreshold } from '@/components/PipelineProgress';

const PIPELINE_STEPS: PipelineStep[] = [
  {
    id: 1,
    title: 'Brand Name Parsing',
    subtitle: 'Normalizing the candidate name for cross-source matching',
    icon: Search,
  },
  {
    id: 2,
    title: 'WHO INN & IQVIA Registry Check',
    subtitle: 'Screening against WHO International Nonproprietary Names and the licensed IQVIA extract',
    icon: FlaskConical,
  },
  {
    id: 3,
    title: 'Live E-Pharmacy Scan',
    subtitle: 'Scraping 1mg, PharmEasy, Apollo Pharmacy & Netmeds for active listings',
    icon: ShoppingCart,
  },
  {
    id: 4,
    title: 'Google Web Search',
    subtitle: 'Checking market, regulatory and news presence via Google Search',
    icon: Globe,
  },
  {
    id: 5,
    title: 'Risk Scoring & AI Assessment',
    subtitle: 'Deterministic phonetic/spelling/market scoring, then an AI-written rationale',
    icon: ShieldCheck,
  },
];

// Tuned to real observed pipeline timing — the live e-pharmacy scrape (step 3)
// dominates total latency (~12-18s of a ~15-20s run).
const THRESHOLDS: PipelineThreshold[] = [
  { atSeconds: 0, stepIndex: 0, percent: 15 },
  { atSeconds: 1, stepIndex: 1, percent: 30 },
  { atSeconds: 3, stepIndex: 2, percent: 55 },
  { atSeconds: 15, stepIndex: 3, percent: 80 },
  { atSeconds: 18, stepIndex: 4, percent: 95 },
];

// Maps backend sequential pipeline stages (1=WHO INN/IQVIA, 2=E-Pharmacy, 3=Google)
// to the 5-step UI display indices (0-indexed).
const BACKEND_STAGE_TO_STEP_INDEX: Record<number, number> = {
  1: 1, // WHO INN & IQVIA Registry Check
  2: 2, // Live E-Pharmacy Scan
  3: 3, // Google Web Search
};

interface ScreeningProgressProps {
  isScreening: boolean;
  brandName?: string;
  onStop?: () => void;
  // Set once the real screening result comes back rejected at a stage — see
  // BrandAnalysisPage's brief "freeze" of this panel before showing results.
  rejectedAt?: { stage: number; reason: string } | null;
}

export function ScreeningProgress({ isScreening, brandName, rejectedAt, onStop }: ScreeningProgressProps) {
  return (
    <PipelineProgress
      isRunning={isScreening}
      rejectedAt={rejectedAt ? { stepIndex: BACKEND_STAGE_TO_STEP_INDEX[rejectedAt.stage] ?? 1, reason: rejectedAt.reason } : null}
      steps={PIPELINE_STEPS}
      thresholds={THRESHOLDS}
      headerIcon={Shield}
      onStop={onStop}
      titleText="Running Brand Analysis"
      subtitleText={brandName ? `Screening "${brandName}"` : 'Screening…'}
      footerText="Cross-referencing WHO INN, IQVIA, Google Search & live e-pharmacy listings"
    />
  );
}
