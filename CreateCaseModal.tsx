import { useState, useRef, useEffect } from 'react';
import { Pill, Factory, TrendingUp, Globe2, ScrollText, History, Loader2, Target, Eraser, Calendar, FlaskConical, X, ChevronDown, Check, Sparkles, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { apiClient } from '@/api/client';
import caseFormSamplesData from '@/data/caseFormSamples.json';
import {
  saveConfirmedCase,
  buildStructuredPayload,
  type SuggestionForm,
  type BrandCase,
  type NamingCriteria,
  EMPTY_NAMING_CRITERIA,
} from '@/lib/caseStore';

// Shared "Create a Case" intake form, reused as a modal from both the AI
// Name Generator and Brand Analysis pages (per the mock's Create-a-Case
// popup — Sun_Pharma_Screens_V1.2.pptx, slides 3-6). Extracted from the old
// standalone Brand Suggestion Form page, which no longer exists as its own
// route — this modal is now the only way to create a case.
//
// Field requirements (required/optional/conditional, max length, allowed
// character sets) follow the mentor-provided BRD validation table verbatim.

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthISO() {
  return new Date().toISOString().slice(0, 7);
}

function makeInitial(suggestedBy: string): SuggestionForm {
  return {
    generic_name: '', division: '', dosage_form: '', suggested_by: suggestedBy,
    dose: '', date: todayISO(), ailment: '', segment: '', therapy: '',
    promoting_indications: '', mfd_type: '', in_license: '',
    manufacturer_location: '', mfg_for_others_yn: '', mfg_for_others: '',
    marketer_name: '', seller_name: '', parent_brand_owner: '',
    expected_launch_month: '', expected_sale: '',
    dcgi_combination_approved: '', drug_schedule: '',
    domestic_brand_names: '', international_brand_names: '', innovator_brands: '',
    patent_validity: 'Patent Not in India',
    launch_after_expiry: '', launch_after_expiry_month: '',
    launch_during_validity: '', launch_during_validity_arrangement: '',
    inventor_name: '', patient_name: '', place_of_origin: '', other_historical_association: '',
  };
}

const inputCls =
  'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300 placeholder:text-gray-300 disabled:bg-gray-50 disabled:text-gray-400';

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-[11px] text-red-500 mt-1">{message}</p>;
}

function Field({
  label, value, onChange, onBlur, placeholder, type = 'text', required, error, min, max, maxLength, disabled, readOnly,
}: {
  label: string; value: string; onChange: (v: string) => void; onBlur?: () => void;
  placeholder?: string; type?: string; required?: boolean; error?: string; min?: string; max?: string; maxLength?: number; disabled?: boolean; readOnly?: boolean;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-600 mb-1 block">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input
        type={type}
        className={cn(inputCls, error && 'border-red-400 ring-1 ring-red-200')}
        value={value}
        placeholder={placeholder}
        min={min}
        max={max}
        maxLength={maxLength}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      <FieldError message={error} />
    </div>
  );
}

function AreaField({
  label, value, onChange, onBlur, placeholder, required, error, maxLength,
}: {
  label: string; value: string; onChange: (v: string) => void; onBlur?: () => void;
  placeholder?: string; required?: boolean; error?: string; maxLength?: number;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-600 mb-1 block">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <textarea
        className={cn(inputCls, 'resize-y min-h-[64px]', error && 'border-red-400 ring-1 ring-red-200')}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      <FieldError message={error} />
    </div>
  );
}

function SelectField({
  label, value, onChange, onBlur, options, required, error,
}: { label: string; value: string; onChange: (v: string) => void; onBlur?: () => void; options: string[]; required?: boolean; error?: string }) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-600 mb-1 block">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <select
        className={cn(inputCls, error && 'border-red-400 ring-1 ring-red-200')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      >
        <option value="">Select…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <FieldError message={error} />
    </div>
  );
}

// ── Naming Style: coining-principles multi-select ──────────────────────────
// Matches the BRD's 8 mandatory brand name coining principles. Selections
// serialize into the same `naming_style` free-text field the backend/prompt
// builder and every display surface (TrademarkNameDetailModal, "Rationale
// Behind the Name" card, PDF reports) already read as a plain string — so
// nothing downstream needs to change to consume a list instead of text.
type CoiningPrincipleDef = { label: string; description: string };

const COINING_PRINCIPLES: CoiningPrincipleDef[] = [
  { label: 'Molecule Association', description: 'The AI may incorporate an appropriate part or element of the molecule name as a sub-part of the coined brand name, while combining it with other naming elements to create the proposed brand name.' },
  { label: 'Short & Memorable Names', description: 'The AI shall generate short and easy-to-remember brand names where applicable.' },
  { label: 'Common Day-to-Day Words', description: 'The AI may use simple, commonly understood day-to-day words as part of a coined brand name where appropriate.' },
  { label: 'Disease / Therapeutic Association', description: 'The AI may derive naming concepts from the disease, ailment, therapeutic area, or condition addressed by the product.' },
  { label: 'Product Effect / Benefit', description: 'The AI may derive naming concepts from the intended therapeutic effect, product benefit, or outcome associated with the product.' },
  { label: 'Emotional Association', description: 'The AI may derive naming concepts from relevant emotions or perceptions associated with the product, treatment, or intended benefit.' },
  { label: 'International Appeal', description: 'The AI may use suitable words or linguistic elements from different languages to create brand names with an international character.' },
  { label: 'Molecule / Product History', description: 'Where relevant information is available, the AI may derive naming concepts from the history of the molecule or product, such as inventor name, patient name, place of origin, or other relevant historical associations.' },
];

