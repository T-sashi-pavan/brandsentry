import { useState, useEffect } from 'react';
import {
  Sparkles,
  Save,
  Loader2,
  X,
  Pill,
  Building2,
  Tag,
  AlertCircle,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { apiClient } from '@/api/client';
import {
  cacheFromBackend,
  buildStructuredPayload,
  type BrandCase,
  type NamingCriteria,
} from '@/lib/caseStore';
import { CoiningPrincipleSelect } from '@/components/CreateCaseModal';
import { useQueryClient } from '@tanstack/react-query';

interface EditNamingCriteriaModalProps {
  open: boolean;
  onClose: () => void;
  caseData: BrandCase | null;
  onSaveSuccess?: (updated: BrandCase) => void;
}

export function EditNamingCriteriaModal({
  open,
  onClose,
  caseData,
  onSaveSuccess,
}: EditNamingCriteriaModalProps) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);

  const [treatment, setTreatment] = useState('');
  const [emotionConnected, setEmotionConnected] = useState('');
  const [namingStyle, setNamingStyle] = useState('');
  const [productBenefit, setProductBenefit] = useState('');
  const [coiningPreferences, setCoiningPreferences] = useState('');
  const [description, setDescription] = useState('');

  // Sync state when caseData changes or modal opens
  useEffect(() => {
    if (caseData) {
      const ni = caseData.naming_information || ({} as Partial<NamingCriteria>);
      setTreatment(ni.treatment || caseData.ailment || caseData.therapy || '');
      setEmotionConnected(ni.emotion_connected || '');
      setNamingStyle(ni.naming_style || '');
      setProductBenefit(ni.product_benefit || caseData.promoting_indications || '');
      setCoiningPreferences(ni.brand_coining_preferences || '');
      setDescription(ni.description || caseData.description || '');
    }
  }, [caseData, open]);

  if (!caseData) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!caseData.case_id) {
      toast.error('Cannot update case: Missing Case ID');
      return;
    }

    const updatedNaming: NamingCriteria = {
      treatment: treatment.trim(),
      emotion_connected: emotionConnected.trim(),
      naming_style: namingStyle.trim(),
      product_benefit: productBenefit.trim(),
      brand_coining_preferences: coiningPreferences.trim(),
      description: description.trim(),
    };

    const structuredPayload = buildStructuredPayload(caseData, updatedNaming);
    // Include id for backend deduplication and verification
    const payload = {
      ...structuredPayload,
      id: caseData.case_id,
      description: description.trim(),
    };

    setSaving(true);
    try {
      const res = await apiClient.updateSuggestion(caseData.case_id, payload as any);
      const updatedCase = cacheFromBackend(res);

      qc.invalidateQueries({ queryKey: ['suggestions'] });
      qc.invalidateQueries({ queryKey: ['case-summary'] });

      toast.success(`Naming criteria updated for case ${caseData.case_id}`);
      if (onSaveSuccess) {
        onSaveSuccess(updatedCase);
      }
      onClose();
    } catch (err: any) {
      console.error('Failed to update case naming criteria:', err);
      const detail = err?.response?.data?.detail || 'Failed to update case in database';
      toast.error(detail);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-2xl w-[92vw] max-h-[90vh] flex flex-col p-0 overflow-hidden bg-white shadow-2xl rounded-2xl [&>button:last-child]:hidden border-0">
        {/* Header */}
        <div className="bg-gradient-to-r from-orange-500 to-amber-600 px-6 py-4 text-white flex items-center justify-between flex-shrink-0 gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-lg font-bold text-white flex items-center gap-2 flex-wrap">
                Edit Naming Criteria
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-white/20 px-2 py-0.5 rounded-full text-white/95">
                  Editable Parameters
                </span>
              </DialogTitle>
              <p className="text-xs text-orange-100 mt-0.5 truncate">
                Update naming style, therapeutic coining prompts &amp; emotional attributes
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="hidden sm:inline-block text-xs font-mono font-bold bg-white/20 px-2.5 py-1 rounded-lg">
              {caseData.case_id}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl bg-white/20 hover:bg-white/35 text-white hover:text-white transition-all cursor-pointer flex items-center justify-center shadow-xs"
              title="Close editor"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto flex flex-col justify-between">
          <div className="p-6 space-y-5">
            {/* Read-Only Product Summary Banner */}
            <div className="p-3.5 bg-orange-50/60 border border-orange-200/70 rounded-xl flex flex-wrap items-center gap-4 text-xs text-gray-700">
              <div className="flex items-center gap-1.5">
                <Pill className="w-4 h-4 text-orange-600" />
                <span className="font-bold text-gray-900">{caseData.generic_name || 'Generic Molecule'}</span>
              </div>
              {caseData.division && (
                <div className="flex items-center gap-1.5">
                  <Building2 className="w-4 h-4 text-orange-600" />
                  <span className="font-medium text-gray-700">{caseData.division}</span>
                </div>
              )}
              {caseData.dosage_form && (
                <div className="flex items-center gap-1.5">
                  <Tag className="w-4 h-4 text-orange-600" />
                  <span className="text-gray-600">{caseData.dosage_form} {caseData.dose ? `(${caseData.dose})` : ''}</span>
                </div>
              )}
            </div>

            <div className="flex items-start gap-2 p-2.5 bg-amber-50/80 border border-amber-200/80 rounded-lg text-xs text-amber-900">
              <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <span>
                Per pharmaceutical intake governance, core product specifications are locked. You can edit all <strong>Naming &amp; Coining Criteria</strong> below to re-tune name generation and analysis.
              </span>
            </div>

            {/* Editable Fields Grid */}
            <div className="space-y-4">
              {/* Field 1: Treatment / Indication */}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1 flex items-center gap-1.5">
                  Treatment / Indication
                  <span className="text-[10px] font-normal text-gray-400">(Ailment &amp; therapeutic focus)</span>
                </label>
                <Input
                  value={treatment}
                  onChange={(e) => setTreatment(e.target.value)}
                  placeholder="e.g. Targeted symptomatic relief with high safety margin and fast onset of action"
                  className="text-xs h-9"
                />
              </div>

              {/* Field 2: Emotion Connected */}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1 flex items-center gap-1.5">
                  Emotion Connected
                  <span className="text-[10px] font-normal text-gray-400">(Brand perception &amp; sentiment)</span>
                </label>
                <Input
                  value={emotionConnected}
                  onChange={(e) => setEmotionConnected(e.target.value)}
                  placeholder="e.g. Trust, modern efficacy, professional confidence and therapeutic vitality"
                  className="text-xs h-9"
                />
              </div>

              {/* Field 3: Naming Style — coining-principles multi-select (see CreateCaseModal) */}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1 flex items-center gap-1.5">
                  Naming Style
                  <span className="text-[10px] font-normal text-gray-400">(Coining principles to apply)</span>
                </label>
                <CoiningPrincipleSelect
                  value={namingStyle}
                  onChange={setNamingStyle}
                  form={caseData}
                  hideLabel
                />
              </div>

              {/* Field 4: Product Benefit */}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1 flex items-center gap-1.5">
                  Product Benefit
                  <span className="text-[10px] font-normal text-gray-400">(Key value proposition)</span>
                </label>
                <Input
                  value={productBenefit}
                  onChange={(e) => setProductBenefit(e.target.value)}
                  placeholder="e.g. Rapid relief, sustained therapeutic protection and superior patient compliance"
                  className="text-xs h-9"
                />
              </div>

              {/* Field 5: Additional Notes (was "Brand Coining Preferences") */}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1 flex items-center gap-1.5">
                  Additional Notes
                  <span className="text-[10px] font-normal text-gray-400">(Phonetic &amp; syllable directives, optional)</span>
                </label>
                <Input
                  value={coiningPreferences}
                  onChange={(e) => setCoiningPreferences(e.target.value)}
                  placeholder="e.g. Short, memorable, 2-3 syllables, distinctive vowel cadence"
                  className="text-xs h-9"
                />
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="p-4 bg-gray-50 border-t border-gray-100 flex items-center justify-end gap-2.5 flex-shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
              className="text-xs h-9 px-4 cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold h-9 px-5 gap-1.5 shadow-sm cursor-pointer"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save Changes
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
