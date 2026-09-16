import XLSX from 'xlsx-js-style';

export { XLSX };

export interface CellStyleOptions {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  fontColor?: string; // Hex without #, e.g. "FFFFFF"
  bgColor?: string; // Hex without #, e.g. "1E40AF"
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'center' | 'bottom';
  wrapText?: boolean;
  border?: boolean;
}

/**
 * Apply styling to a specific cell in a worksheet.
 */
export function setCellStyle(ws: any, r: number, c: number, options: CellStyleOptions) {
  if (!ws) return;
  const cellAddress = XLSX.utils.encode_cell({ r, c });
  if (!ws[cellAddress]) {
    ws[cellAddress] = { t: 's', v: '' };
  }
  const cell = ws[cellAddress];

  cell.s = {
    font: {
      name: 'Segoe UI',
      sz: options.fontSize || 10,
      bold: options.bold ?? false,
      italic: options.italic ?? false,
      color: { rgb: options.fontColor || '000000' },
    },
    fill: options.bgColor
      ? {
          fgColor: { rgb: options.bgColor },
          patternType: 'solid',
        }
      : undefined,
    alignment: {
      vertical: options.vAlign || 'center',
      horizontal: options.hAlign || 'left',
      wrapText: options.wrapText ?? true,
    },
    border: options.border
      ? {
          top: { style: 'thin', color: { rgb: 'D1D5DB' } },
          bottom: { style: 'thin', color: { rgb: 'D1D5DB' } },
          left: { style: 'thin', color: { rgb: 'D1D5DB' } },
          right: { style: 'thin', color: { rgb: 'D1D5DB' } },
        }
      : undefined,
  };
}

/**
 * Auto-fits column widths for an XLSX worksheet based on cell content length
 * and applies generous padding so headers and data cells never clip or wrap awkwardly.
 */
export function autoFitColumns(ws: any, customMinWch: Record<number, number> = {}) {
  if (!ws || !ws['!ref']) return;

  const range = XLSX.utils.decode_range(ws['!ref']);
  const colWidths: { [col: number]: number } = {};

  for (let C = range.s.c; C <= range.e.c; ++C) {
    let maxLen = 10;
    for (let R = range.s.r; R <= range.e.r; ++R) {
      const cellAddress = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[cellAddress];
      if (cell && cell.v !== undefined && cell.v !== null) {
        const valStr = String(cell.v);
        const lines = valStr.split('\n');
        for (const line of lines) {
          if (line.length > maxLen) {
            maxLen = line.length;
          }
        }
      }
    }
    const minW = customMinWch[C] || 14;
    colWidths[C] = Math.min(Math.max(maxLen + 4, minW), 80);
  }

  ws['!cols'] = Object.keys(colWidths).map((c) => ({
    wch: colWidths[Number(c)],
  }));
}

/**
 * Styles main report title (e.g. BrandSentry — Trademark Review Submission Report)
 * Only cells with actual values are colored. Empty columns have no background fill.
 */
export function styleMainTitle(ws: any, rowIndex = 0, totalCols = 9) {
  for (let C = 0; C < totalCols; C++) {
    const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: C });
    const cell = ws[cellAddress];
    const hasValue = cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '';
    if (hasValue) {
      setCellStyle(ws, rowIndex, C, {
        bold: true,
        fontSize: 13,
        fontColor: 'FFFFFF',
        bgColor: '1E3A8A', // Deep Navy Blue
        hAlign: 'left',
        border: true,
      });
    }
  }
}

/**
 * Styles compliance / subtitle banner (e.g. 21 CFR Part 11 Electronic Compliance Document)
 * Only cells with actual values are colored.
 */
export function styleSubTitle(ws: any, rowIndex = 1, totalCols = 9) {
  for (let C = 0; C < totalCols; C++) {
    const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: C });
    const cell = ws[cellAddress];
    const hasValue = cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '';
    if (hasValue) {
      setCellStyle(ws, rowIndex, C, {
        bold: true,
        italic: true,
        fontSize: 10,
        fontColor: '1E40AF', // Soft Blue Text
        bgColor: 'EFF6FF', // Soft Blue Background
        hAlign: 'left',
        border: true,
      });
    }
  }
}

/**
 * Styles a section divider banner (e.g. SUBMITTED CANDIDATE BRAND NAMES OVERVIEW)
 * Only cells with actual values are colored.
 */
export function styleSectionHeader(ws: any, rowIndex: number, totalCols = 9) {
  for (let C = 0; C < totalCols; C++) {
    const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: C });
    const cell = ws[cellAddress];
    const hasValue = cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '';
    if (hasValue) {
      setCellStyle(ws, rowIndex, C, {
        bold: true,
        fontSize: 11,
        fontColor: '9A3412', // Dark Orange Accent
        bgColor: 'FFEDD5', // Amber-Orange tint
        hAlign: 'left',
        border: true,
      });
    }
  }
}

