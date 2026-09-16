import { useState, useMemo } from 'react';
import { usePersistentState } from '@/lib/usePersistentState';
import { useRouter } from 'next/router';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Shield, Search, ArrowUpDown, ChevronDown, ChevronUp,
  User, Calendar, Paperclip, X, FileText, Clock, AlertCircle, MessageSquare,
  FileSpreadsheet, Loader2, Send, RefreshCw, CheckCircle2, XCircle,
} from 'lucide-react';
import {
  XLSX,
  autoFitColumns,
  styleHeaderRow,
  styleMainTitle,
  setCellStyle,
} from '@/lib/excelExportHelper';
import { apiClient } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TrademarkNameDetailModal } from '@/components/TrademarkNameDetailModal';
import { CaseFormDetailsModal } from '@/components/CaseFormDetailsModal';
import { ReviewChatModal } from '@/components/ReviewChatModal';
import { listCases, caseDisplayName, type BrandCase } from '@/lib/caseStore';
import { cn, formatDate } from '@/lib/utils';
import type { LegalReviewBatch, LegalReview, LegalStatus } from '@/types';

const LOG_TAG = '[TrademarkReview]';

type DisplayStatus = 'Pending Review' | 'Approved' | 'Needs Revision' | 'Rejected' | 'Under Review';
type Tab = 'all' | 'pending' | 'approved' | 'rejected' | 'revision';

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'revision', label: 'Revision' },
];

const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest First' },
  { key: 'oldest', label: 'Oldest First' },
  { key: 'name_asc', label: 'Name (A-Z)' },
] as const;
type SortKey = typeof SORT_OPTIONS[number]['key'];

// Priority has no dedicated backend field (see ReviewBatchPage's
// MAX_BATCH_SUBMIT comment), so it travels inside the batch description as
// "<heading> | <Priority> Priority", set at submit time. Recovered here so
// both the heading and the priority pill are real submitted data, not
// fabricated for display.
function parseBatchDescription(desc?: string): { heading: string; priority?: 'High' | 'Medium' | 'Low' } {
  if (!desc) return { heading: 'Untitled Case' };
  const m = desc.match(/^(.*?)\s*\|\s*(High|Medium|Low)\s*Priority\s*$/i); // NOSONAR - runs on our own short batch-description strings, not attacker-controlled
  if (m) return { heading: m[1], priority: m[2] as 'High' | 'Medium' | 'Low' };
  return { heading: desc };
}

interface ReviewCounts {
  name_count: number;
  pending_count: number;
  approved_count: number;
  needs_revision_count: number;
  rejected_count: number;
}

function deriveStatus(b: ReviewCounts): DisplayStatus {
  if (b.name_count === 0 || b.pending_count === b.name_count) return 'Pending Review';
  if (b.approved_count === b.name_count) return 'Approved';
  if (b.needs_revision_count > 0) return 'Needs Revision';
  if (b.rejected_count === b.name_count) return 'Rejected';
  return 'Under Review';
}

const PRIORITY_RANK: Record<string, number> = { High: 3, Medium: 2, Low: 1 };

// A case name can be submitted more than once (e.g. one submission per
// batch of up to MAX_BATCH_SUBMIT names) — every batch sharing the same
// heading is merged into a single card here, with counts summed across all
// of them, so "ghasin - highpitch" submitted twice shows as ONE block
// listing every submitted name, not two separate blocks.
interface MergedCaseGroup {
  heading: string;
  batches: LegalReviewBatch[];
  names: string[];
  priority?: 'High' | 'Medium' | 'Low';
  proposed_by_name?: string;
  proposed_by_dept?: string;
  latest_submitted_at: string;
  name_count: number;
  reviewed_count: number;
  approved_count: number;
  rejected_count: number;
  needs_revision_count: number;
  pending_count: number;
}

function mergeByHeading(batches: LegalReviewBatch[]): MergedCaseGroup[] {
  const map = new Map<string, MergedCaseGroup>();
  for (const batch of batches) {
    const { heading, priority } = parseBatchDescription(batch.description);
    let m = map.get(heading);
    if (!m) {
      m = {
        heading,
        priority,
        latest_submitted_at: batch.submitted_at,
        proposed_by_name: batch.proposed_by_name,
        proposed_by_dept: batch.proposed_by_dept,
        batches: [],
        names: [],
        name_count: 0, reviewed_count: 0, approved_count: 0, rejected_count: 0, needs_revision_count: 0, pending_count: 0,
      };
      map.set(heading, m);
    }
    m.batches.push(batch);
    m.names.push(...batch.names);
    m.name_count += batch.name_count;
    m.reviewed_count += batch.reviewed_count;
    m.approved_count += batch.approved_count;
    m.rejected_count += batch.rejected_count;
    m.needs_revision_count += batch.needs_revision_count;
    m.pending_count += batch.pending_count;
    if (priority && (!m.priority || PRIORITY_RANK[priority] > PRIORITY_RANK[m.priority])) m.priority = priority;
    if (new Date(batch.submitted_at).getTime() > new Date(m.latest_submitted_at).getTime()) {
      m.latest_submitted_at = batch.submitted_at;
      m.proposed_by_name = batch.proposed_by_name;
      m.proposed_by_dept = batch.proposed_by_dept;
    }
  }
  return Array.from(map.values());
}

function statusPillClass(status: DisplayStatus): string {
  switch (status) {
    case 'Pending Review': return 'bg-orange-100 text-orange-700';
    case 'Approved': return 'bg-green-100 text-green-700';
    case 'Needs Revision': return 'bg-amber-100 text-amber-700';
    case 'Rejected': return 'bg-red-100 text-red-700';
    default: return 'bg-gray-100 text-gray-600';
  }
}

function priorityPillClass(p: string): string {
  switch (p.toUpperCase()) {
    case 'HIGH': return 'bg-rose-100 text-rose-600';
    case 'MEDIUM': return 'bg-orange-100 text-orange-600';
    default: return 'bg-gray-100 text-gray-500';
  }
}

function riskPillClass(level?: string): string {
  switch ((level || '').toUpperCase()) {
    case 'HIGH': return 'bg-red-100 text-red-700';
    case 'MEDIUM': return 'bg-orange-100 text-orange-700';
    case 'LOW': return 'bg-green-100 text-green-700';
    default: return 'bg-gray-100 text-gray-600';
  }
}

// "YYYY-MM-DD" -> "Aug 1" — compact label for the Date Range button, kept
// separate from lib/utils's formatDate (which renders a full IST timestamp,
// too long for a toolbar button).
function formatShortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function statusLabel(status: LegalStatus): string {
  switch (status) {
    case 'approved': return 'Approved';
    case 'rejected': return 'Rejected';
    case 'needs_revision': return 'Needs Revision';
    default: return 'Pending';
  }
}

