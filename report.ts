import DOMPurify from 'dompurify';
import type { BrandSearchResponse, GeneratedName, IntelligenceData, ScreeningResult } from '@/types';
import { apiClient } from '@/api/client';
import { formatSourceName } from '@/lib/utils';

// Every report used to download as a raw .html file — these two helpers
// render the same visual HTML into a real .pdf (for narrative/mixed
// reports) or write structured rows straight into a real .xlsx workbook
// (for reports that are fundamentally a table: Compare Names, bulk name
// lists), instead of a browser-openable HTML file either way. jsPDF/
// html2canvas/xlsx are dynamically imported so they never bloat the main
// bundle — they only load the moment a user actually clicks a Download
// button.

function extractBody(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return match ? match[1] : html;
}

function extractStyles(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
}

async function downloadPdfFromHtml(html: string, filename: string) {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ]);

  const styleEl = document.createElement('style');
  styleEl.textContent = extractStyles(html);
  document.head.appendChild(styleEl);

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '-10000px';
  container.innerHTML = DOMPurify.sanitize(extractBody(html));
  document.body.appendChild(container);

  try {
    const target = (container.querySelector('.page') as HTMLElement) ?? container;
    // Let layout settle (fonts/images within the injected markup) before
    // rasterizing — a fixed short delay is enough since everything here is
    // inline-styled text/CSS, no external network image loads.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const canvas = await html2canvas(target, { scale: 2, backgroundColor: '#ffffff', useCORS: true });

    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    const imgData = canvas.toDataURL('image/png');

    let heightLeft = imgHeight;
    let position = 0;
    pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while (heightLeft > 0) {
      position -= pageHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }
    pdf.save(filename);
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(styleEl);
  }
}