/**
 * Styles a metadata variable row (Variable name bold with light background, value in normal text)
 */
export function styleMetadataRow(ws: any, rowIndex: number, labelCol = 0, valCol = 1) {
  setCellStyle(ws, rowIndex, labelCol, {
    bold: true,
    fontSize: 10.5,
    fontColor: '1E293B',
    bgColor: 'F1F5F9', // Light Slate
    hAlign: 'left',
    border: true,
  });
  setCellStyle(ws, rowIndex, valCol, {
    bold: false,
    fontSize: 10.5,
    fontColor: '0F172A',
    bgColor: 'FFFFFF',
    hAlign: 'left',
    border: true,
  });
}

/**
 * Applies Bold font and Corporate Blue background styling to table header cells.
 * Only cells with actual values are colored.
 */
export function styleHeaderRow(
  ws: any,
  rowIndex: number,
  startCol = 0,
  endCol?: number
) {
  if (!ws || !ws['!ref']) return;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const maxC = endCol !== undefined ? endCol : range.e.c;

  for (let C = startCol; C <= maxC; ++C) {
    const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: C });
    const cell = ws[cellAddress];
    const hasValue = cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '';
    if (hasValue) {
      setCellStyle(ws, rowIndex, C, {
        bold: true,
        fontSize: 10.5,
        fontColor: 'FFFFFF',
        bgColor: '1E40AF', // Corporate Royal Blue
        hAlign: 'left',
        border: true,
      });
    }
  }
}

/**
 * Styles data rows with normal text and clean borders.
 */
export function styleDataRows(
  ws: any,
  startRow: number,
  endRow?: number,
  startCol = 0,
  endCol?: number
) {
  if (!ws || !ws['!ref']) return;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const maxR = endRow !== undefined ? endRow : range.e.r;
  const maxC = endCol !== undefined ? endCol : range.e.c;

  for (let R = startRow; R <= maxR; ++R) {
    const isEven = R % 2 === 0;
    for (let C = startCol; C <= maxC; ++C) {
      setCellStyle(ws, R, C, {
        bold: false,
        fontSize: 10,
        fontColor: '1E293B',
        bgColor: isEven ? 'F8FAFC' : 'FFFFFF',
        hAlign: 'left',
        border: true,
      });
    }
  }
}

/**
 * Formats a header key/label into Title Case with spaces:
 * - Replaces underscores (_) and hyphens (-) with spaces
 * - Capitalizes the 1st letter of each word
 * - Preserves leading asterisks (e.g. *Online/Pharmacy Presence)
 * - e.g. "created_at" -> "Created At", "prompt_tokens" -> "Prompt Tokens"
 */
export function formatHeaderTitle(str: string): string {
  if (!str) return '';
  const trimmed = String(str).trim();
  const hasAsterisk = trimmed.startsWith('*');
  const clean = hasAsterisk ? trimmed.slice(1).trim() : trimmed;

  // Replace underscores and multiple dashes with spaces
  const spaced = clean.replace(/[_-]+/g, ' ').trim();

  const words = spaced.split(/\s+/).map((word) => {
    // Preserve common pharmaceutical / clinical acronyms in uppercase
    if (/^(who|inn|id|tmr|mca|iqvia|fda|fssai|dcgi|sno|srno)$/i.test(word)) {
      return word.toUpperCase();
    }
    // If word contains a slash like Online/Pharmacy
    if (word.includes('/')) {
      return word
        .split('/')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join('/');
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });

  const formatted = words.join(' ');
  return hasAsterisk ? `*${formatted}` : formatted;
}

/**
 * Transforms an array of row objects so that all keys have Title Case and spaces instead of underscores.
 */
export function formatRowsHeaders<T extends Record<string, any>>(rows: T[]): Record<string, any>[] {
  return rows.map((row) => {
    const formatted: Record<string, any> = {};
    for (const [key, val] of Object.entries(row)) {
      formatted[formatHeaderTitle(key)] = val;
    }
    return formatted;
  });
}

/**
 * Helper to style a full generic table worksheet (Headers bold & blue, data rows clean & bordered, auto-fit)
 * Automatically ensures header row values have Title Case and spaces instead of underscores.
 */
export function formatFullTableWorksheet(ws: any, headerRowIndex = 0) {
  if (!ws || !ws['!ref']) return;
  const range = XLSX.utils.decode_range(ws['!ref']);

  // Format header cell text: capital 1st letter, replace underscores with spaces
  for (let C = range.s.c; C <= range.e.c; ++C) {
    const cellAddress = XLSX.utils.encode_cell({ r: headerRowIndex, c: C });
    const cell = ws[cellAddress];
    if (cell && typeof cell.v === 'string') {
      cell.v = formatHeaderTitle(cell.v);
    }
  }

  styleHeaderRow(ws, headerRowIndex, range.s.c, range.e.c);
  styleDataRows(ws, headerRowIndex + 1, range.e.r, range.s.c, range.e.c);
  autoFitColumns(ws);
}

