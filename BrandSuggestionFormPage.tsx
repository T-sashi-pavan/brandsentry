import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import {
  FileText, Save, Sparkles, Pill, Factory,
  TrendingUp, Globe2, ScrollText, CheckCircle2, Loader2, AlertTriangle, Calendar, FlaskConical,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
import { useActiveCase } from '@/contexts/ActiveCaseContext';
import { useSectionNav, type SectionTab } from '@/contexts/SectionNavContext';
import { cn, formatDate } from '@/lib/utils';
import { apiClient } from '@/api/client';
import caseFormSamplesData from '@/data/caseFormSamples.json';
import { saveConfirmedCase, buildStructuredPayload, type SuggestionForm } from '@/lib/caseStore';
import type { StructuredSuggestionPayload } from '@/types';

// ── Form shape ───────────────────────────────────────────────────────────────

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
    manufacturer_location: 'NA', mfg_for_others_yn: '', mfg_for_others: '', marketer_name: '',
    seller_name: '', parent_brand_owner: '', expected_launch_month: '',
    expected_sale: '', dcgi_combination_approved: '', drug_schedule: '',
    domestic_brand_names: '', international_brand_names: '', innovator_brands: '',
    patent_validity: 'Patent Not in India', launch_after_expiry: 'No', launch_after_expiry_month: '',
    launch_during_validity: '', launch_during_validity_arrangement: '',
    inventor_name: '', patient_name: '', place_of_origin: '', other_historical_association: '',
  };
}

// ── Field primitives ─────────────────────────────────────────────────────────

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

function MonthField({
  label, value, onChange, onBlur, placeholder = 'mm/yyyy', required, min, max, error,
}: {
  label: string; value: string; onChange: (v: string) => void; onBlur?: () => void;
  placeholder?: string; required?: boolean; min?: string; max?: string; error?: string;
}) {
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

function AreaField({
  label, value, onChange, onBlur, placeholder, required, error,
}: { label: string; value: string; onChange: (v: string) => void; onBlur?: () => void; placeholder?: string; required?: boolean; error?: string }) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-600 mb-1 block">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <textarea
        className={cn(inputCls, 'resize-y min-h-[64px]', error && 'border-red-400 ring-1 ring-red-200')}
        value={value}
        placeholder={placeholder}
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

function Section({
  icon: Icon, title, mandatory, children,
}: { icon: React.ElementType; title: string; mandatory?: boolean; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
        <div className="w-7 h-7 rounded-lg bg-orange-100 flex items-center justify-center">
          <Icon className="w-4 h-4 text-orange-600" />
        </div>
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
        <span className={cn(
          'ml-auto text-[10px] font-bold uppercase px-2 py-0.5 rounded-full',
          mandatory ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500',
        )}>
          {mandatory ? 'Mandatory' : 'Required if available'}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
    </div>
  );
}

// Default candidate count sent with a generate request from this page —
// there's no count input here (that's the AI Generator page's own field),
// so this mirrors that page's default until/unless product wants a
// dedicated control here too.
const DEFAULT_GENERATE_COUNT = 10;

// Registered with SectionNavContext so TopNav can render these as a
// desktop-only tab bar that jumps to (and highlights) each section below.
const SECTION_TABS: SectionTab[] = [
  { key: 'product', label: 'Product' },
  { key: 'medical', label: 'Medical' },
  { key: 'manufacturing', label: 'Manufacturing' },
  { key: 'commercial', label: 'Commercial' },
  { key: 'regulatory', label: 'Regulatory' },
  { key: 'brand', label: 'Brand' },
  { key: 'patent', label: 'Patent' },
];

// Confirmation popup shown after Save/Generate — always shows the exact
// payload the backend was (or would be) sent, but never the case_id itself:
// per backend team feedback, case_id is issued by the backend, not
// something the frontend should invent or echo back as if it owns it.
function PayloadDialog({
  open, onClose, title, connected, note, payload,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  connected: boolean;
  note: string;
  payload: unknown;
}) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {connected
              ? <CheckCircle2 className="w-5 h-5 text-green-600" />
              : <AlertTriangle className="w-5 h-5 text-orange-500" />}
            {title}
          </DialogTitle>
        </DialogHeader>
        <p className={cn('text-sm -mt-2', connected ? 'text-green-700' : 'text-orange-600')}>{note}</p>
        <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs overflow-auto max-h-96 whitespace-pre-wrap break-words">
          {JSON.stringify(payload, null, 2)}
        </pre>
        <Button onClick={onClose} className="w-full">Close</Button>
      </DialogContent>
    </Dialog>
  );
}

