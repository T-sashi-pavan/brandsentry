import React, { useState, useRef, useEffect } from 'react';
import { usePersistentState } from '@/lib/usePersistentState';
import { useRouter } from 'next/router';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ClipboardList,
  Search,
  Download,
  FileSpreadsheet,
  FileText,
  ScanSearch,
  Sparkles,
  Lock,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Shield,
  Code2,
  ChevronDown,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { apiClient } from '@/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { AuditLog } from '@/types';
import jsPDF from 'jspdf';
import { XLSX, setCellStyle, autoFitColumns } from '@/lib/excelExportHelper';

const ACTION_CONFIG: Record<
  string,
  { label: string; icon: string; color: string; border: string }
> = {
  BRAND_SCREENING: {
    label: 'Brand Screening',
    icon: '🔍',
    color: 'bg-orange-50 text-orange-800',
    border: 'border-orange-200',
  },
  GENERATE_BRAND_NAMES: {
    label: 'Generate Brand Names',
    icon: '✨',
    color: 'bg-purple-50 text-purple-800',
    border: 'border-purple-200',
  },
  LOGIN: {
    label: 'Login',
    icon: '🔐',
    color: 'bg-emerald-50 text-emerald-800',
    border: 'border-emerald-200',
  },
  LOGIN_FAILED: {
    label: 'Login Failed',
    icon: '⚠️',
    color: 'bg-red-50 text-red-800',
    border: 'border-red-200',
  },
  LOGOUT: {
    label: 'Logout',
    icon: '👋',
    color: 'bg-amber-50 text-amber-800',
    border: 'border-amber-200',
  },
  EXPORT: {
    label: 'Export',
    icon: '📥',
    color: 'bg-rose-50 text-rose-800',
    border: 'border-rose-200',
  },
  TRADEMARK_REVIEW: {
    label: 'Trademark Review',
    icon: '⚖️',
    color: 'bg-indigo-50 text-indigo-800',
    border: 'border-indigo-200',
  },
  SETTINGS_UPDATE: {
    label: 'Settings Update',
    icon: '⚙️',
    color: 'bg-blue-50 text-blue-800',
    border: 'border-blue-200',
  },
  USER_CREATED: {
    label: 'User Created',
    icon: '👤',
    color: 'bg-teal-50 text-teal-800',
    border: 'border-teal-200',
  },
  USER_UPDATED: {
    label: 'User Updated',
    icon: '✏️',
    color: 'bg-teal-50 text-teal-800',
    border: 'border-teal-200',
  },
  USER_DEACTIVATED: {
    label: 'User Deactivated',
    icon: '🚫',
    color: 'bg-amber-50 text-amber-800',
    border: 'border-amber-200',
  },
  USER_DELETED: {
    label: 'User Deleted',
    icon: '🗑️',
    color: 'bg-red-50 text-red-800',
    border: 'border-red-200',
  },
  PROFILE_UPDATE: {
    label: 'Profile Update',
    icon: '📝',
    color: 'bg-cyan-50 text-cyan-800',
    border: 'border-cyan-200',
  },
  PASSWORD_CHANGE: {
    label: 'Password Change',
    icon: '🔑',
    color: 'bg-lime-50 text-lime-800',
    border: 'border-lime-200',
  },
};

// Format ISO string to YYYY-MM-DD HH:MM
function formatTimestamp(isoString: string): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  } catch {
    return isoString;
  }
}

