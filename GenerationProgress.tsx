import { FileText, ShoppingCart, Brain, Shield, RotateCcw, Sparkles } from 'lucide-react';
import { PipelineProgress, type PipelineStep, type PipelineThreshold } from '@/components/PipelineProgress';

const PIPELINE_STEPS: PipelineStep[] = [
  {
    id: 1,
    title: 'Brief & Context Ingestion',
    subtitle: 'Extracting molecule, therapy, indication & regulatory parameters',
    icon: FileText,
  },
  {
    id: 2,
    title: 'AI Linguistic Brand Synthesis',
    subtitle: 'Generating coined candidate brand proposals via LLM',
    icon: Brain,
  },
  {
    id: 3,
    title: 'Multi-Tier Deterministic Screening',
    subtitle: 'Scoring phonetic Metaphone, visual trigrams & trademark similarity',
    icon: Shield,
  },
  {
    id: 4,
    title: 'Live E-Pharmacy Market Scraping',
    subtitle: 'Querying 1mg, PharmEasy, Apollo Pharmacy & Netmeds for active commercial listings',
    icon: ShoppingCart,
  },
  {
    id: 5,
    title: 'Market Collision Analysis & Ranking Safety',
    subtitle: 'Verifying collision thresholds, auto-replacing conflicts & final risk stratification',
    icon: RotateCcw,
  },
];

// Progression timeline tailored to real generation timing (~25-30s total).
const THRESHOLDS: PipelineThreshold[] = [
  { atSeconds: 0, stepIndex: 0, percent: 15 },
  { atSeconds: 2, stepIndex: 1, percent: 35 },
  { atSeconds: 8, stepIndex: 2, percent: 55 },
  { atSeconds: 12, stepIndex: 3, percent: 75 },
  { atSeconds: 22, stepIndex: 4, percent: 95 },
];

interface GenerationProgressProps {
  isGenerating: boolean;
  error?: string | null;
  moleculeName?: string;
  activeStepIndex?: number;
  activePercent?: number;
  activeSubtitle?: string;
  onStop?: () => void;
  stagesCollapsed?: boolean;
  onToggleStages?: () => void;
  estimatedSeconds?: number;
  generatedCount?: number;
  targetCount?: number;
}

export function GenerationProgress({
  isGenerating, error, moleculeName, activeStepIndex, activePercent, activeSubtitle, onStop,
  stagesCollapsed, onToggleStages, estimatedSeconds, generatedCount, targetCount,
}: GenerationProgressProps) {
  return (
    <PipelineProgress
      isRunning={isGenerating}
      error={error}
      activeStepIndex={activeStepIndex}
      activePercent={activePercent}
      activeSubtitle={activeSubtitle}
      onStop={onStop}
      stagesCollapsed={stagesCollapsed}
      onToggleStages={onToggleStages}
      estimatedSeconds={estimatedSeconds}
      generatedCount={generatedCount}
      targetCount={targetCount}
      steps={PIPELINE_STEPS}
      thresholds={THRESHOLDS}
      headerIcon={Sparkles}
      titleText="Generating Brand Names"
      subtitleText={activeSubtitle || (moleculeName ? `Screening for ${moleculeName}` : 'Evaluating multi-tier safety pipeline')}
      footerText="Cross-referencing 1,400+ registered trademarks & pharmacy listings"
    />
  );
}