// Returns a disable reason (shown under the option) or null if selectable.
function coiningPrincipleDisabledReason(label: string, form: SuggestionForm): string | null {
  if (label === 'Molecule Association') {
    return form.generic_name.trim() ? null : 'Fill in Generic Name (Product Information) first';
  }
  if (label === 'Disease / Therapeutic Association') {
    return (form.ailment.trim() || form.therapy.trim()) ? null : 'Fill in Ailment or Therapy (Medical Information) first';
  }
  if (label === 'Molecule / Product History') {
    const hasHistory = [form.inventor_name, form.patient_name, form.place_of_origin, form.other_historical_association]
      .some((v) => v.trim());
    return hasHistory ? null : 'Fill in Inventor Name, Patient Name, Place of Origin, or Other Historical Association first';
  }
  return null;
}

function parseSelectedPrinciples(value: string): { selected: string[]; otherText: string } {
  if (!value || !value.trim()) return { selected: [], otherText: '' };
  
  const knownLabels = COINING_PRINCIPLES.map((p) => p.label);
  const selected: string[] = [];
  let otherText = '';

  // Check if "Other" or "Other:" is in the string
  const otherMatch = value.match(/(?:^|,\s*)Other(?::\s*(.*?))?$/i);
  let standardText = value;

  if (otherMatch) {
    selected.push('Other');
    otherText = otherMatch[1] ? otherMatch[1].trim() : '';
    standardText = value.slice(0, otherMatch.index).trim();
    if (standardText.endsWith(',')) standardText = standardText.slice(0, -1).trim();
  }

  // Parse remaining standard parts
  if (standardText) {
    const parts = standardText.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const match = knownLabels.find((lbl) => lbl.toLowerCase() === p.toLowerCase());
      if (match && !selected.includes(match)) {
        selected.push(match);
      } else if (!match && !otherMatch) {
        if (!selected.includes('Other')) {
          selected.push('Other');
          otherText = p;
        }
      }
    }
  }

  return { selected, otherText };
}

function serializeSelectedPrinciples(selected: string[], otherText: string): string {
  const parts = selected.filter((s) => s !== 'Other');
  if (selected.includes('Other')) {
    if (otherText && otherText.trim()) {
      parts.push(`Other: ${otherText.trim()}`);
    } else {
      parts.push('Other');
    }
  }
  return parts.join(', ');
}

