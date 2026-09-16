import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle, Loader2, Clock, XCircle, AlertTriangle, Square, ChevronDown, Hourglass } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function formatPipelineDuration(sec: number): string {
  if (sec <= 0) return '0s';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export interface PipelineStep {
  id: number;
  title: string;
  subtitle: string;
  icon: React.ElementType;
}

// A timing threshold: once `secondsElapsed >= atSeconds`, the panel shows
// step `stepIndex` at `percent`. Thresholds should be given in ascending
// `atSeconds` order — the last one whose `atSeconds` has been reached wins.
export interface PipelineThreshold {
  atSeconds: number;
  stepIndex: number;
  percent: number;
}

interface PipelineProgressProps {
  isRunning: boolean;
  error?: string | null;
  rejectedAt?: { stepIndex: number; reason: string } | null;
  activeStepIndex?: number;
  activePercent?: number;
  activeSubtitle?: string;
  onStop?: () => void;
  steps: PipelineStep[];
  thresholds: PipelineThreshold[];
  headerIcon: React.ElementType;
  titleText: string;
  subtitleText: string;
  footerText: string;
  stagesCollapsed?: boolean;
  onToggleStages?: () => void;
  estimatedSeconds?: number;
  generatedCount?: number;
  targetCount?: number;
}

// Shared "pipeline running" visual — a header with an elapsed-seconds clock,
// a progress bar, and a step-by-step checklist.
// Supports both real-time backend-driven stage updates (when activeStepIndex/activePercent are provided)
// and timer-based simulation fallback.
export function PipelineProgress({
  isRunning, error, rejectedAt, activeStepIndex, activePercent, activeSubtitle, onStop,
  steps, thresholds, headerIcon: HeaderIcon, titleText, subtitleText, footerText,
  stagesCollapsed, onToggleStages, estimatedSeconds, generatedCount, targetCount,
}: PipelineProgressProps) {
  const [internalStagesCollapsed, setInternalStagesCollapsed] = useState(false);
  const isStagesCollapsed = stagesCollapsed !== undefined ? stagesCollapsed : internalStagesCollapsed;
  const toggleStages = onToggleStages || (() => setInternalStagesCollapsed((prev) => !prev));

  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [percent, setPercent] = useState(10);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const hasFailed = Boolean(error);
  const hasRejected = Boolean(rejectedAt);
  const wasRunningRef = useRef(false);

  useEffect(() => {
    if (!isRunning) {
      wasRunningRef.current = false;
      if (!hasFailed && !hasRejected) {
        setCurrentStepIndex(0);
        setPercent(10);
        setSecondsElapsed(0);
      }
      return;
    }

    if (!wasRunningRef.current) {
      setCurrentStepIndex(0);
      setPercent(10);
      setSecondsElapsed(0);
    }
    wasRunningRef.current = true;

    const timerInterval = setInterval(() => {
      setSecondsElapsed((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(timerInterval);
  }, [isRunning, hasFailed, hasRejected]);

  useEffect(() => {
    if (!isRunning) return;

    if (activeStepIndex !== undefined && activePercent !== undefined) {
      setCurrentStepIndex(activeStepIndex);
      setPercent(activePercent);
      return;
    }

    let nextIndex = 0;
    let targetPercent = 15;
    for (const t of thresholds) {
      if (secondsElapsed >= t.atSeconds) {
        nextIndex = t.stepIndex;
        targetPercent = t.percent;
      }
    }

    setCurrentStepIndex(nextIndex);
    setPercent(targetPercent);
  }, [secondsElapsed, isRunning, thresholds, activeStepIndex, activePercent]);

  if (!isRunning && !hasFailed && !hasRejected) return null;

  const displayStepIndex = hasRejected
    ? rejectedAt!.stepIndex
    : (activeStepIndex !== undefined ? activeStepIndex : currentStepIndex);

  return (
    <Card className="p-6 md:p-8 bg-gradient-to-b from-white to-orange-50/30 border border-orange-100/80 shadow-lg rounded-2xl overflow-hidden transition-all duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-gray-100">
        <div className="flex items-center gap-3.5 min-w-0">
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
            hasFailed || hasRejected ? 'bg-red-500/10 border border-red-500/20' : 'bg-orange-500/10 border border-orange-500/20'
          }`}>
            <HeaderIcon className={`w-5 h-5 ${hasFailed || hasRejected ? 'text-red-600' : 'text-orange-600 animate-pulse'}`} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="font-bold text-gray-900 text-lg leading-tight">{titleText}</h3>
              {hasFailed ? (
                <span className="px-2.5 py-0.5 text-xs font-semibold bg-red-100 text-red-700 rounded-full flex-shrink-0">
                  Failed
                </span>
              ) : hasRejected ? (
                <span className="px-2.5 py-0.5 text-xs font-semibold bg-red-100 text-red-700 rounded-full flex-shrink-0">
                  Rejected
                </span>
              ) : (
                <span className="px-2.5 py-0.5 text-xs font-semibold bg-orange-100 text-orange-700 rounded-full animate-pulse flex-shrink-0">
                  Pipeline Running
                </span>
              )}
            </div>
            <p className="text-xs sm:text-sm text-gray-500 mt-0.5 line-clamp-1">{subtitleText}</p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 self-end sm:self-center flex-shrink-0 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200/80 rounded-lg text-xs font-medium text-gray-600 shadow-sm whitespace-nowrap">
            <Clock className="w-3.5 h-3.5 text-orange-500" />
            <span>{secondsElapsed}s elapsed</span>
          </div>

          {estimatedSeconds !== undefined && estimatedSeconds > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 border border-blue-200/80 rounded-lg text-xs font-semibold text-blue-700 shadow-sm whitespace-nowrap">
              <Hourglass className="w-3.5 h-3.5 text-blue-600 animate-spin" />
              <span>Est. Total: ~{formatPipelineDuration(estimatedSeconds)}</span>
            </div>
          )}

          {isRunning && onStop && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onStop}
              className="gap-1.5 border-red-200 bg-red-50/80 hover:bg-red-100 hover:border-red-300 text-red-700 font-semibold text-xs h-8 px-3 rounded-lg shadow-sm whitespace-nowrap transition-all"
            >
              <Square className="w-3 h-3 fill-red-600 text-red-600" />
              Stop Pipeline
            </Button>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      <div className="my-6">
        <div className="flex justify-between items-center text-xs font-semibold mb-2">
          <span className="text-gray-700 uppercase tracking-wider">
            Step {displayStepIndex + 1} of {steps.length}: {steps[displayStepIndex].title}
          </span>
          <span className="text-orange-600 font-bold">{percent}%</span>
        </div>
        <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden p-0.5 border border-gray-200/60">
          <div
            className="h-full bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 rounded-full transition-all duration-700 ease-out shadow-sm"
            style={{ width: `${percent}%` }}
          />
        </div>

        {/* Dropdown Toggle Button below Progress Bar */}
        <div className="flex items-center justify-between mt-3 pt-1 flex-wrap gap-2">
          <button
            type="button"
            onClick={toggleStages}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-800 bg-orange-100/70 hover:bg-orange-100 px-3.5 py-1.5 rounded-lg border border-orange-200 transition-all cursor-pointer shadow-2xs group"
          >
            <span>{isStagesCollapsed ? `View All ${steps.length} Pipeline Stages Details` : 'Hide Pipeline Stages Details'}</span>
            <ChevronDown className={cn('w-4 h-4 transition-transform duration-200 text-orange-600 group-hover:text-orange-900', !isStagesCollapsed && 'rotate-180')} />
          </button>

          {targetCount !== undefined && targetCount > 0 && (
            <span className="text-[11px] font-medium text-gray-500 bg-white/80 px-2.5 py-1 rounded-md border border-gray-200/70">
              Live Safe Names: <strong className="text-gray-800">{generatedCount ?? 0}/{targetCount}</strong>
            </span>
          )}
        </div>
      </div>

      {/* Step Checklist */}
      {!isStagesCollapsed && (
        <div className="space-y-3 pt-2 transition-all duration-300">
          {steps.map((step, idx) => {
            const isDone = idx < displayStepIndex;
            const isCurrent = idx === displayStepIndex;

            const isFailedHere = isCurrent && hasFailed;
            const isRejectedHere = isCurrent && hasRejected;

            return (
              <div
                key={step.id}
                className={`flex items-start gap-3.5 p-3.5 rounded-xl border transition-all duration-300 ${
                  isFailedHere || isRejectedHere
                    ? 'bg-red-50/50 border-red-200 shadow-sm'
                    : isCurrent
                    ? 'bg-white border-orange-200 shadow-sm scale-[1.01]'
                    : isDone
                    ? 'bg-green-50/40 border-green-100/60 opacity-90'
                    : 'bg-gray-50/50 border-gray-100 opacity-50'
                }`}
              >
                <div className="mt-0.5 flex-shrink-0">
                  {isFailedHere || isRejectedHere ? (
                    <div className="w-7 h-7 rounded-full bg-red-100 text-red-600 flex items-center justify-center font-bold text-xs">
                      <XCircle className="w-4 h-4" />
                    </div>
                  ) : isDone ? (
                    <div className="w-7 h-7 rounded-full bg-green-100 text-green-700 flex items-center justify-center font-bold text-xs">
                      <CheckCircle className="w-4 h-4" />
                    </div>
                  ) : isCurrent ? (
                    <div className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center font-bold text-xs">
                      <Loader2 className="w-4 h-4 animate-spin" />
                    </div>
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-gray-200/70 text-gray-500 flex items-center justify-center font-semibold text-xs">
                      {step.id}
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className={`text-sm font-semibold ${
                        isFailedHere || isRejectedHere ? 'text-red-700' : isCurrent ? 'text-gray-900' : isDone ? 'text-gray-800' : 'text-gray-500'
                      }`}
                    >
                      {step.title}
                    </p>
                    {isFailedHere ? (
                      <span className="text-[11px] font-semibold text-red-700 bg-red-100 px-2 py-0.5 rounded-full border border-red-200">
                        Failed
                      </span>
                    ) : isRejectedHere ? (
                      <span className="text-[11px] font-semibold text-red-700 bg-red-100 px-2 py-0.5 rounded-full border border-red-200">
                        Rejected
                      </span>
                    ) : isCurrent ? (
                      <span className="text-[11px] font-semibold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full border border-orange-100">
                        In Progress...
                      </span>
                    ) : isDone ? (
                      <span className="text-[11px] font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full border border-green-100">
                        Completed
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{step.subtitle}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Failure/rejection reason — short, human-readable; replaces the
          footer notice so the "why" is the last thing the user reads. */}
      {hasFailed ? (
        <div className="mt-6 pt-4 border-t border-gray-100 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-700">Generation failed</p>
            <p className="text-xs text-red-600 mt-0.5 leading-relaxed">{error}</p>
          </div>
        </div>
      ) : hasRejected ? (
        <div className="mt-6 pt-4 border-t border-gray-100 flex items-start gap-2.5">
          <XCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-700">Rejected at {steps[rejectedAt!.stepIndex].title}</p>
            <p className="text-xs text-red-600 mt-0.5 leading-relaxed">{rejectedAt!.reason}</p>
          </div>
        </div>
      ) : (
        <div className="mt-6 pt-4 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
          <span>{footerText}</span>
          <span className="hidden sm:inline">PharmaBI Safety Verification Engine</span>
        </div>
      )}
    </Card>
  );
}