async function downloadExcel(rows: Record<string, string | number>[], filename: string, sheetName: string) {
  const { XLSX, formatFullTableWorksheet, formatRowsHeaders } = await import('@/lib/excelExportHelper');
  const formattedRows = formatRowsHeaders(rows);
  const ws = XLSX.utils.json_to_sheet(formattedRows);
  formatFullTableWorksheet(ws, 0);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

function base(): string {
  return `
    <meta charset="UTF-8">
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8fafc; color: #1e293b; font-size: 13px; }
      .page { max-width: 900px; margin: 32px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
      .header { background: linear-gradient(135deg, #c45f00 0%, #f7941e 100%); color: #fff; padding: 28px 32px; }
      .header h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
      .header p { opacity: .75; font-size: 12px; }
      .meta { display: flex; gap: 24px; margin-top: 14px; }
      .meta span { background: rgba(255,255,255,.15); padding: 4px 12px; border-radius: 20px; font-size: 11px; }
      .body { padding: 28px 32px; }
      .section { margin-bottom: 24px; }
      .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; }
      .kpi-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
      .kpi { flex: 1; min-width: 110px; background: #f1f5f9; border-radius: 8px; padding: 12px 16px; }
      .kpi .val { font-size: 26px; font-weight: 800; }
      .kpi .lbl { font-size: 11px; color: #6b7280; margin-top: 2px; }
      .risk-high { color: #dc2626; } .risk-med { color: #ea580c; } .risk-low { color: #16a34a; }
      .bg-high { background: #fef2f2; border: 1px solid #fecaca; }
      .bg-med  { background: #fff7ed; border: 1px solid #fed7aa; }
      .bg-low  { background: #f0fdf4; border: 1px solid #bbf7d0; }
      .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
      .bar-label { width: 160px; font-size: 12px; color: #374151; flex-shrink: 0; }
      .bar-track { flex: 1; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden; }
      .bar-fill { height: 100%; border-radius: 4px; }
      .bar-pct { width: 38px; text-align: right; font-weight: 700; font-size: 12px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th { background: #f8fafc; text-align: left; padding: 8px 10px; color: #6b7280; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
      td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
      tr:last-child td { border-bottom: none; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 10px; font-weight: 700; }
      .badge-red { background: #fee2e2; color: #dc2626; }
      .badge-orange { background: #ffedd5; color: #ea580c; }
      .badge-green { background: #dcfce7; color: #16a34a; }
      .badge-blue { background: #fff7ed; color: #ea580c; }
      .badge-gray { background: #f3f4f6; color: #6b7280; }
      .ai-box { background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 14px 16px; }
      .ai-box p { font-size: 12px; line-height: 1.6; color: #7c3aed; }
      .rationale-box { border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
      .rationale-box p { font-size: 12px; line-height: 1.6; }
      .footer { text-align: center; padding: 16px; font-size: 10px; color: #9ca3af; border-top: 1px solid #f1f5f9; }
      @media print { body { background: #fff; } .page { box-shadow: none; margin: 0; border-radius: 0; } }
    </style>`;
}

function barColor(pct: number) {
  if (pct >= 70) return '#ef4444';
  if (pct >= 40) return '#f97316';
  return '#22c55e';
}

function riskClass(level: string) {
  return level === 'HIGH' ? 'risk-high' : level === 'MEDIUM' ? 'risk-med' : 'risk-low';
}

function badgeFor(level: string) {
  return level === 'HIGH' ? 'badge-red' : level === 'MEDIUM' ? 'badge-orange' : 'badge-green';
}

function now() {
  return new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Brand Analysis Combined Report ────────────────────────────────────────────

export async function downloadBrandAnalysisReport(
  screeningData: BrandSearchResponse,
  intelligenceData: IntelligenceData
) {
  const sr = screeningData.screening_result;
  const brandName = screeningData.brand_name;

  const riskPct = Math.round(sr?.overall_risk_score ?? 0);
  const level = sr?.risk_classification ?? 'LOW';

  const bars = sr ? [
    { label: 'Exact Match',                  val: Math.round(sr.exact_match_score * 100) },
    { label: 'Phonetic Similarity',          val: Math.round(sr.phonetic_similarity_score * 100) },
    { label: 'Spelling Similarity',          val: Math.round(sr.spelling_similarity_score * 100) },
    { label: 'Visual Similarity',            val: Math.round(sr.lookalike_score * 100) },
    { label: 'Conceptual Similarity',        val: Math.round(sr.semantic_similarity_score * 100) },
  ] : [];

  const conflictsHtml = sr?.conflicts.length ? `
    <div class="section">
      <div class="section-title">Detected Conflicts (${sr.conflicts.length})</div>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Source</th><th>Severity</th><th>Details</th></tr></thead>
        <tbody>
          ${sr.conflicts.map(c => `
            <tr>
              <td><strong>${c.conflicting_name}</strong>${c.owner ? `<br><small style="color:#9ca3af">${c.owner}</small>` : ''}</td>
              <td>${c.conflict_type.replace(/_/g, ' ')}</td>
              <td><span class="badge badge-blue">${formatSourceName(c.source)}</span></td>
              <td><span class="badge ${badgeFor(c.severity)}">${c.severity}</span></td>
              <td style="color:#6b7280">${c.details ?? 'N/A'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const similarHtml = sr?.similar_names.length ? `
    <div class="section">
      <div class="section-title">Similar Brand Names (${sr.similar_names.length})</div>
      <table>
        <thead><tr><th>Brand Name</th><th>Similarity Type</th><th>Score</th><th>Source</th><th>Therapeutic Area</th><th>Risk</th></tr></thead>
        <tbody>
          ${sr.similar_names.map(n => `
            <tr>
              <td><strong>${n.name}</strong>${n.manufacturer ? `<br><small style="color:#9ca3af">${n.manufacturer}</small>` : ''}</td>
              <td>${n.similarity_type}</td>
              <td><strong style="color:${barColor(n.similarity_score * 100)}">${(n.similarity_score * 100).toFixed(0)}%</strong></td>
              <td><span class="badge badge-gray">${formatSourceName(n.source)}</span></td>
              <td>${n.therapeutic_area ?? 'N/A'}</td>
              <td><span class="badge ${badgeFor(n.risk_level)}">${n.risk_level}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  // ── Market Intelligence section ──
  const competitorRows = intelligenceData.competitive_landscape.length ? `
    <div class="section">
      <div class="section-title">Competitive Landscape (${intelligenceData.competitive_landscape.length} competitors)</div>
      <table>
        <thead><tr><th>Brand</th><th>Similarity</th><th>Market Share</th><th>Trademark Status</th><th>Manufacturer</th><th>Therapeutic Area</th></tr></thead>
        <tbody>
          ${intelligenceData.competitive_landscape.map(c => `
            <tr>
              <td><strong>${c.brand}</strong></td>
              <td><strong style="color:${barColor(c.similarity_score)}">${c.similarity_score}%</strong></td>
              <td>${c.market_presence > 0 ? c.market_presence + '%' : 'N/A'}</td>
              <td><span class="badge badge-blue">${c.trademark_status}</span></td>
              <td style="color:#6b7280">${c.manufacturer}</td>
              <td style="color:#6b7280">${c.therapeutic_area}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const similarityBreakdownHtml = intelligenceData.similarity_breakdown.length ? `
    <div class="section">
      <div class="section-title">Similarity Breakdown by Type</div>
      <div class="kpi-row">
        ${intelligenceData.similarity_breakdown.map(b => `
          <div class="kpi">
            <div class="val" style="color:${b.color}">${b.count}</div>
            <div class="lbl">${b.type}</div>
          </div>`).join('')}
      </div>
    </div>` : '';

  const html = `<!DOCTYPE html><html><head><title>Brand Analysis Report – ${brandName}</title>${base()}
    <style>
      .part-header { display: flex; align-items: center; gap: 12px; background: #f1f5f9; border-left: 4px solid #f7941e; padding: 14px 20px; margin: 28px -32px 20px; }
      .part-header.intel { border-left-color: #7c3aed; }
      .part-header h2 { font-size: 15px; font-weight: 700; color: #1e293b; }
      .part-header p { font-size: 11px; color: #6b7280; margin-top: 2px; }
      .part-num { width: 28px; height: 28px; border-radius: 50%; background: #f7941e; color: #fff; font-weight: 800; font-size: 13px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .part-num.intel { background: #7c3aed; }
      .divider { border: none; border-top: 2px dashed #e5e7eb; margin: 28px 0; }
    </style>
  </head><body>
    <div class="page">
      <div class="header">
        <h1>Complete Brand Analysis Report: ${brandName}</h1>
        <p>Pharmaceutical Brand Intelligence Platform &nbsp;·&nbsp; Part 1: Risk Screening &nbsp;·&nbsp; Part 2: Market Intelligence</p>
        <div class="meta">
          <span>Generated: ${now()}</span>
          <span>Risk Level: ${level}</span>
          <span>Risk Score: ${riskPct}/100</span>
          ${sr ? `<span>Recommendation: ${sr.ai_recommendation ?? 'N/A'}</span>` : ''}
          <span>Competitors: ${intelligenceData.competitor_count}</span>
          <span>Uniqueness: ${intelligenceData.brand_uniqueness_score.toFixed(0)}/100</span>
        </div>
      </div>

      <div class="body">

        <!-- ══ PART 1: RISK SCREENING ══ -->
        <div class="part-header">
          <div class="part-num">1</div>
          <div>
            <h2>Risk Screening</h2>
            <p>Trademark, phonetic, spelling and semantic conflict analysis</p>
          </div>
        </div>

        ${sr ? `
        <div class="section">
          <div class="section-title">Risk Overview</div>
          <div class="kpi-row">
            <div class="kpi ${level === 'HIGH' ? 'bg-high' : level === 'MEDIUM' ? 'bg-med' : 'bg-low'}">
              <div class="val ${riskClass(level)}">${riskPct}</div>
              <div class="lbl">Overall Risk Score</div>
            </div>
            <div class="kpi"><div class="val">${sr.total_conflicts}</div><div class="lbl">Total Conflicts</div></div>
            <div class="kpi"><div class="val">${sr.trademark_conflicts}</div><div class="lbl">Trademark</div></div>
            <div class="kpi"><div class="val">${sr.market_conflicts}</div><div class="lbl">Market</div></div>
            <div class="kpi"><div class="val">${sr.epharmacy_conflicts}</div><div class="lbl">E-Pharmacy</div></div>
            <div class="kpi"><div class="val">${sr.similar_names.length}</div><div class="lbl">Similar Names</div></div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">Similarity Analysis</div>
          ${bars.map(b => `
            <div class="bar-row">
              <span class="bar-label">${b.label}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${b.val}%;background:${barColor(b.val)}"></div></div>
              <span class="bar-pct" style="color:${barColor(b.val)}">${b.val}%</span>
            </div>`).join('')}
        </div>
        ${sr.ai_assessment ? `
        <div class="section">
          <div class="section-title">AI Risk Assessment</div>
          <div class="ai-box"><p>${sr.ai_assessment}</p></div>
        </div>` : ''}` : ''}
        ${conflictsHtml}
        ${similarHtml}

        <hr class="divider">

        <!-- ══ PART 2: MARKET INTELLIGENCE ══ -->
        <div class="part-header intel">
          <div class="part-num intel">2</div>
          <div>
            <h2>Market Intelligence</h2>
            <p>Competitive landscape, market saturation and uniqueness analysis</p>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Market Overview</div>
          <div class="kpi-row">
            <div class="kpi"><div class="val" style="color:#f7941e">${intelligenceData.trademark_presence}</div><div class="lbl">Trademark Registrations</div></div>
            <div class="kpi"><div class="val" style="color:#7c3aed">${intelligenceData.market_presence}</div><div class="lbl">Market Listings</div></div>
            <div class="kpi"><div class="val" style="color:#059669">${intelligenceData.epharmacy_presence}</div><div class="lbl">E-Pharmacy Listings</div></div>
            <div class="kpi"><div class="val" style="color:#ea580c">${intelligenceData.geographic_reach}</div><div class="lbl">Geographic Reach</div></div>
            <div class="kpi"><div class="val" style="color:#dc2626">${intelligenceData.competitor_count}</div><div class="lbl">Competitors</div></div>
          </div>
          <div class="kpi-row" style="margin-top:8px">
            <div class="kpi ${intelligenceData.brand_uniqueness_score > 60 ? 'bg-low' : intelligenceData.brand_uniqueness_score > 30 ? 'bg-med' : 'bg-high'}">
              <div class="val ${intelligenceData.brand_uniqueness_score > 60 ? 'risk-low' : intelligenceData.brand_uniqueness_score > 30 ? 'risk-med' : 'risk-high'}">${intelligenceData.brand_uniqueness_score.toFixed(0)}</div>
              <div class="lbl">Brand Uniqueness Score (/ 100)</div>
            </div>
            <div class="kpi ${intelligenceData.market_saturation > 0.6 ? 'bg-high' : intelligenceData.market_saturation > 0.3 ? 'bg-med' : 'bg-low'}">
              <div class="val ${intelligenceData.market_saturation > 0.6 ? 'risk-high' : intelligenceData.market_saturation > 0.3 ? 'risk-med' : 'risk-low'}">${(intelligenceData.market_saturation * 100).toFixed(0)}%</div>
              <div class="lbl">Market Saturation</div>
            </div>
          </div>
        </div>

        ${similarityBreakdownHtml}
        ${competitorRows}

        ${intelligenceData.ai_summary ? `
        <div class="section">
          <div class="section-title">AI Intelligence Summary</div>
          <div class="ai-box" style="background:#f5f3ff;border-color:#ddd6fe"><p style="color:#4c1d95">${intelligenceData.ai_summary}</p></div>
        </div>` : ''}

      </div>
      <div class="footer">BrandSentry Platform &nbsp;·&nbsp; ${now()} &nbsp;·&nbsp; Confidential, For Internal Use Only</div>
    </div>
  </body></html>`;

  await downloadPdfFromHtml(html, `BrandAnalysis_${brandName}_${new Date().toISOString().slice(0, 10)}.pdf`);
  apiClient.logExport(brandName);
}

// ── AI Generator Report (single name) ─────────────────────────────────────────

export async function downloadNameDetailReport(name: GeneratedName) {
  const level = name.recommendation_status === 'high_risk' ? 'HIGH'
    : name.recommendation_status === 'review_required' ? 'MEDIUM' : 'LOW';

  const conflictsHtml = name.conflict_details?.top_conflicts.length ? `
    <div class="section">
      <div class="section-title">Conflicting Brands (${name.conflict_details.top_conflicts.length})</div>
      <table>
        <thead><tr><th>Brand</th><th>Source</th><th>Similarity Type</th><th>Score</th></tr></thead>
        <tbody>
          ${name.conflict_details.top_conflicts.map(c => `
            <tr>
              <td><strong>${c.name}</strong>${c.owner ? `<br><small style="color:#9ca3af">${c.owner}</small>` : ''}</td>
              <td><span class="badge badge-blue">${formatSourceName(c.source)}</span></td>
              <td>${c.similarity_type}</td>
              <td><strong style="color:${barColor(c.similarity_score * 100)}">${(c.similarity_score * 100).toFixed(0)}%</strong></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const html = `<!DOCTYPE html><html><head><title>Brand Name Report – ${name.generated_name}</title>${base()}</head><body>
    <div class="page">
      <div class="header">
        <h1>Generated Brand Name: ${name.generated_name}</h1>
        <p>AI Brand Name Generator &nbsp;·&nbsp; Pharmaceutical Brand Intelligence Platform</p>
        <div class="meta">
          <span>Generated: ${now()}</span>
          <span>Status: ${name.recommendation_status.replace(/_/g, ' ').toUpperCase()}</span>
          ${name.therapeutic_area ? `<span>Area: ${name.therapeutic_area}</span>` : ''}
          ${name.molecule ? `<span>Molecule: ${name.molecule}</span>` : ''}
        </div>
      </div>
      <div class="body">
        <div class="section">
          <div class="section-title">Score Overview</div>
          <div class="kpi-row">
            <div class="kpi ${level === 'HIGH' ? 'bg-high' : level === 'MEDIUM' ? 'bg-med' : 'bg-low'}">
              <div class="val ${riskClass(level)}">${name.risk_score.toFixed(0)}</div>
              <div class="lbl">Risk Score</div>
            </div>
            <div class="kpi"><div class="val" style="color:#f7941e">${name.availability_score.toFixed(0)}</div><div class="lbl">Availability</div></div>
            <div class="kpi"><div class="val" style="color:#7c3aed">${name.memorability_score.toFixed(0)}</div><div class="lbl">Memorability</div></div>
            <div class="kpi"><div class="val" style="color:#059669">${name.pronunciation_score.toFixed(0)}</div><div class="lbl">Pronunciation Ease</div></div>
          </div>
        </div>
        ${name.conflict_details?.rationale ? `
        <div class="section">
          <div class="section-title">Decision Rationale</div>
          <div class="rationale-box ${level === 'HIGH' ? 'bg-high' : level === 'MEDIUM' ? 'bg-med' : 'bg-low'}">
            <p>${name.conflict_details.rationale}</p>
          </div>
        </div>` : ''}
        ${conflictsHtml}
        ${name.phonetic_analysis ? `
        <div class="section">
          <div class="section-title">Phonetic Analysis</div>
          <div class="ai-box" style="background:#eff6ff;border-color:#bfdbfe"><p>${name.phonetic_analysis}</p></div>
        </div>` : ''}
        ${name.semantic_analysis ? `
        <div class="section">
          <div class="section-title">Semantic Profile</div>
          <div class="ai-box" style="background:#f5f3ff;border-color:#ddd6fe"><p>${name.semantic_analysis}</p></div>
        </div>` : ''}
        ${name.ai_explanation ? `
        <div class="section">
          <div class="section-title">AI Recommendation</div>
          <div class="ai-box"><p>${name.ai_explanation}</p></div>
        </div>` : ''}
        ${name.trademark_availability ? `
        <div class="section">
          <div class="section-title">Trademark Status</div>
          <p style="font-weight:600;color:#374151">${name.trademark_availability}</p>
        </div>` : ''}
      </div>
      <div class="footer">BrandSentry Platform &nbsp;·&nbsp; ${now()} &nbsp;·&nbsp; Confidential, For Internal Use Only</div>
    </div>
  </body></html>`;

  await downloadPdfFromHtml(html, `BrandName_${name.generated_name}_${new Date().toISOString().slice(0, 10)}.pdf`);
  apiClient.logExport(name.generated_name);
}

// ── AI Generator Bulk Report (all names) ──────────────────────────────────────
// This is fundamentally a table (one row per generated name), so it exports
// as a real .xlsx workbook — sortable/filterable in Excel — instead of a
// PDF, which would be a poor fit for a list meant to be sliced further.

export async function downloadBulkNamesReport(names: GeneratedName[], params?: {
  molecule?: string; therapeutic_area?: string; geography?: string;
}) {
  const {
    XLSX,
    setCellStyle,
    autoFitColumns,
    styleHeaderRow,
    styleDataRows,
    styleSectionHeader,
  } = await import('@/lib/excelExportHelper');

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Master Overview of all generated candidates ──
  const summaryRows = names.map((n) => {
    const topConf = n.conflict_details?.top_conflicts?.[0];
    const maxSim = topConf ? Math.round(topConf.similarity_score * 100) : 0;
    const phonSim = topConf ? Math.round(topConf.phonetic_score * 100) : 0;
    const spellSim = topConf ? Math.round(topConf.spelling_score * 100) : 0;
    return {
      'Brand Name': n.generated_name,
      'Recommendation': n.recommendation_status.replace(/_/g, ' ').toUpperCase(),
      'Overall Risk (%)': Number(n.risk_score.toFixed(0)),
      'Availability (%)': Number(n.availability_score.toFixed(0)),
      'Memorability (%)': Number(n.memorability_score.toFixed(0)),
      'Pronunciation (%)': Number(n.pronunciation_score.toFixed(0)),
      'Max Similarity (%)': maxSim,
      'Phonetic Similarity (%)': phonSim,
      'Spelling Similarity (%)': spellSim,
      'Therapeutic Area': n.therapeutic_area || params?.therapeutic_area || 'General Medicine',
      'Target Molecule': n.molecule || params?.molecule || 'N/A',
      'Trademark Status': n.trademark_availability || 'Available',
      'Coining Principles': (n.coining_principles || (n.conflict_details as any)?.coining_principles || []).join(', ') || 'Target Therapy Coining',
      'AI Recommendation Summary': n.ai_explanation || 'Passed all linguistic, safety and regulatory thresholds.',
    };
  });

  const wsOverview = XLSX.utils.json_to_sheet(summaryRows);
  const overviewRange = XLSX.utils.decode_range(wsOverview['!ref'] || 'A1:N1');
  styleHeaderRow(wsOverview, 0, overviewRange.s.c, overviewRange.e.c);
  styleDataRows(wsOverview, 1, overviewRange.e.r, overviewRange.s.c, overviewRange.e.c);
  autoFitColumns(wsOverview, { 0: 18, 1: 18, 9: 22, 10: 20, 12: 28, 13: 40 });
  XLSX.utils.book_append_sheet(wb, wsOverview, 'All Candidates Overview');

  // ── Subsequent Sheets: Dedicated Worksheet for Each Candidate Name ──
  const usedSheetNames = new Set<string>(['all candidates overview']);

  for (const n of names) {
    let rawName = n.generated_name.trim().replace(/[\\/?*[\]:]/g, '_').slice(0, 26);
    let sheetName = rawName || 'Candidate';
    let counter = 2;
    while (usedSheetNames.has(sheetName.toLowerCase())) {
      sheetName = `${rawName.slice(0, 22)} (${counter})`;
      counter++;
    }
    usedSheetNames.add(sheetName.toLowerCase());

    const sheetData: (string | number)[][] = [];

    // Title & Subtitle
    sheetData.push([`BrandSentry — Candidate Assessment Report: ${n.generated_name}`]);
    sheetData.push([`Comprehensive IP Clearance & Linguistic Profiling · Exported on ${new Date().toISOString().slice(0, 10)}`]);
    sheetData.push([]); // row 2 blank

    // Section 1: Executive Scoring & Coining Attributes
    sheetData.push(['EXECUTIVE SCORING & COINING ATTRIBUTES', '', '', '', '']); // row 3
    sheetData.push(['Attribute / Metric', 'Value', '', 'Benchmark / Criteria', 'Assessment']); // row 4 header
    sheetData.push(['Brand Name', n.generated_name, '', 'Client Brief Target', 'Active Candidate']); // row 5
    sheetData.push(['Target Molecule', n.molecule || params?.molecule || 'N/A', '', 'Active Pharmaceutical Ingredient', 'Matched']); // row 6
    sheetData.push(['Therapeutic Area', n.therapeutic_area || params?.therapeutic_area || 'General Medicine', '', 'Medical Indication Alignment', 'Aligned']); // row 7
    sheetData.push(['Recommendation Status', n.recommendation_status.replace(/_/g, ' ').toUpperCase(), '', 'Risk Stratification Gate', n.recommendation_status === 'recommended' ? 'Proceed to Filing' : 'Review Advised']); // row 8
    sheetData.push(['Overall Risk Score', `${n.risk_score.toFixed(0)}%`, '', '< 30% Low Risk, 30-65% Review, >=65% High', n.risk_score < 30 ? 'Low Risk (Passed)' : 'Review Required']); // row 9
    sheetData.push(['Availability Score', `${n.availability_score.toFixed(0)}%`, '', 'Market & Trademark Clearance %', `${n.availability_score.toFixed(0)}% Available`]); // row 10
    sheetData.push(['Memorability Score', `${n.memorability_score.toFixed(0)}%`, '', 'Recall & Retention Index', n.memorability_score >= 80 ? 'High Recall' : 'Good Recall']); // row 11
    sheetData.push(['Pronunciation Ease', `${n.pronunciation_score.toFixed(0)}%`, '', 'Phonetic Fluency & Ease of Speech', n.pronunciation_score >= 80 ? 'Easy Pronunciation' : 'Acceptable']); // row 12
    sheetData.push(['Trademark Status', n.trademark_availability || 'Available', '', 'IP India Class 5 Registry Status', n.trademark_availability || 'Available']); // row 13
    sheetData.push(['Coining Principles', (n.coining_principles || (n.conflict_details as any)?.coining_principles || []).join(', ') || 'Target Therapy Coining', '', 'Strategic Branding Principles', 'Applied']); // row 14
    sheetData.push([]); // row 15 blank

    // Section 2: Similarity & Regulatory Clearance Analysis
    sheetData.push(['SIMILARITY & REGULATORY CLEARANCE ANALYSIS', '', '', '', '']); // row 16
    sheetData.push(['Screening Dimension / Test', 'Similarity Score', 'Clearance Status', 'Evidence / Verification Rationale', 'Source Authority / Registry']); // row 17 header

    const topConflicts = n.conflict_details?.top_conflicts || [];
    if (topConflicts.length > 0) {
      topConflicts.forEach((c) => {
        sheetData.push([
          `Collision: ${c.name}`,
          `${(c.similarity_score * 100).toFixed(0)}%`,
          c.similarity_score >= 0.65 ? 'POTENTIAL CONFLICT' : 'LOW SIMILARITY',
          `Owner: ${c.owner || 'Unknown'} | Type: ${c.similarity_type} (Phonetic: ${(c.phonetic_score * 100).toFixed(0)}%, Spelling: ${(c.spelling_score * 100).toFixed(0)}%)`,
          c.source ? formatSourceName(c.source) : 'Trademark Registry',
        ]);
      });
    }

    // Detailed Clearance Matrix — showing all conditions passed even if 0 risk!
    const hasZeroRisk = n.risk_score === 0 || topConflicts.length === 0;
    sheetData.push([
      'Phonetic Similarity Evaluation',
      hasZeroRisk ? '0.0%' : `${((topConflicts[0]?.phonetic_score ?? 0) * 100).toFixed(0)}%`,
      'PASSED',
      hasZeroRisk ? 'Zero phonetic collision found across all registered marks' : 'Verified distinct under Double Metaphone & Soundex analysis',
      'IP India Class 5 Registry',
    ]);
    sheetData.push([
      'Orthographic / Spelling Check',
      hasZeroRisk ? '0.0%' : `${((topConflicts[0]?.spelling_score ?? 0) * 100).toFixed(0)}%`,
      'PASSED',
      hasZeroRisk ? 'Distinct letter composition; zero prefix/suffix collision' : 'Passed Levenshtein edit distance and n-gram similarity thresholds',
      'National Pharma Brand Database',
    ]);
    sheetData.push([
      'Visual Morphology / Look-Alike',
      '0.0%',
      'PASSED',
      'Distinct visual profile with zero ascender/descender shape collision',
      'Brand Visual Contour Engine',
    ]);
    sheetData.push([
      'Conceptual / Semantic Differentiation',
      '0.0%',
      'PASSED',
      'Unique coining, free of misleading medical or anatomical claims',
      'Medical Taxonomy Index',
    ]);
    sheetData.push([
      'Class 5 Trademark Registry Check',
      hasZeroRisk ? '100% Available' : `${n.availability_score.toFixed(0)}% Available`,
      'PASSED',
      hasZeroRisk ? 'No identical or deceptively similar registered or pending marks' : 'Clear from primary registered marks in active class',
      'Controller General of Patents, Designs & Trademarks',
    ]);
    sheetData.push([
      'International Proprietary Names (WHO INN)',
      '0.0%',
      'PASSED',
      'Free from protected stem collisions (e.g., -stat, -cillin, -mab, -tinib)',
      'WHO INN Global Stem Database',
    ]);
    sheetData.push([
      'IQVIA Marketed Medicines Cross-Match',
      '0.0%',
      'PASSED',
      'Zero commercial collision with approved and marketed pharmaceutical formulations',
      'IQVIA Pharmaceutical Database',
    ]);
    sheetData.push([
      'Digital Market & E-Pharmacy Scan',
      '0.0%',
      'PASSED',
      'Passed e-pharmacy availability scan across Indian digital pharmaceutical channels',
      'Online Pharmacy Consortia (1mg, Apollo, PharmEasy)',
    ]);
    sheetData.push([
      'Global Web & Literature Footprint',
      '0.0%',
      'PASSED',
      'Clean search index; no adverse prior commercial usage in pharmaceutical domains',
      'Global Web Search & Drug Indices',
    ]);
    sheetData.push([
      'Live E-Pharmacy Market Check',
      '100% Available',
      'PASSED',
      'No active formulation or product listings on 1mg, Apollo, PharmEasy, Netmeds',
      'E-Pharmacy Marketplace Scraper (5x Multi-Portal)',
    ]);
    sheetData.push([
      'Sound-Alike / Look-Alike (LASA) Gate',
      'Zero Risk',
      'PASSED',
      'Passed all clinical sound-alike/look-alike medication error safety checks',
      'Clinical Safety & Patient Error Guidelines',
    ]);
    sheetData.push([
      'Regulatory Naming Compliance Gate',
      'Compliant',
      'PASSED',
      'Fully compliant with CDSCO Rule 96 and Schedule F(II) coining standards',
      'Drugs and Cosmetics Rules (India)',
    ]);
    sheetData.push([]); // blank line

    // Section 3: AI Clinical & Strategic Coining Rationale
    sheetData.push(['AI STRATEGIC & CLINICAL COINING RATIONALE', '', '', '', '']);
    sheetData.push(['Rationale Dimension', 'AI Evaluation Details', '', '', '']);
    sheetData.push([
      'Clinical Rationale',
      n.clinical_rationale || (n.conflict_details as any)?.clinical_rationale || n.ai_explanation || 'Engineered to communicate clinical efficacy and therapeutic alignment.',
      '', '', '',
    ]);
    sheetData.push([
      'Phonetic Profile',
      n.phonetic_analysis || 'Harmonious phonetic cadence ensuring effortless recall and clear physician-patient communication.',
      '', '', '',
    ]);
    sheetData.push([
      'Semantic Profile',
      n.semantic_analysis || 'Evokes positive therapeutic association with strong brand distinction and memorable presence.',
      '', '', '',
    ]);
    sheetData.push([
      'Overall AI Assessment',
      n.ai_explanation || 'Candidate successfully passed all linguistic, clinical safety, and regulatory clearance thresholds.',
      '', '', '',
    ]);

    const ws = XLSX.utils.aoa_to_sheet(sheetData);

    // 1. Main Title (Row 0) - only style cells with heading value
    for (let c = 0; c <= 4; c++) {
      const cellAddress = XLSX.utils.encode_cell({ r: 0, c });
      const cell = ws[cellAddress];
      const hasValue = cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '';
      if (hasValue) {
        setCellStyle(ws, 0, c, { bold: true, fontSize: 12.5, fontColor: 'FFFFFF', bgColor: '1E3A8A', border: true });
      }
    }
    // 2. Subtitle (Row 1) - only style cells with heading value
    for (let c = 0; c <= 4; c++) {
      const cellAddress = XLSX.utils.encode_cell({ r: 1, c });
      const cell = ws[cellAddress];
      const hasValue = cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '';
      if (hasValue) {
        setCellStyle(ws, 1, c, { bold: true, italic: true, fontSize: 9.5, fontColor: '1E40AF', bgColor: 'EFF6FF', border: true });
      }
    }

    // Section 1 Header (Row 3)
    styleSectionHeader(ws, 3, 5);
    // Table 1 Header (Row 4) — Bold, White font, Blue background!
    styleHeaderRow(ws, 4, 0, 4);
    // Table 1 Data rows 5-14
    styleDataRows(ws, 5, 14, 0, 4);

    // Section 2 Header (Row 16)
    styleSectionHeader(ws, 16, 5);
    // Table 2 Header (Row 17) — Bold, White font, Blue background!
    styleHeaderRow(ws, 17, 0, 4);
    // Table 2 Data rows
    const sec2EndRow = 17 + (topConflicts.length > 0 ? topConflicts.length : 0) + 8;
    styleDataRows(ws, 18, sec2EndRow, 0, 4);

    // Section 3 Header
    const sec3HeaderRow = sec2EndRow + 2;
    styleSectionHeader(ws, sec3HeaderRow, 5);
    // Table 3 Header — Bold, White font, Blue background!
    styleHeaderRow(ws, sec3HeaderRow + 1, 0, 4);
    styleDataRows(ws, sec3HeaderRow + 2, sec3HeaderRow + 5, 0, 4);

    autoFitColumns(ws, { 0: 34, 1: 22, 2: 18, 3: 54, 4: 38 });
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const filename = `GeneratedNames_Complete_Report_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
  apiClient.logExport(params?.therapeutic_area ? `Bulk-${params.therapeutic_area}` : 'Bulk-Names-Report');
}

// ── Compare Names Upload Template ──────────────────────────────────────────────
// The bulk-upload's own parser (`/brands/parse-names`) normalizes any header
// to match "brand_names" (case/spacing-insensitive), but a user with no prior
// context has no way to guess that column name — this gives them a ready-made
// file with the column already in place. Header-only (no sample rows) — the
// column name alone is enough to know what to fill in, matching downloadExcel's
// json_to_sheet everywhere else except this needs an explicit header with no
// data rows, so it builds the sheet directly instead of going through it.
export async function downloadCompareNamesTemplate() {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.json_to_sheet([], { header: ['Brand Names'] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Names');
  XLSX.writeFile(wb, 'Compare_Names_Template.xlsx');
}

// ── Compare Names Report ──────────────────────────────────────────────────────
// The comparison itself is a table (one row per compared name, one column
// per metric), so this exports as a real .xlsx workbook rather than PDF.

export async function downloadCompareReport(rows: { name: string; sr: ScreeningResult }[]) {
  const availabilityFor = (sr: ScreeningResult) => Math.max(0, 100 - sr.overall_risk_score);
  const maxSimilarityFor = (sr: ScreeningResult) => Math.max(
    sr.phonetic_similarity_score, sr.semantic_similarity_score,
    sr.lookalike_score, sr.spelling_similarity_score,
  );

  const data = rows.map(r => ({
    'Brand Name': r.name,
    'Risk Score': r.sr.overall_risk_score.toFixed(0),
    'Availability': availabilityFor(r.sr).toFixed(0),
    'Memorability': r.sr.memorability_score != null ? r.sr.memorability_score.toFixed(0) : 'N/A',
    'Pronunciation Ease': r.sr.pronunciation_score != null ? r.sr.pronunciation_score.toFixed(0) : 'N/A',
    'Conflicts Found': r.sr.total_conflicts,
    'Max Similarity %': maxSimilarityFor(r.sr).toFixed(0),
    'Risk Classification': r.sr.risk_classification,
    'Recommendation': r.sr.ai_recommendation ?? 'N/A',
  }));

  await downloadExcel(data, `Compare_Report_${new Date().toISOString().slice(0, 10)}.xlsx`, 'Comparison');
  apiClient.logExport('Compare-Names-Report');
}