export function CoiningPrincipleSelect({
  value,
  onChange,
  onBlur,
  error,
  form,
  hideLabel = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string;
  form: SuggestionForm;
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredPrinciple, setHoveredPrinciple] = useState<{ label: string; description: string; disabledReason?: string | null } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { selected, otherText } = parseSelectedPrinciples(value);
  const [localOtherText, setLocalOtherText] = useState(otherText);

  useEffect(() => {
    setLocalOtherText(otherText);
  }, [otherText]);

  useEffect(() => {
    if (!open) {
      setHoveredPrinciple(null);
      return;
    }
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHoveredPrinciple(null);
        onBlur?.();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, onBlur]);

  function toggle(label: string) {
    const next = selected.includes(label)
      ? selected.filter((s) => s !== label)
      : [...selected, label];
    onChange(serializeSelectedPrinciples(next, localOtherText));
  }

  function handleSelectOther() {
    if (selected.includes('Other')) {
      const next = selected.filter((s) => s !== 'Other');
      setLocalOtherText('');
      onChange(serializeSelectedPrinciples(next, ''));
    } else {
      const next = [...selected, 'Other'];
      onChange(serializeSelectedPrinciples(next, localOtherText));
      setOpen(false);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }

  function handleOtherTextChange(text: string) {
    setLocalOtherText(text);
    const next = selected.includes('Other') ? selected : [...selected, 'Other'];
    onChange(serializeSelectedPrinciples(next, text));
  }

  function removePrinciple(label: string) {
    if (label === 'Other') {
      const next = selected.filter((s) => s !== 'Other');
      setLocalOtherText('');
      onChange(serializeSelectedPrinciples(next, ''));
    } else {
      const next = selected.filter((s) => s !== label);
      onChange(serializeSelectedPrinciples(next, localOtherText));
    }
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    setLocalOtherText('');
    onChange('');
  }

  const standardSelected = selected.filter((s) => s !== 'Other');
  const hasOther = selected.includes('Other');
  const isEmpty = selected.length === 0 && !localOtherText.trim();

  return (
    <div ref={containerRef} className="relative">
      {!hideLabel && (
        <label className="text-xs font-semibold text-gray-600 mb-1 block">
          Naming Style <span className="text-red-500">*</span>
        </label>
      )}

      {/* Dropdown Trigger Box */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'w-full min-h-[42px] px-3 py-1.5 bg-white border border-gray-300 rounded-lg shadow-xs transition-all cursor-pointer flex items-center justify-between gap-2',
          'hover:border-orange-400 hover:bg-orange-50/10 focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-200/70',
          error && 'border-red-400 ring-1 ring-red-200',
          open && 'border-orange-500 ring-2 ring-orange-200/70'
        )}
      >
        {/* Left Side: Selected Badges / Inline Input / Placeholder */}
        <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0 py-0.5">
          {isEmpty && (
            <span className="text-gray-400 text-xs select-none flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-orange-400 shrink-0" />
              Select naming styles or coining principles…
            </span>
          )}

          {standardSelected.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-orange-50 border border-orange-200 text-orange-900 text-xs font-medium shadow-xs"
            >
              <span className="max-w-[170px] truncate" title={item}>{item}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removePrinciple(item);
                }}
                className="hover:bg-orange-200/80 rounded-full p-0.5 text-orange-700 hover:text-orange-950 transition-colors"
                title={`Remove ${item}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}

          {hasOther && (
            <div
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-amber-50 border border-amber-300 text-amber-900 text-xs font-medium shadow-xs max-w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="font-semibold text-amber-950 shrink-0">Other:</span>
              <input
                ref={inputRef}
                type="text"
                value={localOtherText}
                placeholder="Type custom style..."
                maxLength={200}
                onChange={(e) => handleOtherTextChange(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="bg-transparent border-0 p-0 text-xs text-amber-950 placeholder:text-amber-700/50 focus:outline-none focus:ring-0 min-w-[130px] flex-1"
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removePrinciple('Other');
                }}
                className="hover:bg-amber-200/80 rounded-full p-0.5 text-amber-700 hover:text-amber-950 transition-colors shrink-0"
                title="Remove Other"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Right Side: Action Icons & Dropdown Indicator */}
        <div className="flex items-center gap-1 shrink-0 ml-1">
          {!isEmpty && (
            <button
              type="button"
              className="p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors"
              onClick={handleClear}
              title="Clear all selected naming styles"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <div className="w-[1px] h-4 bg-gray-200" />
          <div
            className={cn(
              'text-gray-400 transition-transform duration-200 p-0.5',
              open && 'rotate-180 text-orange-500'
            )}
          >
            <ChevronDown className="w-4 h-4" />
          </div>
        </div>
      </div>

      {/* Popover Dropdown Menu */}
      {open && (
        <TooltipProvider delayDuration={80}>
          <div className="absolute z-50 mt-1.5 w-full bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden flex flex-col">
            <div className="px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wider flex items-center justify-between border-b border-gray-100 bg-gray-50/80">
              <span>Coining Principles</span>
              {selected.length > 0 && (
                <span className="text-orange-600 font-bold normal-case text-xs">
                  {selected.length} selected
                </span>
              )}
            </div>

            <div className="p-1.5 space-y-0.5 overflow-y-auto max-h-64 divide-y divide-gray-50">
              {COINING_PRINCIPLES.map((p) => {
                const disabledReason = coiningPrincipleDisabledReason(p.label, form);
                const checked = selected.includes(p.label);
                return (
                  <Tooltip key={p.label}>
                    <TooltipTrigger asChild>
                      <div
                        onClick={() => !disabledReason && toggle(p.label)}
                        onMouseEnter={() => setHoveredPrinciple({ label: p.label, description: p.description, disabledReason })}
                        onMouseLeave={() => setHoveredPrinciple(null)}
                        className={cn(
                          'flex items-center justify-between gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer transition-colors select-none group',
                          checked
                            ? 'bg-orange-50/80 text-orange-950 font-medium'
                            : 'hover:bg-orange-50/40 text-gray-700',
                          disabledReason && 'opacity-45 cursor-not-allowed hover:bg-transparent'
                        )}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div
                            className={cn(
                              'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                              checked
                                ? 'bg-orange-500 border-orange-500 text-white shadow-xs'
                                : 'border-gray-300 bg-white'
                            )}
                          >
                            {checked && <Check className="w-3 h-3 stroke-[3]" />}
                          </div>
                          <span className="font-semibold text-gray-900 truncate">{p.label}</span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {disabledReason && (
                            <span className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200/80 px-1.5 py-0.5 rounded font-medium">
                              Prerequisite required
                            </span>
                          )}
                          <Info className="w-3.5 h-3.5 text-gray-300 group-hover:text-orange-500 transition-colors" />
                        </div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      align="start"
                      sideOffset={8}
                      className="max-w-xs bg-gray-900 text-white p-3 rounded-lg shadow-2xl border border-gray-800 z-[100] text-xs leading-relaxed"
                    >
                      <div className="font-semibold text-orange-400 mb-1 flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3 text-orange-400" />
                        {p.label}
                      </div>
                      <p className="text-gray-200 text-xs leading-relaxed">{p.description}</p>
                      {disabledReason && (
                        <p className="text-amber-300 text-[11px] mt-2 pt-1.5 border-t border-gray-800">
                          ⚠️ {disabledReason}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                );
              })}

              {/* "Other" Option */}
              <div className="pt-1 mt-0.5 border-t border-gray-100">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      onClick={handleSelectOther}
                      onMouseEnter={() => setHoveredPrinciple({
                        label: 'Other (Custom Naming Style)',
                        description: 'Select this to type your own unique naming style or coining principle directly into the field.',
                      })}
                      onMouseLeave={() => setHoveredPrinciple(null)}
                      className={cn(
                        'flex items-center justify-between gap-2.5 px-2.5 py-2 rounded-lg text-xs cursor-pointer transition-colors select-none group',
                        selected.includes('Other')
                          ? 'bg-amber-50 text-amber-950 font-medium'
                          : 'hover:bg-amber-50/50 text-gray-800'
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <div
                          className={cn(
                            'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                            selected.includes('Other')
                              ? 'bg-amber-600 border-amber-600 text-white shadow-xs'
                              : 'border-gray-300 bg-white'
                          )}
                        >
                          {selected.includes('Other') && <Check className="w-3 h-3 stroke-[3]" />}
                        </div>
                        <span className="font-semibold text-gray-900">
                          Other (Custom Naming Style)
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] font-medium text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded">
                          Type directly
                        </span>
                        <Info className="w-3.5 h-3.5 text-gray-300 group-hover:text-amber-600 transition-colors" />
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    align="start"
                    sideOffset={8}
                    className="max-w-xs bg-gray-900 text-white p-3 rounded-lg shadow-2xl border border-gray-800 z-[100] text-xs leading-relaxed"
                  >
                    <div className="font-semibold text-amber-400 mb-1 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-amber-400" />
                      Custom Naming Style
                    </div>
                    <p className="text-gray-200 text-xs leading-relaxed">
                      Select this to type your own unique naming style or coining principle directly into the field.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* Live Hover Requirement Description Pane */}
            <div className="p-2.5 bg-gray-50/90 border-t border-gray-100 text-xs transition-colors min-h-[58px] flex items-center">
              {hoveredPrinciple ? (
                <div className="w-full animate-in fade-in-0 duration-150">
                  <div className="font-semibold text-gray-900 flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                    <span>{hoveredPrinciple.label}</span>
                  </div>
                  <p className="text-gray-600 text-[11px] mt-0.5 leading-snug">
                    {hoveredPrinciple.description}
                  </p>
                  {hoveredPrinciple.disabledReason && (
                    <p className="text-amber-700 text-[10px] font-medium mt-1">
                      ⚠️ {hoveredPrinciple.disabledReason}
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-gray-400 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <span>Hover over any principle to view requirement description</span>
                </div>
              )}
            </div>
          </div>
        </TooltipProvider>
      )}

      <FieldError message={error} />
    </div>
  );
}

function MonthField({
  label, value, onChange, onBlur, placeholder = 'mm/yyyy', required, min, max, error,
}: { label: string; value: string; onChange: (v: string) => void; onBlur?: () => void; placeholder?: string; required?: boolean; min?: string; max?: string; error?: string }) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const displayValue = value && value.includes('-')
    ? `${value.split('-')[1]}/${value.split('-')[0]}`
    : value || '';

  const handleOpenPicker = () => {
    try {
      pickerRef.current?.showPicker();
    } catch {
      pickerRef.current?.focus();
    }
  };

  return (
    <div>
      <label className="text-xs font-semibold text-gray-600 mb-1 block">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <div className="relative flex items-center">
        <input
          type="text"
          readOnly
          onClick={handleOpenPicker}
          className={cn(inputCls, 'pr-10 cursor-pointer bg-white', !displayValue && 'text-gray-400', error && 'border-red-400 ring-1 ring-red-200')}
          value={displayValue}
          placeholder={placeholder}
          onBlur={onBlur}
        />
        <button
          type="button"
          onClick={handleOpenPicker}
          className="absolute right-2.5 p-1 text-gray-400 hover:text-orange-600 transition-colors cursor-pointer"
          title="Select month and year"
        >
          <Calendar className="w-4 h-4 text-gray-500 hover:text-orange-600" />
        </button>
        <input
          ref={pickerRef}
          type="month"
          className="sr-only"
          value={value}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          tabIndex={-1}
        />
      </div>
      <FieldError message={error} />
    </div>
  );
}

function Section({
  icon: Icon, title, children,
}: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
        <div className="w-7 h-7 rounded-lg bg-orange-100 flex items-center justify-center">
          <Icon className="w-4 h-4 text-orange-600" />
        </div>
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
    </div>
  );
}

// ── Character sets — only the fields the BRD table actually restricts ──────
const CHARSET_GENERIC_NAME = /^[A-Za-z0-9\s/\-.&]*$/;
const CHARSET_DIVISION = /^[A-Za-z0-9\s/\-&]*$/;

type FieldRule = {
  key: keyof SuggestionForm;
  label: string;
  required: boolean;
  maxLength?: number;
  charset?: RegExp;
  charsetHint?: string;
  validate?: (value: string, form: SuggestionForm) => string | null;
};

const FIELD_RULES: FieldRule[] = [
  { key: 'generic_name', label: 'Generic Name', required: true, maxLength: 100, charset: CHARSET_GENERIC_NAME, charsetHint: 'letters, numbers, spaces, /, -, ., &' },
  { key: 'dosage_form', label: 'Dosage Form', required: true, maxLength: 50 },
  { key: 'dose', label: 'Dose', required: false, maxLength: 50 },
  { key: 'division', label: 'Division (DIV)', required: true, maxLength: 50, charset: CHARSET_DIVISION, charsetHint: 'letters, numbers, spaces, /, -, &' },
  { key: 'suggested_by', label: 'Suggested By', required: false, maxLength: 100 },
  {
    key: 'date', label: 'Date', required: false,
    validate: (v) => (v && v > todayISO() ? 'Date cannot be set in the future' : null),
  },
  { key: 'ailment', label: 'Ailment / Curative Action', required: true, maxLength: 500 },
  { key: 'segment', label: 'Segment', required: true, maxLength: 100 },
  { key: 'therapy', label: 'Therapy', required: true, maxLength: 100 },
  { key: 'promoting_indications', label: 'Promoting Indication(s)', required: true, maxLength: 500 },
  { key: 'manufacturer_location', label: 'Product Manufacturer Name & Location', required: false, maxLength: 250 },
  { key: 'mfd_type', label: 'Manufactured In-house or Outsourced?', required: false },
  { key: 'in_license', label: 'Is this an In-License product?', required: false },
  { key: 'mfg_for_others_yn', label: 'Same manufacturer making this for others?', required: false },
  {
    key: 'mfg_for_others', label: 'Marks of Others', required: false, maxLength: 500,
    validate: (v, form) => (form.mfg_for_others_yn === 'Yes' && !v ? 'Marks of others is required when the answer is Yes' : null),
  },
  { key: 'parent_brand_owner', label: 'Owner of Existing Parent Brand', required: false, maxLength: 100 },
  { key: 'marketer_name', label: 'Marketer Name of the Product', required: false, maxLength: 150 },
  { key: 'seller_name', label: "Product Seller's Name", required: false, maxLength: 150 },
  {
    key: 'expected_launch_month', label: 'Expected Launch Month', required: false,
    validate: (v) => (v && v < currentMonthISO() ? 'Launch month cannot be in the past. Choose the current month or later' : null),
  },
  { key: 'expected_sale', label: 'Expected Sale of the Products', required: false, maxLength: 100 },
  { key: 'dcgi_combination_approved', label: 'Is this DCGI Combination Approved?', required: false },
  { key: 'drug_schedule', label: 'Scheduled / Non-Scheduled Drug', required: false },
  { key: 'domestic_brand_names', label: 'Domestic Brand Names', required: false, maxLength: 500 },
  { key: 'international_brand_names', label: 'International Brand Names', required: false, maxLength: 500 },
  { key: 'innovator_brands', label: 'Innovator Brand Names', required: false, maxLength: 500 },
  { key: 'patent_validity', label: 'Patent Status: Expired / Valid Till', required: true, maxLength: 250 },
  { key: 'launch_after_expiry', label: 'Launching After Expiry of Patent?', required: true },
  {
    key: 'launch_after_expiry_month', label: 'Launch Timing (Month/Year)', required: false,
    validate: (v, form) => (form.launch_after_expiry === 'Yes' && !v ? 'Launch timing is required when the answer is Yes' : null),
  },
  { key: 'launch_during_validity', label: 'Launching During Validity of Patent?', required: false },
  {
    key: 'launch_during_validity_arrangement', label: 'Arrangement', required: false, maxLength: 500,
    validate: (v, form) => (form.launch_during_validity === 'Yes' && !v ? 'Arrangement is required when the answer is Yes' : null),
  },
  { key: 'inventor_name', label: 'Inventor Name', required: false, maxLength: 150 },
  { key: 'patient_name', label: 'Patient Name', required: false, maxLength: 150 },
  { key: 'place_of_origin', label: 'Place of Origin', required: false, maxLength: 150 },
  { key: 'other_historical_association', label: 'Other Relevant Historical Association', required: false, maxLength: 500 },
];

function validateField(rule: FieldRule, form: SuggestionForm): string | null {
  const value = String(form[rule.key] ?? '').trim();
  if (rule.required && !value) return `${rule.label} is mandatory`;
  if (value && rule.maxLength && value.length > rule.maxLength) return `${rule.label} must be ${rule.maxLength} characters or fewer`;
  if (value && rule.charset && !rule.charset.test(value)) return `${rule.label} allows only ${rule.charsetHint}`;
  if (rule.validate) return rule.validate(value, form);
  return null;
}

type NamingFieldRule = { key: keyof NamingCriteria; label: string; required: boolean; maxLength: number };

const NAMING_FIELD_RULES: NamingFieldRule[] = [
  { key: 'treatment', label: 'Treatment Approach', required: true, maxLength: 1000 },
  { key: 'emotion_connected', label: 'Emotional Connection', required: true, maxLength: 1000 },
  { key: 'naming_style', label: 'Naming Style', required: true, maxLength: 600 },
  { key: 'product_benefit', label: 'Product Benefit', required: true, maxLength: 1000 },
  { key: 'brand_coining_preferences', label: 'Additional Notes', required: false, maxLength: 1000 },
  { key: 'description', label: 'Additional Naming Instructions', required: false, maxLength: 1000 },
];

function validateNamingField(rule: NamingFieldRule, naming: NamingCriteria): string | null {
  const value = String(naming[rule.key] ?? '').trim();
  if (rule.required && !value) return `${rule.label} is mandatory`;
  if (value && value.length > rule.maxLength) return `${rule.label} must be ${rule.maxLength} characters or fewer`;
  return null;
}

function validateAll(form: SuggestionForm, naming: NamingCriteria): Map<string, string> {
  const errors = new Map<string, string>();
  for (const rule of FIELD_RULES) {
    const message = validateField(rule, form);
    if (message) errors.set(rule.key, message);
  }
  for (const rule of NAMING_FIELD_RULES) {
    const message = validateNamingField(rule, naming);
    if (message) errors.set(`naming.${rule.key}`, message);
  }
  return errors;
}

export interface CreateCaseResult {
  caseRecord: BrandCase;
  namingCriteria: NamingCriteria;
}

export function CreateCaseModal({
  open, onClose, onSuccess, submitLabel = 'Generate Names', suggestedBy,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: (result: CreateCaseResult) => void;
  submitLabel?: string;
  suggestedBy?: string;
}) {
  const [form, setForm] = useState<SuggestionForm>(() => makeInitial(suggestedBy ?? ''));
  const [naming, setNaming] = useState<NamingCriteria>(EMPTY_NAMING_CRITERIA);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const sampleIndexRef = useRef(0);

  const update = (patch: Partial<SuggestionForm>) => setForm((f) => ({ ...f, ...patch }));
  const updateNaming = (patch: Partial<NamingCriteria>) => setNaming((n) => ({ ...n, ...patch }));

  const clearForm = () => {
    setForm(makeInitial(suggestedBy ?? ''));
    setNaming(EMPTY_NAMING_CRITERIA);
    setErrors(new Map());
  };

  const handleFillSample = () => {
    const samples = (caseFormSamplesData as any).samples || [];
    if (!samples.length) return;
    const sample = samples[sampleIndexRef.current % samples.length];
    sampleIndexRef.current += 1;

    const todayStr = new Date().toISOString().slice(0, 10);
    const formSample = { ...sample.form };
    if (formSample.date === '__TODAY__') {
      formSample.date = todayStr;
    }
    if (formSample.expected_launch_month === '__FUTURE_MONTH__') {
      formSample.expected_launch_month = '2027-06';
    }

    setForm({
      ...formSample,
      suggested_by: suggestedBy || formSample.suggested_by || 'Demo User',
    });
    setNaming({ ...sample.naming });
    setErrors(new Map());
    const currentIndex = ((sampleIndexRef.current - 1) % samples.length) + 1;
    toast.success(`Loaded sample (${currentIndex}/${samples.length}): ${sample.label || formSample.generic_name}`);
  };

  const blurValidate = (key: keyof SuggestionForm) => {
    const rule = FIELD_RULES.find((r) => r.key === key);
    if (!rule) return;
    setErrors((prev) => {
      const next = new Map(prev);
      const message = validateField(rule, form);
      if (message) next.set(key, message); else next.delete(key);
      return next;
    });
  };

  const blurValidateNaming = (key: keyof NamingCriteria) => {
    const rule = NAMING_FIELD_RULES.find((r) => r.key === key);
    if (!rule) return;
    setErrors((prev) => {
      const next = new Map(prev);
      const message = validateNamingField(rule, naming);
      if (message) next.set(`naming.${key}`, message); else next.delete(`naming.${key}`);
      return next;
    });
  };

  async function handleSubmit() {
    const fieldErrors = validateAll(form, naming);
    if (fieldErrors.size) {
      setErrors(fieldErrors);
      const firstMessages = Array.from(fieldErrors.values()).slice(0, 3);
      toast.error(
        `${fieldErrors.size} field(s) need attention: ${firstMessages.join('; ')}${fieldErrors.size > 3 ? '…' : ''}`
      );
      return;
    }
    setErrors(new Map());
    const payload = buildStructuredPayload(form, naming);
    setSubmitting(true);
    try {
      const response = await apiClient.saveSuggestion({
        ...payload,
        count: 10,
        id: null,
      });
      const caseId = response?.id ?? response?.case_id;
      if (!caseId) {
        toast.error('Could not save this case right now. Please try again.');
        return;
      }
      const caseRecord = saveConfirmedCase(form, caseId, naming);
      onSuccess({ caseRecord, namingCriteria: naming });
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { detail?: string } } };
      const detail = e?.response?.data?.detail;
      toast.error(e?.response?.status === 409 && detail ? detail : 'Could not save this case right now. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl lg:max-w-5xl xl:max-w-6xl w-[92vw] max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>Brand Suggestion Form</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 pr-2">
          <Section icon={Pill} title="Product Information">
            <Field label="Generic Name" value={form.generic_name} onChange={(v) => update({ generic_name: v })} onBlur={() => blurValidate('generic_name')} placeholder="e.g. Paracetamol" required maxLength={100} error={errors.get('generic_name')} />
            <Field label="Dosage Form" value={form.dosage_form} onChange={(v) => update({ dosage_form: v })} onBlur={() => blurValidate('dosage_form')} placeholder="e.g. Tablet, Syrup, Injection" required maxLength={50} error={errors.get('dosage_form')} />
            <Field label="Dose" value={form.dose} onChange={(v) => update({ dose: v })} onBlur={() => blurValidate('dose')} placeholder="e.g. 500 mg" maxLength={50} error={errors.get('dose')} />
            <Field label="Division (DIV)" value={form.division} onChange={(v) => update({ division: v })} onBlur={() => blurValidate('division')} required maxLength={50} error={errors.get('division')} />
            <Field label="Suggested By" value={form.suggested_by} onChange={(v) => update({ suggested_by: v })} onBlur={() => blurValidate('suggested_by')} maxLength={100} error={errors.get('suggested_by')} />
            <Field label="Date" type="date" value={todayISO()} onChange={() => {}} disabled readOnly />
          </Section>

          <Section icon={TrendingUp} title="Medical Information">
            <Field label="Ailment / Curative Action" value={form.ailment} onChange={(v) => update({ ailment: v })} onBlur={() => blurValidate('ailment')} required maxLength={500} error={errors.get('ailment')} />
            <Field label="Segment" value={form.segment} onChange={(v) => update({ segment: v })} onBlur={() => blurValidate('segment')} required maxLength={100} error={errors.get('segment')} />
            <Field label="Therapy" value={form.therapy} onChange={(v) => update({ therapy: v })} onBlur={() => blurValidate('therapy')} required maxLength={100} error={errors.get('therapy')} />
            <AreaField label="Promoting Indication(s)" value={form.promoting_indications} onChange={(v) => update({ promoting_indications: v })} onBlur={() => blurValidate('promoting_indications')} required maxLength={500} error={errors.get('promoting_indications')} />
          </Section>

          <Section icon={Factory} title="Manufacturing Information">
            <Field label="Product Manufacturer Name & Location" value={form.manufacturer_location} onChange={(v) => update({ manufacturer_location: v })} onBlur={() => blurValidate('manufacturer_location')} maxLength={250} error={errors.get('manufacturer_location')} />
            <SelectField label="Manufactured In-house or Outsourced?" value={form.mfd_type} onChange={(v) => update({ mfd_type: v })} onBlur={() => blurValidate('mfd_type')} options={['In-house', 'Outsourced']} error={errors.get('mfd_type')} />
            <SelectField label="Is this an In-License product?" value={form.in_license} onChange={(v) => update({ in_license: v })} onBlur={() => blurValidate('in_license')} options={['Yes', 'No']} error={errors.get('in_license')} />
            <SelectField label="Same manufacturer making this for others?" value={form.mfg_for_others_yn} onChange={(v) => update({ mfg_for_others_yn: v })} onBlur={() => blurValidate('mfg_for_others_yn')} options={['Yes', 'No']} error={errors.get('mfg_for_others_yn')} />
            <div className="md:col-span-2">
              <AreaField label="Marks of Others (required if Same Manufacturer = Yes)" value={form.mfg_for_others} onChange={(v) => update({ mfg_for_others: v })} onBlur={() => blurValidate('mfg_for_others')} required={form.mfg_for_others_yn === 'Yes'} maxLength={500} error={errors.get('mfg_for_others')} />
            </div>
            <Field label="Owner of Existing Parent Brand" value={form.parent_brand_owner} onChange={(v) => update({ parent_brand_owner: v })} onBlur={() => blurValidate('parent_brand_owner')} maxLength={100} error={errors.get('parent_brand_owner')} />
          </Section>

          <Section icon={TrendingUp} title="Commercial Information">
            <Field label="Marketer Name of the Product" value={form.marketer_name} onChange={(v) => update({ marketer_name: v })} onBlur={() => blurValidate('marketer_name')} maxLength={150} error={errors.get('marketer_name')} />
            <Field label="Product Seller's Name" value={form.seller_name} onChange={(v) => update({ seller_name: v })} onBlur={() => blurValidate('seller_name')} maxLength={150} error={errors.get('seller_name')} />
            <MonthField
              label="Expected Launch Month" value={form.expected_launch_month}
              onChange={(v) => update({ expected_launch_month: v })} onBlur={() => blurValidate('expected_launch_month')}
              min={currentMonthISO()} error={errors.get('expected_launch_month')}
            />
            <Field label="Expected Sale of the Products" value={form.expected_sale} onChange={(v) => update({ expected_sale: v })} onBlur={() => blurValidate('expected_sale')} placeholder="e.g. ₹ 5 Cr / year" maxLength={100} error={errors.get('expected_sale')} />
          </Section>

          <Section icon={ScrollText} title="Regulatory Information">
            <SelectField label="Is this DCGI Combination Approved?" value={form.dcgi_combination_approved} onChange={(v) => update({ dcgi_combination_approved: v })} onBlur={() => blurValidate('dcgi_combination_approved')} options={['Yes', 'No']} error={errors.get('dcgi_combination_approved')} />
            <SelectField label="Scheduled / Non-Scheduled Drug" value={form.drug_schedule} onChange={(v) => update({ drug_schedule: v })} onBlur={() => blurValidate('drug_schedule')} options={['Scheduled', 'Non-Scheduled']} error={errors.get('drug_schedule')} />
          </Section>

          <Section icon={Globe2} title="Brand Information">
            <AreaField label="Domestic Brand Names" value={form.domestic_brand_names} onChange={(v) => update({ domestic_brand_names: v })} onBlur={() => blurValidate('domestic_brand_names')} maxLength={500} error={errors.get('domestic_brand_names')} />
            <AreaField label="International Brand Names" value={form.international_brand_names} onChange={(v) => update({ international_brand_names: v })} onBlur={() => blurValidate('international_brand_names')} maxLength={500} error={errors.get('international_brand_names')} />
            <AreaField label="Innovator Brand Names" value={form.innovator_brands} onChange={(v) => update({ innovator_brands: v })} onBlur={() => blurValidate('innovator_brands')} maxLength={500} error={errors.get('innovator_brands')} />
          </Section>

          <Section icon={ScrollText} title="Patent Information">
            <Field label="Patent Status: Expired / Valid Till" value={form.patent_validity} onChange={(v) => update({ patent_validity: v })} onBlur={() => blurValidate('patent_validity')} required maxLength={250} error={errors.get('patent_validity')} />
            <SelectField label="Launching After Expiry of Patent?" value={form.launch_after_expiry} onChange={(v) => update({ launch_after_expiry: v })} onBlur={() => blurValidate('launch_after_expiry')} options={['Yes', 'No', 'NA']} required error={errors.get('launch_after_expiry')} />
            <MonthField
              label="Launch Timing (required if Yes above)" value={form.launch_after_expiry_month}
              onChange={(v) => update({ launch_after_expiry_month: v })} onBlur={() => blurValidate('launch_after_expiry_month')}
              required={form.launch_after_expiry === 'Yes'} error={errors.get('launch_after_expiry_month')}
            />
            <SelectField label="Launching During Validity of Patent?" value={form.launch_during_validity} onChange={(v) => update({ launch_during_validity: v })} onBlur={() => blurValidate('launch_during_validity')} options={['Yes', 'No', 'NA']} error={errors.get('launch_during_validity')} />
            <div className="md:col-span-2">
              <AreaField label="Arrangement (required if Launching During Validity = Yes)" value={form.launch_during_validity_arrangement} onChange={(v) => update({ launch_during_validity_arrangement: v })} onBlur={() => blurValidate('launch_during_validity_arrangement')} required={form.launch_during_validity === 'Yes'} maxLength={500} error={errors.get('launch_during_validity_arrangement')} />
            </div>
          </Section>

          {/* Molecule / Product History */}
          <Section icon={History} title="Molecule / Product History">
            <Field label="Inventor Name" value={form.inventor_name} onChange={(v) => update({ inventor_name: v })} onBlur={() => blurValidate('inventor_name')} maxLength={150} error={errors.get('inventor_name')} />
            <Field label="Patient Name" value={form.patient_name} onChange={(v) => update({ patient_name: v })} onBlur={() => blurValidate('patient_name')} maxLength={150} error={errors.get('patient_name')} />
            <Field label="Place of Origin" value={form.place_of_origin} onChange={(v) => update({ place_of_origin: v })} onBlur={() => blurValidate('place_of_origin')} maxLength={150} error={errors.get('place_of_origin')} />
            <div className="md:col-span-2">
              <AreaField label="Other Relevant Historical Association" value={form.other_historical_association} onChange={(v) => update({ other_historical_association: v })} onBlur={() => blurValidate('other_historical_association')} maxLength={500} error={errors.get('other_historical_association')} />
            </div>
          </Section>

          {/* Naming Criteria — feeds AI Name Generator refinement. */}
          <Section icon={Target} title="Naming Criteria">
            <Field label="Treatment Approach" value={naming.treatment} onChange={(v) => updateNaming({ treatment: v })} onBlur={() => blurValidateNaming('treatment')} placeholder="e.g. Rapid pain relief" required maxLength={1000} error={errors.get('naming.treatment')} />
            <Field label="Emotional Connection" value={naming.emotion_connected} onChange={(v) => updateNaming({ emotion_connected: v })} onBlur={() => blurValidateNaming('emotion_connected')} placeholder="e.g. Relief, Comfort, Freedom of Movement" required maxLength={1000} error={errors.get('naming.emotion_connected')} />
            <CoiningPrincipleSelect value={naming.naming_style} onChange={(v) => updateNaming({ naming_style: v })} onBlur={() => blurValidateNaming('naming_style')} error={errors.get('naming.naming_style')} form={form} />
            <Field label="Product Benefit" value={naming.product_benefit} onChange={(v) => updateNaming({ product_benefit: v })} onBlur={() => blurValidateNaming('product_benefit')} placeholder="e.g. Faster onset of action, improved compliance" required maxLength={1000} error={errors.get('naming.product_benefit')} />
            <div className="md:col-span-2">
              <AreaField label="Additional Notes" value={naming.brand_coining_preferences} onChange={(v) => updateNaming({ brand_coining_preferences: v })} onBlur={() => blurValidateNaming('brand_coining_preferences')} placeholder="e.g. Avoid molecule-derived stems, prefer 2-3 syllable coined words" maxLength={1000} error={errors.get('naming.brand_coining_preferences')} />
            </div>
          </Section>

          {/* Buttons live at the natural end of the scrollable form content,
              not pinned to the bottom of the dialog — matching the mock
              (Sun_Pharma_Screens_V1.2, slide 6), which only shows them once
              the user has actually scrolled to the end of the form. */}
          <div className="flex items-center justify-start gap-3 pt-4 border-t border-gray-100 flex-wrap">
            <Button
              type="button"
              variant="outline"
              className="h-10 px-4 gap-2 text-sm font-medium border-orange-200 text-orange-600 hover:bg-orange-50 shadow-sm"
              onClick={handleFillSample}
              title="Populate form with random realistic sample clinical profile"
            >
              <FlaskConical className="w-4 h-4 text-orange-600" /> Fill Sample
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-10 px-4 gap-2 text-sm font-medium border-gray-200 text-gray-700 hover:bg-gray-50 shadow-sm"
              onClick={clearForm}
            >
              <Eraser className="w-4 h-4 text-gray-500" /> Clear
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-10 px-4 text-sm font-medium border-gray-200 text-gray-700 hover:bg-gray-50 shadow-sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="h-10 px-5 gap-2 text-sm font-medium bg-orange-600 hover:bg-orange-700 text-white shadow-sm"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