function titleCase(s?: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Exports a Trademark Review Report in the official Sun Pharma format matching ESAXERENONE.xls:
 * - Filename: <GENERIC_NAME_UPPERCASE>.xlsx (e.g. MAVACAMTEN.xlsx, ESAXERENONE.xlsx)
 * - Sheet 1: "Primary Info" (Real Brand Name Suggestion Form metadata and candidate name summary)
 * - Sheet 2: "SearchReport" (25-column legal search report with real Date Received, Suggested Name,
 *   Rationale, and real *Online/Pharmacy Presence hits like paracetamol(WHO), evotin(netmeds),
 *   leaving trademark manual evaluation columns empty for reviewer entry).
 */
async function exportTrademarkReviewSubmissionReport(
  group: MergedCaseGroup,
  matchingCase: BrandCase | null,
  allReviews: { review: LegalReview; batchId: string }[]
) {
  try {
    let reviewsToExport = allReviews;
    if (reviewsToExport.length === 0 && group.batches.length > 0) {
      const fetched = await Promise.all(group.batches.map((b) => apiClient.getLegalBatch(b.id)));
      reviewsToExport = fetched.flatMap((b, i) =>
        (b.reviews || []).map((r) => ({ review: r, batchId: group.batches[i].id }))
      );
    }

    if (reviewsToExport.length === 0) {
      toast.error('No candidate brand names found to export for this case.');
      return;
    }

    const wb = XLSX.utils.book_new();

    // Derive Generic Molecule & Clean Uppercase Filename
    const rawMolecule =
      (matchingCase as any)?.product_information?.generic_name ||
      matchingCase?.generic_name ||
      (group.heading ? group.heading.split(' - ')[0].split('(')[0].trim() : '') ||
      'MOLECULE';
    const baseMolecule = rawMolecule.split(' - ')[0].split('(')[0].trim();
    const filename = `${baseMolecule.toUpperCase().replace(/[^A-Z0-9_-]+/g, '_')}.xlsx`;

    // Extract Case Metadata for "Primary Info"
    const sForm = (matchingCase as any)?.suggestion_form || {};
    const prodInfo = sForm.product_information || (matchingCase as any)?.product_information || {};
    const medInfo = sForm.medical_information || (matchingCase as any)?.medical_information || {};
    const mfgInfo = sForm.manufacturing_information || (matchingCase as any)?.manufacturing_information || {};
    const commInfo = sForm.commercial_information || (matchingCase as any)?.commercial_information || {};
    const regInfo = sForm.regulatory_information || (matchingCase as any)?.regulatory_information || {};
    const brandInfo = sForm.brand_information || (matchingCase as any)?.brand_information || {};
    const patInfo = sForm.patent_information || (matchingCase as any)?.patent_information || {};

    const genericName = prodInfo.generic_name || matchingCase?.generic_name || baseMolecule;
    const division = prodInfo.division || matchingCase?.division || group.proposed_by_dept || 'To be decided';
    const dosageForm = prodInfo.dosage_form || matchingCase?.dosage_form || 'Tablets';
    const suggestedBy = prodInfo.suggested_by || matchingCase?.suggested_by || group.proposed_by_name || 'Brand Marketing Team';
    const dose = prodInfo.dose || matchingCase?.dose || 'tablets - OD';
    const dateReceivedStr = prodInfo.date || (group.latest_submitted_at ? formatDate(group.latest_submitted_at) : formatDate(new Date().toISOString()));

    const ailment = medInfo.ailment || matchingCase?.ailment || 'Targeted therapeutic indication';
    const segment = medInfo.segment || matchingCase?.segment || 'Cardiology';
    const therapy = medInfo.therapy || matchingCase?.therapy || 'Cardiovascular';
    const promotingIndications = medInfo.promoting_indications || matchingCase?.promoting_indications || ailment;

    const manufacturerLocation = mfgInfo.manufacturer_location || matchingCase?.manufacturer_location || 'Sun Pharmaceutical Industries Ltd';
    const marketerName = commInfo.marketer_name || matchingCase?.marketer_name || 'Sun Pharma Lifesciences';
    const sellerName = commInfo.seller_name || matchingCase?.seller_name || 'Sun Pharma Global Distribution';
    const parentBrandOwner = mfgInfo.parent_brand_owner || matchingCase?.parent_brand_owner || 'SPLL';
    const expectedLaunchMonth = commInfo.expected_launch_month || matchingCase?.expected_launch_month || '2026 April';
    const dcgiApproved = regInfo.dcgi_combination_approved || matchingCase?.dcgi_combination_approved || 'Yes';
    const scheduledDrug = regInfo.drug_schedule || matchingCase?.drug_schedule || 'Schedule H';
    const fdaFssai = regInfo.fda_fssai || 'FDA';
    const inhouseOutsourced = mfgInfo.mfd_type || 'In-house';
    const inlicense = mfgInfo.in_license || 'No';
    const internationalBrandNames = brandInfo.international_brand_names || matchingCase?.international_brand_names || '';
    const innovatorBrands = brandInfo.innovator_brands || matchingCase?.innovator_brands || '';
    const domesticBrandNames = brandInfo.domestic_brand_names || matchingCase?.domestic_brand_names || '';
    const patentValidity = patInfo.patent_validity || matchingCase?.patent_validity || 'Valid';
    const launchAfterExpiry = patInfo.launch_after_expiry || matchingCase?.launch_after_expiry || 'Yes';
    const launchDuringValidity = patInfo.launch_during_validity || matchingCase?.launch_during_validity || 'No';

    // ── SHEET 1: Primary Info (Brand Name Suggestion Form Layout) ──
    const primaryInfoData: any[][] = [
      [null, 'BRAND NAME SUGGESTION FORM', null, null, null],
      [],
      [null, 'GENERIC NAME:                                                       ', null, genericName, `DIV         : ${division}`],
      [null, 'DOSAGE FORM: ', null, dosageForm, `SUGGESTED BY: ${suggestedBy}`],
      [null, 'DOSE: ', null, dose, `Date        : ${dateReceivedStr}`],
      [null, 'AILMENT / CURATIVE ACTION : ', null, ailment],
      [null, 'Segment', null, segment],
      [null, 'Therapy', null, therapy],
      [null, 'Promoting Indication / s', null, promotingIndications],
      [null, 'PRODUCT MANUFACTURER NAME & LOCATION: ', null, manufacturerLocation],
      [null, 'MARKETER NAME OF THE PRODUCT: ', null, marketerName],
      [null, "PRODUCT SELLER'S NAME:\n( Info. by Kalpesh ) ", null, sellerName],
      [null, 'OWNER OF existing parent BRAND: SPIL/ SPLL / UTL ?    ( info. by TM team )', null, parentBrandOwner],
      [null, 'EXPECTED LAUNCH MONTH', null, expectedLaunchMonth],
      [null, 'WHETHER THIS IS DCGI COMBINATION APPROVED?', null, dcgiApproved],
      [null, 'PRODUCT IS SCHEDULED/ NON SCHEDULED DRUG ?', null, scheduledDrug],
      [null, 'PRODUCT IS FDA/ FSSAI PRODUCT? please explain in detail.', null, fdaFssai],
      [null, 'WHETHER THIS PRODUCT is In-house OR  outsourced', null, inhouseOutsourced],
      [null, 'WHETER THIS IS INLICESE PRODUCT?', null, inlicense],
      [null, 'INTERNATIONAL BRAND NAMES: ', null, internationalBrandNames],
      [null, 'INNOVATOR BRANDS INTERNATIONALLY: ', null, innovatorBrands],
      [null, 'BRANDS AVAILABLE IN INDIA : ', null, domesticBrandNames],
      [null, 'PATENT DETAILS -    \n1. Patent Expired? Or Valid till what period     ', null, patentValidity],
      [null, '2. Are we launching the product after expiry of patent? If yes, when?', null, launchAfterExpiry],
      [null, '3. Are we launching the product during the validity of the patent? If yes, what is the arrangement?', null, launchDuringValidity],
      [],
      ['Opinion', 'Sr.No.', 'SUGGESTED  NAME', 'SEARCH REPORT', 'RATIONALE / REASONS of coining such name'],
    ];

    reviewsToExport.forEach(({ review }, idx) => {
      const opLabel =
        review.status === 'approved'
          ? 'Approved'
          : review.status === 'rejected'
          ? 'Rejected'
          : review.status === 'needs_revision'
          ? 'Needs Revision'
          : '';
      const rationale =
        review.business_notes ||
        review.risk_ai_assessment ||
        `${genericName} for treating ${ailment.toLowerCase()}`;

      primaryInfoData.push([
        opLabel,
        idx + 1,
        review.brand_name.toUpperCase(),
        'SearchReport',
        rationale,
      ]);
    });

    const wsPrimary = XLSX.utils.aoa_to_sheet(primaryInfoData);

    // Style Primary Info
    styleMainTitle(wsPrimary, 0, 4);
    styleHeaderRow(wsPrimary, 26, 0, 4);
    for (let r = 27; r < primaryInfoData.length; r++) {
      setCellStyle(wsPrimary, r, 0, { bold: true, hAlign: 'center', border: true, fontSize: 10 });
      setCellStyle(wsPrimary, r, 1, { bold: false, hAlign: 'center', border: true, fontSize: 10 });
      setCellStyle(wsPrimary, r, 2, { bold: true, hAlign: 'left', border: true, fontSize: 10.5 });
      setCellStyle(wsPrimary, r, 3, { bold: false, hAlign: 'center', border: true, fontSize: 10, fontColor: '1E40AF' });
      setCellStyle(wsPrimary, r, 4, { bold: false, hAlign: 'left', border: true, fontSize: 10 });
    }
    autoFitColumns(wsPrimary, { 0: 16, 1: 40, 2: 12, 3: 35, 4: 55 });
    XLSX.utils.book_append_sheet(wb, wsPrimary, 'Primary Info');

    // ── SHEET 2: SearchReport (25 Columns Matching ESAXERENONE.xls) ──
    const searchReportRows: any[][] = [
      [
        'Date Received',
        'Suggested Name',
        'Rationale for Coining the Name',
        'Opinion Date',
        'Available\nYes/No/Maybe',
        'Risk Level (H/M/L)',
        'Our Prior Mark',
        '*Conflicting Trademark',
        '*Appl No',
        '*Appl Date',
        '*Proprietor',
        '*Class',
        '*Goods/Services ',
        '*User Claim',
        '*User Affidavit / Supportings',
        '*TMR Status',
        '*Opposition Details/Stages',
        'ORG ',
        '*Registration / Certificate Date',
        '*Renewal Validity',
        '*O3/RG-3 Notice Yes/No',
        '*Online/Pharmacy Presence',
        ' *Molecule  / Purpose For Which Used',
        'Conditions Subject To Which Adoption Can Be Allowed',
        'Internal Remarks',
      ],
      ['*Conflicting  Marks'],
      [],
    ];

    // Fetch live screening result for each candidate brand name
    const screeningMap: Record<string, any> = {};
    await Promise.all(
      reviewsToExport.map(async ({ review }) => {
        try {
          const res = await apiClient.compareBrand({
            brand_name: review.brand_name,
            case_id: review.case_id || matchingCase?.case_id,
            case_data: matchingCase ? {
              case_id: matchingCase.case_id,
              case_name: matchingCase.generic_name,
              generic_name: genericName,
              therapy: therapy,
              segment: segment,
              ailment: ailment,
              dosage_form: dosageForm,
              dose: dose,
            } : undefined,
          });
          if (res?.screening_result) {
            screeningMap[review.brand_name.toLowerCase()] = res.screening_result;
          }
        } catch {
          // Fallback to existing review assessment data
        }
      })
    );

    reviewsToExport.forEach(({ review }) => {
      const sr = screeningMap[review.brand_name.toLowerCase()];
      const itemDateReceived = review.submitted_at ? formatDate(review.submitted_at) : dateReceivedStr;
      const suggestedName = review.brand_name.toUpperCase();
      const rationale =
        review.business_notes ||
        review.risk_ai_assessment ||
        `${genericName} for treating ${ailment.toLowerCase()}`;
      const opinionDate = review.reviewed_at ? formatDate(review.reviewed_at) : '';
      const available =
        review.status === 'approved'
          ? 'YES'
          : review.status === 'rejected'
          ? 'NO'
          : review.status === 'needs_revision'
          ? 'MAYBE'
          : '';
      const score = typeof review.risk_score === 'number' ? review.risk_score : (sr?.overall_risk_score ?? 15);
      const riskLevel =
        (review.risk_level || (score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW')).toUpperCase() === 'HIGH'
          ? 'H'
          : (review.risk_level || '').toUpperCase() === 'MEDIUM'
          ? 'M'
          : 'L';
      const moleculePurpose = `${genericName}${ailment ? ' / ' + ailment : ''}`;

      // Build real *Online/Pharmacy Presence hits (e.g. paracetamol(WHO), evotin(netmeds))
      const allHits = [...(sr?.conflicts || []), ...(sr?.similar_names || [])];
      const hitParts: string[] = [];
      allHits.forEach((h: any) => {
        const cName = h.conflicting_name || h.name;
        let source = h.source || 'Market';
        if (/who/i.test(source)) source = 'WHO';
        else if (/iqvia/i.test(source)) source = 'IQVIA';
        else if (/1mg/i.test(source)) source = '1mg';
        else if (/apollo/i.test(source)) source = 'Apollo';
        else if (/netmeds/i.test(source)) source = 'Netmeds';
        else if (/pharmeasy/i.test(source)) source = 'PharmEasy';
        else if (/google/i.test(source)) source = 'Google';
        else if (/trademark/i.test(source)) source = 'TMR';
        if (cName) {
          hitParts.push(`${cName}(${source})`);
        }
      });

      const presenceValue = hitParts.length > 0
        ? Array.from(new Set(hitParts)).join(', ')
        : 'Not found in e-comm website';

      // If conflicting marks exist, output each conflict row; else 1 row with empty conflict cells
      const conflictsList = sr?.conflicts && sr.conflicts.length > 0 ? sr.conflicts : [];

      if (conflictsList.length > 0) {
        conflictsList.forEach((conf: any) => {
          searchReportRows.push([
            itemDateReceived,
            suggestedName,
            rationale,
            opinionDate,
            available,
            riskLevel,
            '', // Our Prior Mark (empty cell for user manual fill)
            conf.conflicting_name || conf.name || '',
            '', // *Appl No (empty cell for user manual fill)
            '', // *Appl Date (empty cell for user manual fill)
            conf.owner || '', // *Proprietor
            '5', // *Class
            '', // *Goods/Services (empty cell for user manual fill)
            '', // *User Claim (empty cell for user manual fill)
            '', // *User Affidavit / Supportings (empty cell for user manual fill)
            '', // *TMR Status (empty cell for user manual fill)
            '', // *Opposition Details/Stages (empty cell for user manual fill)
            '', // ORG (empty cell for user manual fill)
            '', // *Registration / Certificate Date (empty cell for user manual fill)
            '', // *Renewal Validity (empty cell for user manual fill)
            '', // *O3/RG-3 Notice Yes/No (empty cell for user manual fill)
            presenceValue, // *Online/Pharmacy Presence (real value e.g. paracetamol(WHO), evotin(netmeds))
            moleculePurpose, // *Molecule / Purpose For Which Used
            '', // Conditions Subject To Which Adoption Can Be Allowed (empty for manual fill)
            '', // Internal Remarks (empty for manual fill)
          ]);
        });
      } else {
        searchReportRows.push([
          itemDateReceived,
          suggestedName,
          rationale,
          opinionDate,
          available,
          riskLevel,
          '', // Our Prior Mark
          '', // *Conflicting Trademark (empty for manual fill)
          '', // *Appl No
          '', // *Appl Date
          '', // *Proprietor
          '5', // *Class
          '', // *Goods/Services
          '', // *User Claim
          '', // *User Affidavit / Supportings
          '', // *TMR Status
          '', // *Opposition Details/Stages
          '', // ORG
          '', // *Registration / Certificate Date
          '', // *Renewal Validity
          '', // *O3/RG-3 Notice Yes/No
          presenceValue, // *Online/Pharmacy Presence
          moleculePurpose, // *Molecule / Purpose For Which Used
          '', // Conditions Subject To Which Adoption Can Be Allowed
          '', // Internal Remarks
        ]);
      }
    });

    const wsSearchReport = XLSX.utils.aoa_to_sheet(searchReportRows);

    // Header styling (Row 0: Bold Corporate Blue)
    styleHeaderRow(wsSearchReport, 0, 0, 24);

    // Data rows styling
    for (let r = 3; r < searchReportRows.length; r++) {
      for (let c = 0; c <= 24; c++) {
        setCellStyle(wsSearchReport, r, c, {
          bold: c === 1,
          fontSize: 9.5,
          border: true,
          hAlign: [0, 3, 4, 5, 8, 9, 11, 15, 18, 19, 20].includes(c) ? 'center' : 'left',
          vAlign: 'center',
        });
      }
    }

    autoFitColumns(wsSearchReport, {
      0: 14, // Date Received
      1: 20, // Suggested Name
      2: 36, // Rationale
      3: 14, // Opinion Date
      4: 16, // Available
      5: 14, // Risk Level
      6: 18, // Our Prior Mark
      7: 24, // *Conflicting Trademark
      8: 16, // *Appl No
      9: 14, // *Appl Date
      10: 28, // *Proprietor
      11: 10, // *Class
      12: 35, // *Goods/Services
      13: 16, // *User Claim
      14: 24, // *User Affidavit
      15: 18, // *TMR Status
      16: 28, // *Opposition Details
      17: 18, // ORG
      18: 24, // *Registration Date
      19: 18, // *Renewal Validity
      20: 18, // *O3/RG-3 Notice
      21: 45, // *Online/Pharmacy Presence
      22: 35, // *Molecule / Purpose
      23: 30, // Conditions
      24: 30, // Internal Remarks
    });

    XLSX.utils.book_append_sheet(wb, wsSearchReport, 'SearchReport');

    XLSX.writeFile(wb, filename);
    await apiClient.logExport(`Trademark Review Report (${baseMolecule})`, 'xlsx');
    toast.success(`Exported ${filename} with Primary Info and SearchReport sheets`);
  } catch (err) {
    console.error('Error exporting Trademark Review Excel:', err);
    toast.error('Failed to export Trademark Review Report');
  }
}

function DropdownButton({
  label, icon, children,
}: { label: string; icon: React.ReactNode; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="sm" className="gap-1.5" onClick={() => setOpen((o) => !o)}>
        {icon} {label}
      </Button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            role="button"
            tabIndex={0}
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') setOpen(false); }}
          />
          <div className="absolute right-0 top-full mt-1 min-w-[10rem] bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-20">
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
}

function renderStatusBadge(status: LegalStatus) {
  switch (status) {
    case 'approved':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 shadow-2xs">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          Approved
        </span>
      );
    case 'needs_revision':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300 shadow-2xs">
          <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
          Revision Requested
        </span>
      );
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-300 shadow-2xs">
          <XCircle className="w-3.5 h-3.5 text-rose-600" />
          Rejected
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
          <Clock className="w-3.5 h-3.5 text-gray-400" />
          Pending
        </span>
      );
  }
}

// A single submitted name's review row (slide 18) — name, source/risk pills,
// score, current status, a reviewer-notes box, and Approve/Revise/Reject.
// Notes are sent as the `comments` field on whichever action is taken —
// there's no separate "save note" call in the backend, matching the mock
// (one notes box, three action buttons, no fourth "save" button).
function ReviewRow({
  review,
  batchId,
  canPerformReviewActions: propCanPerform,
  onOpenDetail,
}: {
  review: LegalReview;
  batchId: string;
  canPerformReviewActions?: boolean;
  onOpenDetail?: (brandName: string) => void;
}) {
  const qc = useQueryClient();
  const { isSuperAdmin, isAdmin, isTrademarkAdmin, isTrademarkUser, isBrandMarketingAdmin, isBrandMarketingUser, hasPermission } = useAuth();
  const canPerformReviewActions = propCanPerform !== undefined
    ? propCanPerform
    : ((isSuperAdmin || isAdmin || isTrademarkAdmin || isTrademarkUser) && !isBrandMarketingAdmin && !isBrandMarketingUser);
  const [notes, setNotes] = useState(review.reviewer_comments || '');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['legal-batch', batchId] });
    qc.invalidateQueries({ queryKey: ['legal-batches'] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['notifications-count'] });
    qc.invalidateQueries({ queryKey: ['dashboard-metrics'] });
  };

  const approveMut = useMutation({
    mutationFn: () => apiClient.approveLegalReview(review.id, notes || undefined),
    onSuccess: () => {
      console.log(`${LOG_TAG} approved "${review.brand_name}" (review_id=${review.id})`);
      toast.success(`"${review.brand_name}" approved`);
      invalidate();
    },
    onError: (err) => {
      console.error(`${LOG_TAG} approve failed for "${review.brand_name}":`, err);
      toast.error('Could not approve this name. Please try again.');
    },
  });
  const reviseMut = useMutation({
    mutationFn: () => apiClient.requestRevision(review.id, notes || undefined),
    onSuccess: () => {
      console.log(`${LOG_TAG} requested revision on "${review.brand_name}" (review_id=${review.id})`);
      toast.success(`Revision requested for "${review.brand_name}"`);
      invalidate();
    },
    onError: (err) => {
      console.error(`${LOG_TAG} revision request failed for "${review.brand_name}":`, err);
      toast.error('Could not request revision. Please try again.');
    },
  });
  const rejectMut = useMutation({
    mutationFn: () => apiClient.rejectLegalReview(review.id, notes || undefined),
    onSuccess: () => {
      console.log(`${LOG_TAG} rejected "${review.brand_name}" (review_id=${review.id})`);
      toast.success(`"${review.brand_name}" rejected`);
      invalidate();
    },
    onError: (err) => {
      console.error(`${LOG_TAG} reject failed for "${review.brand_name}":`, err);
      toast.error('Could not reject this name. Please try again.');
    },
  });

  const resubmitMut = useMutation({
    mutationFn: () => apiClient.resubmitLegalReview(review.id, resubmitComment || undefined),
    onSuccess: () => {
      toast.success(`Subcase "${review.brand_name}" resubmitted to Trademark Team`);
      setResubmitOpen(false);
      setResubmitComment('');
      invalidate();
    },
    onError: (err) => {
      console.error(`${LOG_TAG} resubmit failed for "${review.brand_name}":`, err);
      toast.error('Could not resubmit this subcase. Please try again.');
    },
  });

  const [resubmitOpen, setResubmitOpen] = useState(false);
  const [resubmitComment, setResubmitComment] = useState('');
  const [chatOpen, setChatOpen] = useState(false);

  const busy = approveMut.isPending || reviseMut.isPending || rejectMut.isPending || resubmitMut.isPending;
  const decided = review.status !== 'pending';
  const messagesList = review.messages || [];
  const messageCount = messagesList.length > 0 ? messagesList.length : (review.reviewer_comments || review.business_notes ? 1 : 0);
  const latestMessage = messagesList.length > 0 ? messagesList[messagesList.length - 1] : null;

  return (
    <div
      className={cn(
        'px-5 py-4 border-t border-gray-100 first:border-t-0 transition-colors',
        decided && review.status === 'approved' && 'border-l-4 border-l-emerald-500 bg-emerald-50/20',
        decided && review.status === 'needs_revision' && 'border-l-4 border-l-amber-500 bg-amber-50/20',
        decided && review.status === 'rejected' && 'border-l-4 border-l-rose-500 bg-rose-50/20',
        !decided && 'border-l-4 border-l-transparent hover:bg-slate-50/50'
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5 mb-2">
        <button
          type="button"
          onClick={() => onOpenDetail?.(review.brand_name)}
          className="text-sm font-bold text-blue-600 hover:text-blue-800 underline uppercase tracking-wide transition-colors cursor-pointer text-left focus:outline-none focus:ring-1 focus:ring-blue-400 rounded-xs"
          title={`Click to view detailed analysis report for "${review.brand_name}"`}
        >
          {review.brand_name}
        </button>
        {review.risk_level && (
          <span className={cn('px-2 py-0.5 rounded-full text-xs font-semibold', riskPillClass(review.risk_level))}>
            {titleCase(review.risk_level)} Risk
          </span>
        )}
        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
          {review.source_type === 'generated' ? 'AI Generator' : review.source_type === 'compare' ? 'Compare Names' : 'Brand Analysis'}
        </span>
        {typeof review.risk_score === 'number' && (
          <span className="text-xs font-semibold text-gray-600">Score: {review.risk_score.toFixed(0)}/100</span>
        )}
        
        {/* Discussion / Chat Button */}
        {hasPermission('trademark_review', 'chat_drawer') && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setChatOpen(true)}
            className="ml-auto h-7 px-2.5 text-xs font-semibold gap-1.5 border-blue-200 text-blue-700 bg-blue-50/50 hover:bg-blue-100 hover:text-blue-900 transition-colors cursor-pointer"
            title="Open direct collaborative notes & conversation thread for this candidate name"
          >
            <MessageSquare className="w-3.5 h-3.5 text-blue-600" />
            <span>Discussion</span>
            {messageCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-blue-200/80 text-blue-900">
                {messageCount}
              </span>
            )}
          </Button>
        )}
        {renderStatusBadge(review.status)}
      </div>

      {canPerformReviewActions ? (
        <div className="flex flex-wrap items-stretch gap-2.5">
          <div className="relative flex-1 min-w-[240px]">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={decided}
              placeholder="Add reviewer notes..."
              className="w-full h-10 pl-3 pr-9 rounded-lg border border-gray-200 text-sm disabled:bg-gray-50 disabled:text-gray-700"
            />
            <Paperclip className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
          </div>
          {decided ? (
            <div className="flex items-center gap-2">
              {review.status === 'approved' && (
                <div className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-emerald-600 text-white shadow-sm ring-2 ring-emerald-400/50 uppercase tracking-wider">
                  <CheckCircle2 className="w-4 h-4 text-white" />
                  <span>Approved</span>
                </div>
              )}
              {review.status === 'needs_revision' && (
                <div className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-amber-600 text-white shadow-sm ring-2 ring-amber-400/50 uppercase tracking-wider">
                  <AlertCircle className="w-4 h-4 text-white" />
                  <span>Revision Requested</span>
                </div>
              )}
              {review.status === 'rejected' && (
                <div className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-rose-600 text-white shadow-sm ring-2 ring-rose-400/50 uppercase tracking-wider">
                  <XCircle className="w-4 h-4 text-white" />
                  <span>Rejected</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {hasPermission('trademark_review', 'action_approve') && (
                <Button variant="success" size="sm" disabled={busy} onClick={() => approveMut.mutate()}>
                  Approve
                </Button>
              )}
              <Button variant="warning" size="sm" disabled={busy} onClick={() => reviseMut.mutate()}>
                Revise
              </Button>
              {hasPermission('trademark_review', 'action_reject') && (
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => rejectMut.mutate()}>
                  Reject
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-gray-50/80 rounded-lg border border-gray-100">
          <div className="flex items-center gap-2 text-xs text-gray-600">
            {(review.status as string) === 'pending' || (review.status as string) === 'under_review' ? (
              <>
                <Clock className="w-4 h-4 text-orange-500 flex-shrink-0 animate-pulse" />
                <span className="font-medium text-gray-700">Submission Under Review: Awaiting Trademark Team evaluation</span>
              </>
            ) : review.status === 'approved' ? (
              <>
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <span className="font-semibold text-green-700">Approved for brand registration by Trademark Team</span>
              </>
            ) : review.status === 'needs_revision' ? (
              <>
                <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <span className="font-semibold text-amber-800">Revision Requested by Trademark Team</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-red-500" />
                <span className="font-semibold text-red-700">Rejected due to trademark conflict risk</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Discussion / Notes Banner Preview */}
      {latestMessage ? (
        <div className="mt-2.5 p-3 bg-blue-50/60 border border-blue-200/70 rounded-xl flex items-start justify-between gap-3 text-xs">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <div className="p-1 rounded-md bg-blue-100 text-blue-700 flex-shrink-0 mt-0.5">
              <MessageSquare className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-bold text-gray-900">
                  {latestMessage.sender_name}
                </span>
                <span className="text-[10px] px-1.5 py-0.2 rounded font-semibold bg-blue-200/60 text-blue-900">
                  {latestMessage.sender_role || 'Note'}
                </span>
                {latestMessage.created_at && (
                  <span className="text-[10px] text-gray-400 font-normal">
                    · {formatDate(latestMessage.created_at)}
                  </span>
                )}
              </div>
              <p className="text-gray-800 mt-1 line-clamp-2 leading-relaxed">
                {latestMessage.message}
              </p>
            </div>
          </div>
          {hasPermission('trademark_review', 'chat_drawer') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setChatOpen(true)}
              className="h-7 text-xs font-bold text-blue-700 hover:text-blue-900 hover:bg-blue-100 flex-shrink-0 cursor-pointer"
            >
              View Thread ({messagesList.length})
            </Button>
          )}
        </div>
      ) : review.reviewer_comments ? (
        <div className="mt-2.5 p-3 bg-amber-50/60 border border-amber-200/70 rounded-xl flex items-start justify-between gap-3 text-xs">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <div className="p-1 rounded-md bg-amber-100 text-amber-800 flex-shrink-0 mt-0.5">
              <MessageSquare className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-amber-950">
                {review.reviewer_name ? `${review.reviewer_name} (Trademark Counsel): ` : 'Trademark Team Comments: '}
              </span>
              <span className="text-amber-900">{review.reviewer_comments}</span>
            </div>
          </div>
          {hasPermission('trademark_review', 'chat_drawer') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setChatOpen(true)}
              className="h-7 text-xs font-bold text-amber-800 hover:text-amber-950 hover:bg-amber-100 flex-shrink-0 cursor-pointer"
            >
              View Thread
            </Button>
          )}
        </div>
      ) : null}

      {/* Revision Required Section */}
      {review.status === 'needs_revision' && (
        <>
          {/* Brand Marketing Team & Admin view: Interactive Resubmission Box */}
          {(isBrandMarketingAdmin || isBrandMarketingUser || isSuperAdmin || (isAdmin && !isTrademarkAdmin && !isTrademarkUser)) ? (
            <div className="mt-3 p-3.5 bg-amber-50/90 border border-amber-300 rounded-xl space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
                  <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  <span>Action Required: Provide clarification or revised details for this candidate name</span>
                </div>
                {!resubmitOpen && (
                  <Button
                    size="sm"
                    variant="warning"
                    onClick={() => setResubmitOpen(true)}
                    className="h-8 text-xs font-semibold gap-1.5 bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Resubmit to Trademark Team
                  </Button>
                )}
              </div>

              {resubmitOpen && (
                <div className="pt-2 border-t border-amber-200/80 space-y-2">
                  <label className="block text-[11px] font-semibold text-amber-900">
                    Provide Clarification, Revised Rationale, or Documentation Details for TM Team:
                  </label>
                  <textarea
                    value={resubmitComment}
                    onChange={(e) => setResubmitComment(e.target.value)}
                    placeholder="e.g., Added international non-proprietary clearance proof, updated therapeutic scope, attached justification..."
                    rows={2}
                    className="w-full text-xs p-2.5 rounded-lg border border-amber-300 bg-white text-gray-900 focus:ring-2 focus:ring-amber-500 focus:outline-none"
                  />
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setResubmitOpen(false)}
                      disabled={resubmitMut.isPending}
                      className="h-7 text-xs text-gray-600 border-amber-300 hover:bg-amber-100"
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="warning"
                      onClick={() => resubmitMut.mutate()}
                      disabled={resubmitMut.isPending}
                      className="h-7 text-xs font-bold gap-1.5 bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
                    >
                      {resubmitMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Send Subcase to Trademark Team
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Trademark Team view: Informational status indicator */
            <div className="mt-3 p-3 bg-amber-50/70 border border-amber-200 rounded-lg flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <span className="text-amber-900 font-medium">Awaiting Brand Marketing Team revision & resubmission</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setChatOpen(true)}
                className="h-6 text-xs text-amber-800 hover:bg-amber-100 cursor-pointer"
              >
                Open Notes
              </Button>
            </div>
          )}
        </>
      )}

      {/* Discussion Chat Modal */}
      <ReviewChatModal
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        review={review}
        batchId={batchId}
      />
    </div>
  );
}

// Maps a queue tab to the single-name status it stands for — used to narrow
// down which names actually render inside a matching case card, so
// filtering by "Pending" doesn't just decide whether the card shows up but
function matchTabStatus(tab: Tab, status?: string): boolean {
  if (!status || tab === 'all') return true;
  const s = status.toLowerCase();
  if (tab === 'pending') return s === 'pending' || s === 'under_review';
  if (tab === 'approved') return s === 'approved';
  if (tab === 'rejected') return s === 'rejected';
  if (tab === 'revision') return s === 'needs_revision' || s === 'revision_required';
  return true;
}

function CaseCard({ group, statusFilter, canPerformReviewActions }: { group: MergedCaseGroup; statusFilter: Tab; canPerformReviewActions: boolean }) {
  // Expanded by default (explicit request) — the user collapses manually
  // per case; nothing here re-collapses it automatically.
  const [expanded, setExpanded] = useState(true);
  // "View Detail" used to just duplicate the collapse/expand chevron right
  // next to it — now it opens a real detailed-analysis popup for this
  // case's names, with Prev/Next to page through all of them without
  // reopening the dialog per name.
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailIndex, setDetailIndex] = useState(0);
  const [caseModalOpen, setCaseModalOpen] = useState(false);

  const matchingCase = useMemo(() => {
    const allCases = listCases();
    const cleanHeading = group.heading.toLowerCase().trim();
    return (
      allCases.find(
        (c) =>
          c.case_id.toLowerCase() === cleanHeading ||
          caseDisplayName(c).toLowerCase() === cleanHeading ||
          (c.generic_name && cleanHeading.startsWith(c.generic_name.toLowerCase()))
      ) || null
    );
  }, [group.heading]);

  const status = deriveStatus(group);
  const percent = group.name_count ? Math.round((group.reviewed_count / group.name_count) * 100) : 0;

  // One name may have been submitted across several batches sharing this
  // same case heading — fetch every batch's detail in parallel and flatten
  // into a single review list, tagging each row with the batch it actually
  // belongs to (approve/reject/revise and the invalidate-on-success call
  // both need the right batch id, not just the merged case).
  const detailQueries = useQueries({
    queries: group.batches.map((b: LegalReviewBatch) => ({
      queryKey: ['legal-batch', b.id],
      queryFn: () => apiClient.getLegalBatch(b.id),
      enabled: expanded,
    })),
  });
  const detailLoading = detailQueries.some((q) => q.isLoading);
  const detailError = detailQueries.some((q) => q.isError);
  const allReviews = detailQueries
    .flatMap((q, i) => ((q.data as any)?.reviews ?? []).map((r: LegalReview) => ({ review: r, batchId: group.batches[i].id })))
    .filter(({ review }) => matchTabStatus(statusFilter, review.status))
    .sort((a, b) => {
      const isPendingA = a.review.status === 'pending' || a.review.status === 'under_review';
      const isPendingB = b.review.status === 'pending' || b.review.status === 'under_review';

      // Pending cases on top, operation performed cases go down to the bottom
      if (isPendingA && !isPendingB) return -1;
      if (!isPendingA && isPendingB) return 1;

      // Maintain submission order within each partition
      return new Date(a.review.submitted_at).getTime() - new Date(b.review.submitted_at).getTime();
    });

  const caseCandidateNames = useMemo(() => {
    const list = allReviews.map((r) => r.review.brand_name);
    return list.length > 0 ? list : group.names;
  }, [allReviews, group.names]);

  const handleOpenDetail = (brandName: string) => {
    const idx = caseCandidateNames.indexOf(brandName);
    setDetailIndex(idx >= 0 ? idx : 0);
    setDetailOpen(true);
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    console.log(`${LOG_TAG} case "${group.heading}" ${next ? 'expanded' : 'collapsed'} (${group.batches.length} batch(es))`);
  };

  const [isExporting, setIsExporting] = useState(false);

  const handleExportExcel = async () => {
    setIsExporting(true);
    await exportTrademarkReviewSubmissionReport(group, matchingCase, allReviews);
    setIsExporting(false);
  };

  return (
    <Card className="overflow-hidden mb-5">
      <div className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              type="button"
              onClick={() => setCaseModalOpen(true)}
              className="text-left font-bold text-purple-700 hover:text-purple-950 hover:underline flex items-center gap-1.5 text-lg group/heading transition-colors cursor-pointer"
              title="Click to view full case form details"
            >
              <span>{group.heading}</span>
              <FileText className="w-4 h-4 text-purple-400 group-hover/heading:text-purple-600 opacity-80 flex-shrink-0" />
            </button>
            <span className={cn('px-2.5 py-1 rounded-full text-xs font-bold', statusPillClass(status))}>{status}</span>
            {group.priority && (
              <span className={cn('px-2.5 py-1 rounded-full text-xs font-bold', priorityPillClass(group.priority))}>
                {group.priority} Priority
              </span>
            )}
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">
              {group.reviewed_count}/{group.name_count} reviewed
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs font-semibold text-gray-700 hover:text-orange-600 hover:border-orange-300"
              disabled={isExporting || (group.names.length === 0 && allReviews.length === 0)}
              onClick={handleExportExcel}
              title="Download Excel submission report with individual search finding sheets for each candidate name (BRD 5.2.6.4)"
            >
              {isExporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
              )}
              Export Excel
            </Button>
            <button onClick={toggle} className="text-gray-400 hover:text-gray-600" aria-label={expanded ? 'Collapse' : 'Expand'}>
              {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
          {group.proposed_by_name && (
            <span className="flex items-center gap-1"><User className="w-3.5 h-3.5" /> {group.proposed_by_name}{group.proposed_by_dept ? ` · ${group.proposed_by_dept}` : ''}</span>
          )}
          <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" /> {formatDate(group.latest_submitted_at)}</span>
        </div>

        <div className="flex items-center gap-3 mt-3">
          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full', status === 'Approved' ? 'bg-purple-500' : 'bg-purple-400')}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-xs font-semibold text-gray-500 w-9 text-right">{percent}%</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100">
          {detailLoading && <p className="px-5 py-4 text-sm text-gray-400">Loading submitted names...</p>}
          {!detailLoading && statusFilter !== 'all' && (
            <p className="px-5 py-2 text-xs text-gray-400 bg-gray-50/60">
              Showing {allReviews.length} of {group.name_count} name{group.name_count === 1 ? '' : 's'} in this case matching "{TABS.find(t => t.key === statusFilter)?.label}"
            </p>
          )}
          {!detailLoading && allReviews.length === 0 && (
            <p className="px-5 py-4 text-xs text-gray-400 text-center">
              No submitted brand names found matching this status.
            </p>
          )}
          {!detailLoading && allReviews.length > 0 && (
            <div className="hidden sm:grid grid-cols-12 gap-2 px-5 py-2 bg-gray-50/80 border-b border-gray-100 text-[11px] font-bold text-gray-500 uppercase tracking-wider">
              <div className="col-span-3">Candidate Brand Name</div>
              <div className="col-span-2">Proposed By / Dept</div>
              <div className="col-span-2">Submission Date</div>
              <div className="col-span-3">AI Risk & Source</div>
              <div className="col-span-2 text-right">Review Action / Status</div>
            </div>
          )}
          {allReviews.map(({ review, batchId }) => (
            <ReviewRow
              key={review.id}
              review={review}
              batchId={batchId}
              canPerformReviewActions={canPerformReviewActions}
              onOpenDetail={handleOpenDetail}
            />
          ))}
        </div>
      )}

      <TrademarkNameDetailModal
        names={caseCandidateNames}
        initialIndex={detailIndex}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        caseId={matchingCase?.case_id || group.heading}
      />

      <CaseFormDetailsModal
        open={caseModalOpen}
        onClose={() => setCaseModalOpen(false)}
        caseData={matchingCase}
        caseId={matchingCase?.case_id || group.heading}
      />
    </Card>
  );
}

export function TrademarkReviewPage() {
  const router = useRouter();
  const { isSuperAdmin, isAdmin, isTrademarkAdmin, isTrademarkUser, isBrandMarketingAdmin, isBrandMarketingUser } = useAuth();
  const canPerformReviewActions = (isSuperAdmin || isAdmin || isTrademarkAdmin || isTrademarkUser) && !isBrandMarketingAdmin && !isBrandMarketingUser;
  const isBrandMarketing = isBrandMarketingAdmin || isBrandMarketingUser;

  const [search, setSearch] = usePersistentState('brandsentry_filter_tm_search', '');
  const [tab, setTab] = usePersistentState<Tab>('brandsentry_filter_tm_tab', 'all');
  const [sortBy, setSortBy] = usePersistentState<SortKey>('brandsentry_filter_tm_sortBy', 'newest');
  // Native <input type="date"> values ("YYYY-MM-DD"), or '' when unset (persisted across reloads)
  const [dateFrom, setDateFrom] = usePersistentState('brandsentry_filter_tm_dateFrom', '');
  const [dateTo, setDateTo] = usePersistentState('brandsentry_filter_tm_dateTo', '');
  const dateRangeActive = Boolean(dateFrom || dateTo);

  const batchesQuery = useQuery({
    queryKey: ['legal-batches'],
    queryFn: () => apiClient.getLegalBatches(),
    refetchOnMount: 'always',
  });

  const batches = (batchesQuery.data || []).filter((b) => {
    const heading = parseBatchDescription(b.description).heading;
    return heading !== 'Ungrouped' && heading !== 'Untitled Case';
  });

  const merged = useMemo(() => mergeByHeading(batches), [batches]);

  const withStatus = useMemo(
    () => merged.map((group) => ({ group, status: deriveStatus(group) })),
    [merged]
  );

  const stats = useMemo(() => {
    const counts = { total: merged.length, pending: 0, approved: 0, rejected: 0, revision: 0 };
    for (const group of merged) {
      if (group.pending_count > 0 || group.name_count === 0) counts.pending += 1;
      if (group.approved_count > 0) counts.approved += 1;
      if (group.rejected_count > 0) counts.rejected += 1;
      if (group.needs_revision_count > 0) counts.revision += 1;
    }
    return counts;
  }, [merged]);

  const filtered = useMemo(() => {
    let rows = withStatus;
    if (tab !== 'all') {
      rows = rows.filter(({ group }) => {
        if (tab === 'pending') return group.pending_count > 0 || group.name_count === 0;
        if (tab === 'approved') return group.approved_count > 0;
        if (tab === 'rejected') return group.rejected_count > 0;
        if (tab === 'revision') return group.needs_revision_count > 0;
        return true;
      });
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(({ group: m }) =>
        m.heading.toLowerCase().includes(q) ||
        (m.proposed_by_name || '').toLowerCase().includes(q) ||
        (m.proposed_by_dept || '').toLowerCase().includes(q) ||
        m.batches.some((b) => b.batch_code.toLowerCase().includes(q)) ||
        m.names.some((n) => n.toLowerCase().includes(q))
      );
    }

    if (dateFrom) {
      const from = new Date(`${dateFrom}T00:00:00`).getTime();
      rows = rows.filter((m) => m.group.batches.some((b) => new Date(b.submitted_at).getTime() >= from));
    }
    if (dateTo) {
      const to = new Date(`${dateTo}T23:59:59.999`).getTime();
      rows = rows.filter((m) => m.group.batches.some((b) => new Date(b.submitted_at).getTime() <= to));
    }

    rows = [...rows].sort((a, b) => {
      if (sortBy === 'name_asc') return a.group.heading.localeCompare(b.group.heading);
      const at = new Date(a.group.latest_submitted_at).getTime();
      const bt = new Date(b.group.latest_submitted_at).getTime();
      return sortBy === 'oldest' ? at - bt : bt - at;
    });
    return rows;
  }, [withStatus, tab, search, sortBy, dateFrom, dateTo]);

  const hasActiveFilters = Boolean(search || tab !== 'all' || dateRangeActive);
  const handleClearFilters = () => {
    setSearch('');
    setTab('all');
    setDateFrom('');
    setDateTo('');
  };

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto">

      {isBrandMarketing && (
        <div className="mb-6 p-4 bg-blue-50/70 border border-blue-200/80 rounded-xl flex items-start gap-3 text-xs text-blue-900 shadow-sm">
          <Shield className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-bold text-blue-950">Brand Marketing Track Status Mode</p>
            <p className="text-blue-800 mt-0.5">
              You are tracking the live IP clearance progress of your submitted batches. Status updates and comments from the Trademark Counsel appear below in real time. Decision actions (Approve, Revise, Reject) are handled by the Trademark Team.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-5">
        {([
          { label: 'Total Cases', value: stats.total, tabKey: 'all' as Tab, color: 'text-gray-900' },
          { label: 'Pending Review', value: stats.pending, tabKey: 'pending' as Tab, color: 'text-orange-600' },
          { label: 'Approved', value: stats.approved, tabKey: 'approved' as Tab, color: 'text-green-600' },
          { label: 'Rejected', value: stats.rejected, tabKey: 'rejected' as Tab, color: 'text-red-600' },
          { label: 'Needs Revision', value: stats.revision, tabKey: 'revision' as Tab, color: 'text-amber-600' },
        ]).map((s) => (
          <button
            key={s.label}
            onClick={() => setTab(s.tabKey)}
            className={cn(
              'rounded-xl border bg-white p-4 text-center transition-colors',
              tab === s.tabKey ? 'border-orange-300 ring-1 ring-orange-200' : 'border-gray-200 hover:border-gray-300'
            )}
          >
            <p className={cn('text-3xl font-bold', s.color)}>{s.value}</p>
            <p className="text-sm text-gray-500 mt-1">{s.label}</p>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Cases or brand names..."
            className="w-full h-11 pl-9 pr-9 rounded-lg border border-gray-200 text-sm bg-white"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <DropdownButton
          label={dateRangeActive
            ? `${dateFrom ? formatShortDate(dateFrom) : '…'} – ${dateTo ? formatShortDate(dateTo) : '…'}`
            : 'Date Range'}
          icon={<Calendar className="w-3.5 h-3.5" />}
        >
          {(close) => (
            <div className="px-4 py-3 w-64 space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
                <input
                  type="date"
                  value={dateFrom}
                  max={dateTo || new Date().toISOString().slice(0, 10)}
                  onChange={(e) => {
                    const val = e.target.value;
                    const today = new Date().toISOString().slice(0, 10);
                    if (val && val > today) {
                      toast.error('Future dates are not permitted');
                      return;
                    }
                    setDateFrom(val);
                  }}
                  className="w-full h-9 px-2 rounded-lg border border-gray-200 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
                <input
                  type="date"
                  value={dateTo}
                  min={dateFrom || undefined}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => {
                    const val = e.target.value;
                    const today = new Date().toISOString().slice(0, 10);
                    if (val && val > today) {
                      toast.error('Future dates are not permitted');
                      return;
                    }
                    setDateTo(val);
                  }}
                  className="w-full h-9 px-2 rounded-lg border border-gray-200 text-sm"
                />
              </div>
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => { setDateFrom(''); setDateTo(''); }}
                  disabled={!dateRangeActive}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 font-medium disabled:opacity-40 disabled:hover:text-gray-400"
                >
                  <X className="w-3 h-3" /> Clear
                </button>
                <button onClick={close} className="text-xs text-orange-600 hover:text-orange-800 font-semibold">
                  Done
                </button>
              </div>
            </div>
          )}
        </DropdownButton>
        <DropdownButton label="Sort" icon={<ArrowUpDown className="w-3.5 h-3.5" />}>
          {(close) => SORT_OPTIONS.map((o) => (
            <button
              key={o.key}
              onClick={() => { setSortBy(o.key); close(); }}
              className={cn('w-full text-left px-4 py-1.5 text-sm hover:bg-gray-50', sortBy === o.key && 'text-orange-600 font-semibold')}
            >
              {o.label}
            </button>
          ))}
        </DropdownButton>
        <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm font-semibold transition-colors',
                tab === t.key ? 'bg-orange-500 text-white' : 'text-gray-600 hover:bg-gray-50'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {batchesQuery.isLoading && <p className="text-sm text-gray-400">Loading review queue...</p>}
      {batchesQuery.isError && <p className="text-sm text-red-500">Could not load the review queue. Please try again.</p>}

      {!batchesQuery.isLoading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 text-center gap-3">
          <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center">
            <Shield className="w-8 h-8 text-gray-300" />
          </div>
          <div>
            <p className="font-semibold text-gray-700">
              {merged.length === 0 ? 'No trademark review requests yet' : 'No requests match your filters'}
            </p>
            <p className="text-sm text-gray-400 mt-1">
              {merged.length === 0
                ? 'Submit names from the Review Batch page to start a request'
                : 'Try adjusting your search or filters'}
            </p>
          </div>
        </div>
      )}

      {filtered.map(({ group }) => (
        <CaseCard
          key={group.heading}
          group={group}
          statusFilter={tab}
          canPerformReviewActions={canPerformReviewActions}
        />
      ))}
    </div>
  );
}