export function AuditTrailPage() {
  const router = useRouter();
  const { hasPermission } = useAuth();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [searchFilter, setSearchFilter] = usePersistentState('brandsentry_filter_audit_search', '');
  const [actionFilter, setActionFilter] = usePersistentState('brandsentry_filter_audit_action', 'all');
  const [userFilter, setUserFilter] = usePersistentState('brandsentry_filter_audit_user', 'all');
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Sync page from URL query params on initial load / refresh
  useEffect(() => {
    if (router.isReady && router.query.page) {
      const p = parseInt(router.query.page as string, 10);
      if (p && !isNaN(p) && p !== page) {
        setPage(p);
      }
    }
  }, [router.isReady, router.query.page]);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    if (router.isReady) {
      router.replace(
        {
          pathname: router.pathname,
          query: { ...router.query, page: newPage },
        },
        undefined,
        { shallow: true }
      );
    }
  };

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch users for the dropdown filter
  const { data: users = [] } = useQuery({
    queryKey: ['admin-users-audit'],
    queryFn: () => apiClient.getAdminUsers().catch(() => []),
    staleTime: 60 * 1000,
  });

  // Fetch audit stats based on active filters
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['audit-stats', actionFilter, userFilter, searchFilter.trim()],
    queryFn: () =>
      apiClient.getAuditStats({
        action: actionFilter === 'all' ? undefined : actionFilter,
        user_id: userFilter === 'all' ? undefined : userFilter,
        search: searchFilter.trim() || undefined,
      }),
    staleTime: 10 * 1000,
  });

  // Fetch audit logs with query params
  const {
    data: logsData,
    isLoading: logsLoading,
  } = useQuery({
    queryKey: ['audit-logs', page, pageSize, actionFilter, userFilter, searchFilter.trim()],
    queryFn: () =>
      apiClient.getAuditLogs({
        page,
        page_size: pageSize,
        action: actionFilter === 'all' ? undefined : actionFilter,
        user_id: userFilter === 'all' ? undefined : userFilter,
        search: searchFilter.trim() || undefined,
      }),
  });

  const totalRecords = logsData?.total || 0;
  const totalPages = Math.ceil(totalRecords / pageSize) || 1;
  const items = logsData?.items || [];

  const startEntry = (page - 1) * pageSize + (items.length > 0 ? 1 : 0);
  const endEntry = Math.min(page * pageSize, totalRecords);

  // Export handlers with Corporate Blue headers, KPI metrics, and full audit details
  const handleExportExcel = async () => {
    try {
      setShowExportMenu(false);
      setIsExporting(true);
      let exportItems: AuditLog[] = [];
      let exportStats = stats;
      try {
        const [fullLogs, freshStats] = await Promise.all([
          apiClient.getAuditLogs({
            page: 1,
            page_size: 2000,
            action: actionFilter === 'all' ? undefined : actionFilter,
            user_id: userFilter === 'all' ? undefined : userFilter,
            search: searchFilter.trim() || undefined,
          }),
          apiClient.getAuditStats({
            action: actionFilter === 'all' ? undefined : actionFilter,
            user_id: userFilter === 'all' ? undefined : userFilter,
            search: searchFilter.trim() || undefined,
          }).catch(() => stats),
        ]);
        exportItems = fullLogs?.items || [];
        if (freshStats) exportStats = freshStats;
      } catch (fetchErr) {
        console.warn('Full audit logs fetch notice, falling back to loaded items:', fetchErr);
        exportItems = items;
      }
      if (!exportItems.length && items.length > 0) {
        exportItems = items;
      }

      const exportRows = exportItems.map((l) => {
        const actionCfg = ACTION_CONFIG[l.action] || { label: l.action };
        return {
          id: l.id || '—',
          timestamp: formatTimestamp(l.created_at),
          action: actionCfg.label || l.action,
          resourceType: l.resource_type || '—',
          resourceId: l.resource_id || '—',
          userName: l.user_name || 'System',
          userEmail: l.user_email || '—',
          details: l.details || '—',
          ipAddress: l.ip_address || '127.0.0.1',
          status: (l.status || 'success').toUpperCase(),
        };
      });

      const TOTAL_COLS = 10;
      const sheetData: any[][] = [
        ['BrandSentry — 21 CFR Part 11 Audit Trail Activity Log & System Summary'],
        [`Compliance Standard: 21 CFR Part 11 Electronic Records | Generated on: ${new Date().toLocaleString()}`],
        [],
        ['System Summary Metric', 'Count / Value', '', 'Audit Scope Filter', 'Current Filter State'],
        ['Total Activity Logs Recorded', exportStats?.total ?? exportRows.length, '', 'Action Filter', actionFilter === 'all' ? 'All Actions' : (ACTION_CONFIG[actionFilter]?.label || actionFilter)],
        ['Brand Screening Operations', exportStats?.screenings ?? 0, '', 'User Filter', userFilter === 'all' ? 'All Users' : (users.find((u) => u.id === userFilter)?.full_name || userFilter)],
        ['AI Brand Generations', exportStats?.generations ?? 0, '', 'Search Keyword', searchFilter.trim() || 'None (All Records)'],
        ['Authentication & User Logins', exportStats?.logins ?? 0, '', 'Total Records in Export', exportRows.length],
        [],
        [
          'Log ID',
          'Timestamp',
          'Action Event',
          'Resource Type',
          'Resource ID / Mark',
          'User Name',
          'User Email',
          'Activity Details / System Remarks',
          'IP Address',
          'Status',
        ],
        ...exportRows.map((r) => [
          r.id,
          r.timestamp,
          r.action,
          r.resourceType,
          r.resourceId,
          r.userName,
          r.userEmail,
          r.details,
          r.ipAddress,
          r.status,
        ]),
      ];

      const ws = XLSX.utils.aoa_to_sheet(sheetData);

      // 1. Style Title Row (Row 0) - only style cells with heading value (empty cells have no color)
      for (let c = 0; c < TOTAL_COLS; c++) {
        const cellAddress = XLSX.utils.encode_cell({ r: 0, c });
        const val = ws[cellAddress]?.v;
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          setCellStyle(ws, 0, c, {
            bold: true,
            fontSize: 13,
            fontColor: 'FFFFFF',
            bgColor: '1E3A8A', // Deep Navy Blue
            hAlign: 'left',
            border: true,
          });
        }
      }

      // 2. Style Subtitle Row (Row 1) - only style cells with heading value (empty cells have no color)
      for (let c = 0; c < TOTAL_COLS; c++) {
        const cellAddress = XLSX.utils.encode_cell({ r: 1, c });
        const val = ws[cellAddress]?.v;
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          setCellStyle(ws, 1, c, {
            bold: true,
            italic: true,
            fontSize: 9.5,
            fontColor: '1E40AF',
            bgColor: 'EFF6FF',
            hAlign: 'left',
            border: true,
          });
        }
      }

      // 3. Style KPI Header (Row 3)
      for (let c = 0; c < TOTAL_COLS; c++) {
        if (c === 0 || c === 1 || c === 3 || c === 4) {
          setCellStyle(ws, 3, c, {
            bold: true,
            fontSize: 10,
            fontColor: 'FFFFFF',
            bgColor: '2563EB',
            hAlign: 'left',
            border: true,
          });
        }
      }

      // 4. Style KPI Data Rows (Rows 4 to 7)
      for (let r = 4; r <= 7; r++) {
        setCellStyle(ws, r, 0, {
          bold: true,
          fontSize: 9.5,
          fontColor: '1E293B',
          bgColor: 'F1F5F9',
          hAlign: 'left',
          border: true,
        });
        setCellStyle(ws, r, 1, {
          bold: true,
          fontSize: 10,
          fontColor: '0F172A',
          bgColor: 'FFFFFF',
          hAlign: 'center',
          border: true,
        });
        setCellStyle(ws, r, 3, {
          bold: true,
          fontSize: 9.5,
          fontColor: '1E293B',
          bgColor: 'F1F5F9',
          hAlign: 'left',
          border: true,
        });
        setCellStyle(ws, r, 4, {
          bold: false,
          fontSize: 9.5,
          fontColor: '334155',
          bgColor: 'FFFFFF',
          hAlign: 'left',
          border: true,
        });
      }

      // 5. Style Table Column Headers (Row 9) -> Corporate Royal Blue (#1E40AF)
      const HEADER_ROW = 9;
      for (let c = 0; c < TOTAL_COLS; c++) {
        setCellStyle(ws, HEADER_ROW, c, {
          bold: true,
          fontSize: 10.5,
          fontColor: 'FFFFFF',
          bgColor: '1E40AF', // Corporate Blue (#1E40AF)
          hAlign: c === 1 || c === 9 ? 'center' : 'left',
          vAlign: 'center',
          border: true,
        });
      }

      // 6. Style Data Rows (Rows 10 onwards)
      const dataStartRow = 10;
      const dataEndRow = dataStartRow + exportRows.length - 1;
      for (let r = dataStartRow; r <= dataEndRow; r++) {
        const isEven = r % 2 === 0;
        const rowBg = isEven ? 'F8FAFC' : 'FFFFFF';
        for (let c = 0; c < TOTAL_COLS; c++) {
          const isStatusCol = c === 9;
          const isTimestampCol = c === 1;
          const statusVal = exportRows[r - dataStartRow]?.status;

          let cellFontColor = '1E293B';
          let cellBg = rowBg;
          let isBold = false;

          if (isStatusCol) {
            isBold = true;
            if (statusVal === 'SUCCESS') {
              cellFontColor = '166534';
              cellBg = 'DCFCE7';
            } else if (statusVal === 'FAILED') {
              cellFontColor = '991B1B';
              cellBg = 'FEE2E2';
            }
          }

          setCellStyle(ws, r, c, {
            bold: isBold,
            fontSize: 9.5,
            fontColor: cellFontColor,
            bgColor: cellBg,
            hAlign: isStatusCol || isTimestampCol ? 'center' : 'left',
            vAlign: 'center',
            wrapText: c === 7, // wrap text for Details
            border: true,
          });
        }
      }

      // 7. Auto-fit columns with custom minimum widths so nothing is truncated
      const minColWidths: Record<number, number> = {
        0: 38, // Log ID (full UUID)
        1: 22, // Timestamp
        2: 24, // Action Event
        3: 18, // Resource Type
        4: 22, // Resource ID / Mark
        5: 20, // User Name
        6: 28, // User Email
        7: 48, // Details
        8: 16, // IP Address
        9: 14, // Status
      };
      autoFitColumns(ws, minColWidths);

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Audit Trail Log');

      const fileName = `BrandSentry_AuditTrail_${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, fileName);

      await apiClient.logExport('Audit Trail', 'excel').catch(() => {});
      toast.success(`Exported ${exportRows.length} audit records to ${fileName}`);
    } catch (err) {
      console.error('Excel export failed:', err);
      toast.error(`Failed to export Excel: ${err instanceof Error ? err.message : 'Export error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportCSV = async () => {
    try {
      setShowExportMenu(false);
      setIsExporting(true);
      let exportItems: AuditLog[] = [];
      let exportStats = stats;
      try {
        const [fullLogs, freshStats] = await Promise.all([
          apiClient.getAuditLogs({
            page: 1,
            page_size: 2000,
            action: actionFilter === 'all' ? undefined : actionFilter,
            user_id: userFilter === 'all' ? undefined : userFilter,
            search: searchFilter.trim() || undefined,
          }),
          apiClient.getAuditStats({
            action: actionFilter === 'all' ? undefined : actionFilter,
            user_id: userFilter === 'all' ? undefined : userFilter,
            search: searchFilter.trim() || undefined,
          }).catch(() => stats),
        ]);
        exportItems = fullLogs?.items || [];
        if (freshStats) exportStats = freshStats;
      } catch (fetchErr) {
        console.warn('Full audit logs fetch notice, falling back to loaded items:', fetchErr);
        exportItems = items;
      }
      if (!exportItems.length && items.length > 0) {
        exportItems = items;
      }

      const exportRows = exportItems.map((l) => {
        const actionCfg = ACTION_CONFIG[l.action] || { label: l.action };
        return {
          ID: l.id,
          Timestamp: formatTimestamp(l.created_at),
          Action: actionCfg.label || l.action,
          'Resource Type': l.resource_type || '—',
          'Resource ID': l.resource_id || '—',
          User: l.user_name || 'System',
          Email: l.user_email || '—',
          Details: l.details || '—',
          'IP Address': l.ip_address || '—',
          Status: l.status,
        };
      });

      const summaryHeaderData = [
        ['BrandSentry — Audit Trail Activity Log & System Summary', ''],
        ['Generated At', new Date().toLocaleString()],
        ['Total Actions', exportStats?.total ?? exportRows.length],
        ['Screenings', exportStats?.screenings ?? 0],
        ['Generations', exportStats?.generations ?? 0],
        ['Logins', exportStats?.logins ?? 0],
        ['', ''],
        ['Log ID', 'Timestamp', 'Action', 'Resource Type', 'Resource ID', 'User', 'Email', 'Details', 'IP Address', 'Status'],
        ...exportRows.map((r) => [r.ID, r.Timestamp, r.Action, r['Resource Type'], r['Resource ID'], r.User, r.Email, r.Details, r['IP Address'], r.Status]),
      ];

      const ws = XLSX.utils.aoa_to_sheet(summaryHeaderData);
      const csv = XLSX.utils.sheet_to_csv(ws);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `BrandSentry_AuditTrail_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      await apiClient.logExport('Audit Trail', 'csv').catch(() => {});
      toast.success(`Audit trail exported as CSV (${exportRows.length} records)`);
    } catch (err) {
      console.error('CSV export failed:', err);
      toast.error(`Failed to export CSV: ${err instanceof Error ? err.message : 'Export error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportPDF = async () => {
    try {
      setShowExportMenu(false);
      setIsExporting(true);
      let exportItems: AuditLog[] = [];
      let exportStats = stats;
      try {
        const [fullLogs, freshStats] = await Promise.all([
          apiClient.getAuditLogs({
            page: 1,
            page_size: 1000,
            action: actionFilter === 'all' ? undefined : actionFilter,
            user_id: userFilter === 'all' ? undefined : userFilter,
            search: searchFilter.trim() || undefined,
          }),
          apiClient.getAuditStats({
            action: actionFilter === 'all' ? undefined : actionFilter,
            user_id: userFilter === 'all' ? undefined : userFilter,
            search: searchFilter.trim() || undefined,
          }).catch(() => stats),
        ]);
        exportItems = fullLogs?.items || [];
        if (freshStats) exportStats = freshStats;
      } catch (fetchErr) {
        console.warn('Full audit logs fetch notice for PDF, falling back to loaded items:', fetchErr);
        exportItems = items;
      }
      if (!exportItems.length && items.length > 0) {
        exportItems = items;
      }

      const doc = new jsPDF();
      doc.setFontSize(16);
      doc.setTextColor(234, 88, 12);
      doc.text('BrandSentry — Audit Trail Activity Log', 14, 18);

      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      const filterSummary = [
        actionFilter !== 'all' ? `Action: ${ACTION_CONFIG[actionFilter]?.label || actionFilter}` : '',
        userFilter !== 'all' ? `User: ${users.find((u) => u.id === userFilter)?.full_name || userFilter}` : '',
        searchFilter.trim() ? `Search: "${searchFilter.trim()}"` : '',
      ].filter(Boolean).join(' | ');
      doc.text(`Generated: ${new Date().toLocaleString()} | ${filterSummary || 'All Records'}`, 14, 25);

      doc.setDrawColor(220, 220, 220);
      doc.line(14, 28, 196, 28);

      // Summary KPI Grid Box in PDF (Total Actions, Screenings, Generations, Logins)
      doc.setFillColor(248, 250, 252);
      doc.roundedRect(14, 32, 182, 22, 2, 2, 'F');
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(14, 32, 182, 22, 2, 2, 'D');

      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(71, 85, 105);
      doc.text('TOTAL ACTIONS', 20, 39);
      doc.text('SCREENINGS', 68, 39);
      doc.text('GENERATIONS', 116, 39);
      doc.text('LOGINS', 164, 39);

      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text((exportStats?.total ?? 0).toLocaleString(), 20, 48);
      doc.setTextColor(234, 88, 12);
      doc.text((exportStats?.screenings ?? 0).toLocaleString(), 68, 48);
      doc.setTextColor(147, 51, 234);
      doc.text((exportStats?.generations ?? 0).toLocaleString(), 116, 48);
      doc.setTextColor(16, 185, 129);
      doc.text((exportStats?.logins ?? 0).toLocaleString(), 164, 48);

      let y = 62;
      doc.setFontSize(9);
      doc.setTextColor(50, 50, 50);

      exportItems.slice(0, 100).forEach((l, idx) => {
        if (y > 270) {
          doc.addPage();
          y = 20;
        }
        const time = formatTimestamp(l.created_at);
        const user = l.user_email || l.user_name || 'System';
        doc.setFont('helvetica', 'bold');
        doc.text(`${idx + 1}. [${l.action}] ${time} — ${user}`, 14, y);
        doc.setFont('helvetica', 'normal');
        doc.text(`   Details: ${l.details || '—'} (IP: ${l.ip_address || '—'})`, 14, y + 4.5);
        y += 11;
      });

      doc.save(`BrandSentry_AuditTrail_${new Date().toISOString().slice(0, 10)}.pdf`);
      await apiClient.logExport('Audit Trail', 'pdf').catch(() => {});
      toast.success(`Audit trail exported as PDF with summary KPIs (${exportItems.length} records)`);
    } catch (err) {
      console.error('PDF export failed:', err);
      toast.error(`Failed to export PDF: ${err instanceof Error ? err.message : 'Export error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-6">

      {/* 4 KPI Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Actions */}
        <Card className="border border-gray-200/80 bg-white shadow-sm hover:border-orange-200 transition-colors">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500 font-semibold mb-1">Total Actions</p>
              <p className="text-3xl font-bold text-gray-900 tracking-tight">
                {statsLoading ? '...' : (stats?.total || 0).toLocaleString()}
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
              <ClipboardList className="w-5 h-5 text-gray-600" />
            </div>
          </CardContent>
        </Card>

        {/* Screenings */}
        <Card className="border border-orange-100 bg-white shadow-sm hover:border-orange-300 transition-colors">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500 font-semibold mb-1">Screenings</p>
              <p className="text-3xl font-bold text-orange-600 tracking-tight">
                {statsLoading ? '...' : (stats?.screenings || 0).toLocaleString()}
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-orange-50 border border-orange-100 flex items-center justify-center flex-shrink-0">
              <ScanSearch className="w-5 h-5 text-orange-600" />
            </div>
          </CardContent>
        </Card>

        {/* Generations */}
        <Card className="border border-purple-100 bg-white shadow-sm hover:border-purple-300 transition-colors">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500 font-semibold mb-1">Generations</p>
              <p className="text-3xl font-bold text-purple-600 tracking-tight">
                {statsLoading ? '...' : (stats?.generations || 0).toLocaleString()}
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-purple-50 border border-purple-100 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-5 h-5 text-purple-600" />
            </div>
          </CardContent>
        </Card>

        {/* Logins */}
        <Card className="border border-emerald-100 bg-white shadow-sm hover:border-emerald-300 transition-colors">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500 font-semibold mb-1">Logins</p>
              <p className="text-3xl font-bold text-emerald-600 tracking-tight">
                {statsLoading ? '...' : (stats?.logins || 0).toLocaleString()}
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center flex-shrink-0">
              <Lock className="w-5 h-5 text-emerald-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
        <div className="relative flex-1 w-full max-w-lg">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={searchFilter}
            onChange={(e) => {
              setSearchFilter(e.target.value);
              handlePageChange(1);
            }}
            placeholder="Search by user, action, or brand name..."
            className="pl-9 pr-9 h-9 text-xs bg-white border-gray-200"
          />
          {searchFilter && (
            <button
              type="button"
              onClick={() => {
                setSearchFilter('');
                handlePageChange(1);
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded-md hover:bg-gray-100 transition-colors"
              title="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          {/* Action Filter */}
          <Select
            value={actionFilter}
            onValueChange={(v) => {
              setActionFilter(v);
              handlePageChange(1);
            }}
          >
            <SelectTrigger className="h-9 text-xs w-48 bg-white border-gray-200">
              <SelectValue placeholder="All Actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="BRAND_SCREENING">Brand Screening</SelectItem>
              <SelectItem value="GENERATE_BRAND_NAMES">Generate Brand Names</SelectItem>
              <SelectItem value="LOGIN">Login / Logout</SelectItem>
              <SelectItem value="EXPORT">Export</SelectItem>
              <SelectItem value="TRADEMARK_REVIEW">Trademark Review</SelectItem>
              <SelectItem value="SETTINGS_UPDATE">Settings Update</SelectItem>
              <SelectItem value="USER_CREATED">User Management</SelectItem>
            </SelectContent>
          </Select>

          {/* User Filter */}
          <Select
            value={userFilter}
            onValueChange={(v) => {
              setUserFilter(v);
              handlePageChange(1);
            }}
          >
            <SelectTrigger className="h-9 text-xs w-44 bg-white border-gray-200">
              <SelectValue placeholder="All Users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Users</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.full_name || u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Export Dropdown */}
          {hasPermission('audit_trail', 'export_logs') && (
            <div className="relative" ref={exportMenuRef}>
              <Button
                variant="outline"
                size="sm"
                disabled={isExporting}
                onClick={() => setShowExportMenu(!showExportMenu)}
                className="h-9 px-3.5 text-xs font-semibold text-gray-700 hover:text-orange-600 border-gray-300 gap-1.5 shadow-sm"
              >
                {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Export Audit Trail <ChevronDown className="w-3 h-3 ml-0.5 opacity-80" />
              </Button>

              {showExportMenu && (
                <div className="absolute right-0 top-full mt-1.5 w-52 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 animate-in fade-in-0 zoom-in-95">
                  <button
                    onClick={handleExportExcel}
                    className="w-full px-3.5 py-2.5 text-left text-xs font-medium text-gray-700 hover:bg-orange-50 hover:text-orange-900 flex items-center gap-2.5 transition-colors"
                  >
                    <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                    <span className="font-semibold text-gray-900">Export as Excel (.xlsx)</span>
                  </button>
                  <button
                    onClick={handleExportPDF}
                    className="w-full px-3.5 py-2 text-left text-xs font-medium text-gray-700 hover:bg-orange-50 hover:text-orange-900 flex items-center gap-2.5 transition-colors border-t border-gray-100"
                  >
                    <FileText className="w-4 h-4 text-rose-500" />
                    <span>Export as PDF (.pdf)</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Audit Log Table */}
      <Card className="border border-gray-200/80 bg-white shadow-sm overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50/80 border-b border-gray-200 text-gray-500 font-bold uppercase tracking-wider text-[11px]">
                  <th className="text-left py-3.5 px-5">ACTION</th>
                  <th className="text-left py-3.5 px-5">USER</th>
                  <th className="text-left py-3.5 px-5">DETAILS</th>
                  <th className="text-left py-3.5 px-5">TIMESTAMP</th>
                  <th className="text-left py-3.5 px-5">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-gray-700">
                {logsLoading ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-gray-400">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-orange-600 mb-2" />
                      Loading audit trail records...
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-gray-400">
                      <ClipboardList className="w-8 h-8 mx-auto mb-2 opacity-30 text-gray-400" />
                      No audit records found
                    </td>
                  </tr>
                ) : (
                  items.map((log) => {
                    const cfg =
                      ACTION_CONFIG[log.action] || {
                        label: log.action.replace(/_/g, ' '),
                        icon: '📋',
                        color: 'bg-gray-100 text-gray-700',
                        border: 'border-gray-200',
                      };

                    const userEmail = log.user_email || 'system@brandsentry.local';
                    const initial = (log.user_name || userEmail).charAt(0).toUpperCase();

                    return (
                      <tr
                        key={log.id}
                        onClick={() => setSelectedLog(log)}
                        className="hover:bg-orange-50/40 cursor-pointer transition-colors"
                      >
                        {/* ACTION */}
                        <td className="py-3.5 px-5 whitespace-nowrap">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border',
                              cfg.color,
                              cfg.border
                            )}
                          >
                            <span>{cfg.icon}</span>
                            {cfg.label}
                          </span>
                        </td>

                        {/* USER */}
                        <td className="py-3.5 px-5">
                          <div className="flex items-center gap-2.5">
                            <div className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-[10px] font-bold flex-shrink-0">
                              {initial}
                            </div>
                            <span className="text-gray-600 font-medium truncate max-w-xs block">
                              {userEmail}
                            </span>
                          </div>
                        </td>

                        {/* DETAILS */}
                        <td className="py-3.5 px-5 text-gray-700 max-w-md font-medium">
                          <p className="truncate">{log.details || '—'}</p>
                        </td>

                        {/* TIMESTAMP */}
                        <td className="py-3.5 px-5 text-gray-500 font-medium whitespace-nowrap">
                          {formatTimestamp(log.created_at)}
                        </td>

                        {/* IP */}
                        <td className="py-3.5 px-5 text-gray-400 font-mono text-[11px] whitespace-nowrap">
                          {log.ip_address || '127.0.0.1'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          <div className="p-4 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-500">
            <p>
              Showing {startEntry}–{endEntry} of {totalRecords} entries
            </p>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="h-8 px-2.5 text-xs text-gray-600 gap-1"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Prev
              </Button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, idx) => {
                const pNum = idx + 1;
                const isCurrent = page === pNum;
                return (
                  <Button
                    key={pNum}
                    variant={isCurrent ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => handlePageChange(pNum)}
                    className={cn(
                      'h-8 w-8 text-xs font-semibold',
                      isCurrent
                        ? 'bg-orange-600 hover:bg-orange-700 text-white'
                        : 'text-gray-600'
                    )}
                  >
                    {pNum}
                  </Button>
                );
              })}
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="h-8 px-2.5 text-xs text-gray-600 gap-1"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Audit Record Detail Modal */}
      <Dialog open={!!selectedLog} onOpenChange={(v) => { if (!v) setSelectedLog(null); }}>
        <DialogContent className="max-w-lg p-6 bg-white">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-gray-900 flex items-center gap-2">
              <Shield className="w-5 h-5 text-orange-600" />
              Audit Record Details
            </DialogTitle>
          </DialogHeader>

          {selectedLog && (
            <div className="space-y-4 py-2 text-xs">
              <div className="grid grid-cols-2 gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                <div>
                  <span className="text-[10px] uppercase font-bold text-gray-400 block">Record ID</span>
                  <span className="font-mono text-gray-800 text-[11px] break-all">{selectedLog.id}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-gray-400 block">Timestamp</span>
                  <span className="text-gray-800 font-semibold">{formatTimestamp(selectedLog.created_at)}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-gray-400 block">User Email</span>
                  <span className="text-gray-800 font-medium">{selectedLog.user_email || 'System'}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-gray-400 block">IP Address</span>
                  <span className="font-mono text-gray-800">{selectedLog.ip_address || '127.0.0.1'}</span>
                </div>
              </div>

              <div>
                <span className="text-[10px] uppercase font-bold text-gray-400 block mb-1">Action & Details</span>
                <p className="p-3 bg-orange-50/50 border border-orange-100 rounded-lg text-gray-800 font-medium">
                  {selectedLog.details || selectedLog.action}
                </p>
              </div>

              {selectedLog.log_metadata && Object.keys(selectedLog.log_metadata).length > 0 && (
                <div>
                  <span className="text-[10px] uppercase font-bold text-gray-400 block mb-1 flex items-center gap-1">
                    <Code2 className="w-3.5 h-3.5" /> Structured Metadata
                  </span>
                  <pre className="p-3 bg-gray-900 text-emerald-400 rounded-lg text-[11px] font-mono overflow-x-auto max-h-48">
                    {JSON.stringify(selectedLog.log_metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