// Simple confirmation popup for Save — just the outcome, no payload dump.
function SaveResultDialog({
  open, onClose, connected, caseId,
}: {
  open: boolean;
  onClose: () => void;
  connected: boolean;
  caseId: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm text-center">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-center gap-2">
            {connected
              ? <CheckCircle2 className="w-5 h-5 text-green-600" />
              : <AlertTriangle className="w-5 h-5 text-orange-500" />}
            {connected ? 'Form data is saved' : 'Could not save right now'}
          </DialogTitle>
        </DialogHeader>
        <p className={cn('text-sm', connected ? 'text-green-700' : 'text-orange-600')}>
          {connected
            ? `Case ID generated: ${caseId}`
            : 'Please try again in a moment.'}
        </p>
        <Button onClick={onClose} className="w-full">Close</Button>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

// Per-field validation rules. `required` drives the Mandatory/Optional badge
// and the "field is missing" check; `validate` runs whenever the field has a
// value (or always, for required fields) and returns an error message or
// null. This is the single source of truth for whether a field is mandatory
// and what "valid" means for it — every field in the form is listed here.
type FieldRule = {
  key: keyof SuggestionForm;
  label: string;
  required: boolean;
  validate?: (value: string, form: SuggestionForm) => string | null;
};

const FIELD_RULES: FieldRule[] = [
  // Product Information — Mandatory
  { key: 'generic_name', label: 'Generic Name', required: true },
  { key: 'dosage_form', label: 'Dosage Form', required: true },
  { key: 'dose', label: 'Dose', required: true },
  { key: 'division', label: 'Division (DIV)', required: false },
  { key: 'suggested_by', label: 'Suggested By', required: false },
  {
    key: 'date', label: 'Date', required: true,
    validate: (v) => (v && v > todayISO() ? 'Date cannot be set in the future' : null),
  },
  // Medical Information — Mandatory
  { key: 'ailment', label: 'Ailment / Curative Action', required: true },
  { key: 'segment', label: 'Segment', required: true },
  { key: 'therapy', label: 'Therapy', required: true },
  { key: 'promoting_indications', label: 'Promoting Indications', required: true },
  // Manufacturing Information — Required if available
  { key: 'manufacturer_location', label: 'Product Manufacturer Name & Location', required: false },
  { key: 'mfd_type', label: 'Manufactured In-house or Outsourced?', required: false },
  { key: 'in_license', label: 'Is this an In-License product?', required: false },
  { key: 'mfg_for_others', label: 'Same manufacturer making this for others?', required: false },
  { key: 'parent_brand_owner', label: 'Owner of existing parent Brand', required: false },
  // Commercial Information — Required if available
  { key: 'marketer_name', label: 'Marketer Name of the Product', required: false },
  { key: 'seller_name', label: "Product Seller's Name", required: false },
  {
    key: 'expected_launch_month', label: 'Expected Launch Month', required: false,
    validate: (v) => (v && v < currentMonthISO() ? 'Launch month cannot be in the past. Choose the current month or later' : null),
  },
  { key: 'expected_sale', label: 'Expected Sale of the Products', required: false },
  // Regulatory Information — Required if available
  { key: 'dcgi_combination_approved', label: 'Is this DCGI Combination Approved?', required: false },
  { key: 'drug_schedule', label: 'Scheduled / Non-Scheduled Drug', required: false },
  // Brand Information — Mandatory
  { key: 'domestic_brand_names', label: 'Domestic Brand Names', required: true },
  { key: 'international_brand_names', label: 'International Brand Names', required: true },
  { key: 'innovator_brands', label: 'Innovator Brands', required: true },
  // Patent Information — Mandatory
  { key: 'patent_validity', label: 'Patent Status / Expiry', required: true },
  {
    key: 'launch_after_expiry', label: 'Launch Timing Relative to Patent Expiry', required: true,
  },
  { key: 'launch_during_validity', label: 'Launch During Patent Validity', required: false },
];

function validateField(rule: FieldRule, form: SuggestionForm): string | null {
  const value = String(form[rule.key] ?? '').trim();
  if (rule.required && !value) return `${rule.label} is mandatory`;
  if (rule.validate) return rule.validate(value, form);
  return null;
}

function validateAll(form: SuggestionForm): Map<string, string> {
  const errors = new Map<string, string>();
  for (const rule of FIELD_RULES) {
    const message = validateField(rule, form);
    if (message) errors.set(rule.key, message);
  }
  return errors;
}

export function BrandSuggestionFormPage() {
  const { user } = useAuth();
  const { setActiveCase } = useActiveCase();
  const { register, unregister, setActiveKey } = useSectionNav();
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const router = useRouter();
  const [form, setForm] = useState<SuggestionForm>(() => makeInitial(user?.full_name ?? ''));
  // Only ever set from a real backend response (see saveConfirmedCase) —
  // never fabricated client-side. Case ID creation is the backend's job.
  const [savedCaseId, setSavedCaseId] = useState<string | null>(null);
  // Snapshot of the structured payload as of the last successful save —
  // lets us tell the backend "this is the same submission" (via `id` in
  // the request) so it can reuse savedCaseId instead of creating a
  // duplicate row when Save and Generate Names are both clicked without
  // the form changing in between.
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState<string | null>(null);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [savePopup, setSavePopup] = useState<{ connected: boolean; caseId: string | null } | null>(null);
  const [generatePopup, setGeneratePopup] = useState<{ payload: unknown } | null>(null);

  // True while a click-triggered smooth scroll is in flight — the scroll-spy
  // observer below ignores updates during this window so the tab the user
  // just clicked stays highlighted for the whole animation instead of
  // flickering to whichever section briefly passes the observer's band
  // mid-scroll.
  const suppressSpyRef = useRef(false);

  // Register this page's sections as top-bar tabs, default to the first one,
  // and unregister on unmount so they don't linger when navigating to the
  // Generator page.
  useEffect(() => {
    register(SECTION_TABS, (key) => {
      setActiveKey(key);
      suppressSpyRef.current = true;
      sectionRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => { suppressSpyRef.current = false; }, 700);
    });
    setActiveKey(SECTION_TABS[0].key);
    return () => unregister();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll-spy: highlight whichever section's top is closest to the top of
  // the viewport as the active tab. IntersectionObserver's root defaults to
  // the viewport, so this works correctly regardless of which ancestor
  // element is actually scrolling (AppLayout's <main>, not window).
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (suppressSpyRef.current) return;
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const key = visible[0]?.target.getAttribute('data-section-key');
        if (key) setActiveKey(key);
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: 0 }
    );
    Object.values(sectionRefs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const update = (patch: Partial<SuggestionForm>) => {
    setForm((f) => ({ ...f, ...patch }));
  };

  // Re-validate a single field on blur so mistakes surface immediately,
  // without waiting for a full-form submit attempt.
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

  // Returns the structured payload if the form is valid, or null (and sets
  // field errors) if not. Shared by both Save and Generate.
  function validateAndBuildPayload(): StructuredSuggestionPayload | null {
    const fieldErrors = validateAll(form);
    if (fieldErrors.size) {
      setErrors(fieldErrors);
      const firstMessages = Array.from(fieldErrors.values()).slice(0, 3);
      toast.error(
        `${fieldErrors.size} field(s) need attention: ${firstMessages.join('; ')}${fieldErrors.size > 3 ? '…' : ''}`
      );
      return null;
    }
    setErrors(new Map());
    return buildStructuredPayload(form);
  }

  // Shared request body for both Save and Generate Names — per backend
  // team direction (2026-08-12) both buttons hit the same POST /suggestions
  // endpoint, since both are fundamentally "save this intake to the DB."
  // `id` is included so the backend can dedupe: it's only populated when
  // the payload is byte-for-byte identical to the last successful save, so
  // clicking Save then Generate Names (without editing the form in between)
  // reuses the same case instead of creating a duplicate row.
  function buildSuggestionRequest(payload: StructuredSuggestionPayload) {
    const snapshot = JSON.stringify(payload);
    const unchangedSinceLastSave = savedCaseId !== null && snapshot === lastSavedSnapshot;
    return {
      ...payload,
      count: DEFAULT_GENERATE_COUNT,
      id: unchangedSinceLastSave ? savedCaseId : null,
      user_id: user?.id,
      user_email: user?.email,
    };
  }

  // Records a backend-confirmed case locally: remembers it for dedup and
  // persists it for the case selector. Does NOT touch the shared top-bar
  // case-context — that's only set right before navigating to the
  // Generator page (see handleGenerate), so it never shows on this page.
  function markCaseConfirmed(caseId: string, payload: StructuredSuggestionPayload) {
    setSavedCaseId(caseId);
    setLastSavedSnapshot(JSON.stringify(payload));
    saveConfirmedCase(form, caseId);
  }

  // Save = ask the backend to save this intake to the DB. The endpoint
  // (POST /suggestions) doesn't exist on the backend yet, so this
  // currently fails — the popup still opens either way, but only claims
  // "saved" once the backend actually confirms an id.
  async function handleSubmit() {
    const payload = validateAndBuildPayload();
    if (!payload) return;
    const request = buildSuggestionRequest(payload);
    setIsSaving(true);
    try {
      const response = await apiClient.saveSuggestion(request);
      const caseId = response?.id ?? response?.case_id;
      if (caseId) {
        markCaseConfirmed(caseId, payload);
        setSavePopup({ connected: true, caseId });
      } else {
        setSavePopup({ connected: false, caseId: null });
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 409 || detail) {
        toast.error(detail || 'A case with this molecule already exists.');
      } else {
        setSavePopup({ connected: false, caseId: null });
      }
    } finally {
      setIsSaving(false);
    }
  }

  // Generate Names (on this page) = save this intake to the DB via the
  // same /suggestions endpoint, then hand off to the AI Generator page —
  // it does NOT call /brands/generate itself; that only happens once the
  // user is on the Generator page and clicks its own Generate Names
  // button. Navigation only happens once the backend actually confirms an
  // id — otherwise there's no real case to hand off to, so we just show
  // what was sent instead of pretending a case was created. Only here
  // (not in handleSubmit) do we push into the shared case-context, since
  // that's what drives the Generator page's top-bar display.
  async function handleGenerate() {
    const payload = validateAndBuildPayload();
    if (!payload) return;
    const request = buildSuggestionRequest(payload);
    setIsGenerating(true);
    try {
      const response = await apiClient.saveSuggestion(request);
      const caseId = response?.id ?? response?.case_id;
      if (caseId) {
        markCaseConfirmed(caseId, payload);
        setActiveCase({
          caseId,
          createdBy: user?.full_name || 'You',
          createdAt: formatDate(new Date().toISOString()),
        });
        router.push(`/generator?case=${encodeURIComponent(caseId)}`);
        return;
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 409 || detail) {
        toast.error(detail || 'A case with this molecule already exists.');
        return;
      }
      /* backend not connected yet, or the call failed — fall through to the preview popup below either way */
    } finally {
      setIsGenerating(false);
    }
    setGeneratePopup({ payload: request });
  }

  const sampleIndexRef = useRef(0);

  function handleFillSample() {
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
      suggested_by: user?.full_name || formSample.suggested_by || 'Demo User',
    });
    setErrors(new Map());
    const currentIndex = ((sampleIndexRef.current - 1) % samples.length) + 1;
    toast.success(`Loaded sample (${currentIndex}/${samples.length}): ${sample.label || formSample.generic_name}`);
  }

  function handleReset() {
    setForm(makeInitial(user?.full_name ?? ''));
    setErrors(new Map());
    setSavedCaseId(null);
    setLastSavedSnapshot(null);
    setActiveCase(null);
  }

  return (
    <div className="min-h-screen bg-[#fffaf5]">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-6">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <div className="w-10 h-10 bg-orange-100 rounded-xl flex items-center justify-center">
            <FileText className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Brand Name Suggestion Form</h1>
            <p className="text-gray-500 text-sm">Product intake, captured before brand name screening & generation</p>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {savedCaseId && (
          <div className="rounded-xl border border-green-200 bg-green-50 p-4 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-green-800">Form saved for "{form.generic_name}"</p>
                <span className="text-xs font-bold bg-green-600 text-white px-2 py-0.5 rounded-full font-mono">
                  {savedCaseId}
                </span>
              </div>
              <p className="text-xs text-green-600 mt-1">
                Use this Case ID in the AI Name Generator to continue this product's workflow.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Button size="sm" className="gap-1.5 bg-orange-600 hover:bg-orange-700" onClick={handleGenerate} disabled={isGenerating}>
                  {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Generate Names
                </Button>
                <Button size="sm" variant="outline" onClick={handleReset}>New form</Button>
              </div>
            </div>
          </div>
        )}

        {/* 1. Product Information — Mandatory */}
        <div ref={(el) => { sectionRefs.current.product = el; }} data-section-key="product">
          <Section icon={Pill} title="Product Information" mandatory>
            <Field label="Generic Name" value={form.generic_name} onChange={(v) => update({ generic_name: v })} onBlur={() => blurValidate('generic_name')} placeholder="e.g. Paracetamol" required error={errors.get('generic_name')} />
            <Field label="Dosage Form" value={form.dosage_form} onChange={(v) => update({ dosage_form: v })} onBlur={() => blurValidate('dosage_form')} placeholder="e.g. Tablet, Syrup, Injection" required error={errors.get('dosage_form')} />
            <Field label="Dose" value={form.dose} onChange={(v) => update({ dose: v })} onBlur={() => blurValidate('dose')} placeholder="e.g. 500 mg" required maxLength={50} error={errors.get('dose')} />
            <Field label="Division (DIV)" value={form.division} onChange={(v) => update({ division: v })} onBlur={() => blurValidate('division')} error={errors.get('division')} />
            <Field label="Suggested By" value={form.suggested_by} onChange={(v) => update({ suggested_by: v })} onBlur={() => blurValidate('suggested_by')} error={errors.get('suggested_by')} />
            <Field label="Date" type="date" value={todayISO()} onChange={() => {}} disabled readOnly />
          </Section>
        </div>

        {/* 2. Medical Information — Mandatory */}
        <div ref={(el) => { sectionRefs.current.medical = el; }} data-section-key="medical">
          <Section icon={TrendingUp} title="Medical Information" mandatory>
            <Field label="Ailment / Curative Action" value={form.ailment} onChange={(v) => update({ ailment: v })} onBlur={() => blurValidate('ailment')} required error={errors.get('ailment')} />
            <Field label="Segment" value={form.segment} onChange={(v) => update({ segment: v })} onBlur={() => blurValidate('segment')} required error={errors.get('segment')} />
            <Field label="Therapy" value={form.therapy} onChange={(v) => update({ therapy: v })} onBlur={() => blurValidate('therapy')} required error={errors.get('therapy')} />
            <AreaField label="Promoting Indication / s" value={form.promoting_indications} onChange={(v) => update({ promoting_indications: v })} onBlur={() => blurValidate('promoting_indications')} required error={errors.get('promoting_indications')} />
          </Section>
        </div>

        {/* 3. Manufacturing Information — Required if available */}
        <div ref={(el) => { sectionRefs.current.manufacturing = el; }} data-section-key="manufacturing">
          <Section icon={Factory} title="Manufacturing Information">
            <Field label="Product Manufacturer Name & Location" value={form.manufacturer_location} onChange={(v) => update({ manufacturer_location: v })} onBlur={() => blurValidate('manufacturer_location')} error={errors.get('manufacturer_location')} />
            <SelectField label="Manufactured In-house or Outsourced?" value={form.mfd_type} onChange={(v) => update({ mfd_type: v })} onBlur={() => blurValidate('mfd_type')} options={['In-house', 'Outsourced']} error={errors.get('mfd_type')} />
            <SelectField label="Is this an In-License product?" value={form.in_license} onChange={(v) => update({ in_license: v })} onBlur={() => blurValidate('in_license')} options={['Yes', 'No']} error={errors.get('in_license')} />
            <AreaField label="Same manufacturer making this for others? If yes, marks of such others" value={form.mfg_for_others} onChange={(v) => update({ mfg_for_others: v })} onBlur={() => blurValidate('mfg_for_others')} error={errors.get('mfg_for_others')} />
            <SelectField label="Owner of existing parent Brand (Info. by TM team)" value={form.parent_brand_owner} onChange={(v) => update({ parent_brand_owner: v })} onBlur={() => blurValidate('parent_brand_owner')} options={['SPIL', 'SPLL', 'SPML']} error={errors.get('parent_brand_owner')} />
          </Section>
        </div>

        {/* 4. Commercial Information — Required if available */}
        <div ref={(el) => { sectionRefs.current.commercial = el; }} data-section-key="commercial">
          <Section icon={TrendingUp} title="Commercial Information">
            <Field label="Marketer Name of the Product" value={form.marketer_name} onChange={(v) => update({ marketer_name: v })} onBlur={() => blurValidate('marketer_name')} error={errors.get('marketer_name')} />
            <Field label="Product Seller's Name (Info. by Kalpesh)" value={form.seller_name} onChange={(v) => update({ seller_name: v })} onBlur={() => blurValidate('seller_name')} error={errors.get('seller_name')} />
            <MonthField
              label="Expected Launch Month" value={form.expected_launch_month}
              onChange={(v) => update({ expected_launch_month: v })} onBlur={() => blurValidate('expected_launch_month')}
              min={currentMonthISO()} error={errors.get('expected_launch_month')}
            />
            <Field label="Expected Sale of the Products" value={form.expected_sale} onChange={(v) => update({ expected_sale: v })} onBlur={() => blurValidate('expected_sale')} placeholder="e.g. ₹ 5 Cr / year" error={errors.get('expected_sale')} />
          </Section>
        </div>

        {/* 5. Regulatory Information — Required if available */}
        <div ref={(el) => { sectionRefs.current.regulatory = el; }} data-section-key="regulatory">
          <Section icon={ScrollText} title="Regulatory Information">
            <SelectField label="Is this DCGI Combination Approved?" value={form.dcgi_combination_approved} onChange={(v) => update({ dcgi_combination_approved: v })} onBlur={() => blurValidate('dcgi_combination_approved')} options={['Yes', 'No', 'Not Applicable']} error={errors.get('dcgi_combination_approved')} />
            <SelectField label="Scheduled / Non-Scheduled Drug" value={form.drug_schedule} onChange={(v) => update({ drug_schedule: v })} onBlur={() => blurValidate('drug_schedule')} options={['Scheduled', 'Non-Scheduled', 'Schedule H', 'Schedule H1', 'Schedule X']} error={errors.get('drug_schedule')} />
          </Section>
        </div>

        {/* 6. Brand Information — Mandatory */}
        <div ref={(el) => { sectionRefs.current.brand = el; }} data-section-key="brand">
          <Section icon={Globe2} title="Brand Information" mandatory>
            <AreaField label="Domestic Brand Names" value={form.domestic_brand_names} onChange={(v) => update({ domestic_brand_names: v })} onBlur={() => blurValidate('domestic_brand_names')} required error={errors.get('domestic_brand_names')} />
            <AreaField label="International Brand Names" value={form.international_brand_names} onChange={(v) => update({ international_brand_names: v })} onBlur={() => blurValidate('international_brand_names')} required error={errors.get('international_brand_names')} />
            <AreaField label="Innovator Brands Internationally" value={form.innovator_brands} onChange={(v) => update({ innovator_brands: v })} onBlur={() => blurValidate('innovator_brands')} required error={errors.get('innovator_brands')} />
          </Section>
        </div>

        {/* 7. Patent Information — Mandatory */}
        <div ref={(el) => { sectionRefs.current.patent = el; }} data-section-key="patent">
          <Section icon={ScrollText} title="Patent Information" mandatory>
            <Field label="Patent Status: Expired? / Valid till what period" value={form.patent_validity} onChange={(v) => update({ patent_validity: v })} onBlur={() => blurValidate('patent_validity')} required error={errors.get('patent_validity')} />
            <Field label="Launch Timing: launching after expiry of patent? If yes, when?" value={form.launch_after_expiry} onChange={(v) => update({ launch_after_expiry: v })} onBlur={() => blurValidate('launch_after_expiry')} required error={errors.get('launch_after_expiry')} />
            <AreaField label="Launching during validity of patent? If yes, what is the arrangement?" value={form.launch_during_validity} onChange={(v) => update({ launch_during_validity: v })} onBlur={() => blurValidate('launch_during_validity')} error={errors.get('launch_during_validity')} />
          </Section>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center justify-end gap-2 pb-8">
          <Button
            type="button"
            variant="outline"
            className="gap-1.5 text-orange-600 border-orange-200 hover:bg-orange-50"
            onClick={handleFillSample}
            title="Populate form with random realistic sample clinical profile"
          >
            <FlaskConical className="w-4 h-4 text-orange-600" /> Fill Sample
          </Button>
          <Button variant="outline" onClick={handleReset}>Reset</Button>
          <Button variant="outline" className="gap-1.5" onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Suggestion Form
          </Button>
          <Button className="gap-1.5 bg-orange-600 hover:bg-orange-700" onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Generate Names
          </Button>
        </div>
      </div>

      {savePopup && (
        <SaveResultDialog
          open
          onClose={() => setSavePopup(null)}
          connected={savePopup.connected}
          caseId={savePopup.caseId}
        />
      )}

      {generatePopup && (
        <PayloadDialog
          open
          onClose={() => setGeneratePopup(null)}
          title="Generate request payload"
          connected={false}
          note="POST /suggestions isn't implemented on the backend yet, so nothing was saved and there's no case to hand off to the AI Generator. This is exactly what was sent. Once that endpoint returns an id, Generate Names will take you to the AI Generator page automatically."
          payload={generatePopup.payload}
        />
      )}
    </div>
  );
}
