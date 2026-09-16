import React, { useState, useMemo, useEffect } from 'react';
import { usePersistentState } from '@/lib/usePersistentState';
import { useRouter } from 'next/router';
import { useQuery } from '@tanstack/react-query';
import {
  FileSpreadsheet,
  Download,
  Search,
  Layers,
  Sparkles,
  Scale,
  ArrowUpDown,
  RefreshCw,
  Loader2,
  FileText,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { apiClient } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { XLSX, formatFullTableWorksheet, formatRowsHeaders } from '@/lib/excelExportHelper';

export type ReportCategory = 'marketing' | 'trademark' | 'operational';

export function ReportsPage() {
  const router = useRouter();
  const { isSuperAdmin, isAdmin, isBrandMarketingAdmin, isTrademarkAdmin, canAccessReports, hasPermission } = useAuth();

  // Active Category & Report selection with URL synchronization
  const getInitialParam = (key: string) => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search).get(key);
      if (p) return p;
    }
    return null;
  };

  const initialReport = getInitialParam('report') || 'case_summary';
  const initialCat =
    (getInitialParam('category') as ReportCategory) ||
    (isTrademarkAdmin ? 'trademark' : 'marketing');
  const initialPage = (() => {
    const pStr = getInitialParam('page');
    if (pStr) {
      const p = parseInt(pStr, 10);
      if (!isNaN(p) && p > 0) return p;
    }
    const s = typeof window !== 'undefined' ? sessionStorage.getItem(`brandsentry_reports_page_${initialReport}`) : null;
    if (s) {
      const p = parseInt(s, 10);
      if (!isNaN(p) && p > 0) return p;
    }
    return 1;
  })();

  const [selectedReportKey, setSelectedReportKey] = useState<string>(initialReport);
  const [selectedCategory, setSelectedCategory] = useState<ReportCategory>(initialCat);

  // Filters & Sorting (persisted across reloads)
  const [dateFrom, setDateFrom] = usePersistentState('brandsentry_filter_reports_dateFrom', '');
  const [dateTo, setDateTo] = usePersistentState('brandsentry_filter_reports_dateTo', '');
  const [caseFilter, setCaseFilter] = usePersistentState('brandsentry_filter_reports_caseFilter', 'all');
  const [statusFilter, setStatusFilter] = usePersistentState('brandsentry_filter_reports_statusFilter', 'all');
  const [searchQuery, setSearchQuery] = usePersistentState('brandsentry_filter_reports_search', '');
  const [sortField, setSortField] = usePersistentState('brandsentry_filter_reports_sortField', '');
  const [sortOrder, setSortOrder] = usePersistentState<'asc' | 'desc'>('brandsentry_filter_reports_sortOrder', 'asc');
  const [isExporting, setIsExporting] = useState(false);

  // Pagination state: initialized from URL
  const [currentPage, setCurrentPage] = useState<number>(initialPage);
  const [pageSize, setPageSize] = useState(10);

  // Synchronize state with Next.js router query on route change / refresh
  useEffect(() => {
    if (!router.isReady) return;

    const reportVal = Array.isArray(router.query.report) ? router.query.report[0] : router.query.report;
    if (reportVal && reportVal !== selectedReportKey) {
      setSelectedReportKey(reportVal);
    }
    const catVal = (Array.isArray(router.query.category) ? router.query.category[0] : router.query.category) as ReportCategory | undefined;
    if (catVal && (catVal === 'marketing' || catVal === 'trademark' || catVal === 'operational') && catVal !== selectedCategory) {
      setSelectedCategory(catVal);
    }
    const pageVal = Array.isArray(router.query.page) ? router.query.page[0] : router.query.page;
    if (pageVal) {
      const p = parseInt(pageVal, 10);
      if (p && !isNaN(p) && p > 0) {
        setCurrentPage((prev) => (prev !== p ? p : prev));
      }
    }
  }, [router.isReady, router.query.report, router.query.category, router.query.page]);

  // Helper to change page and synchronize URL and sessionStorage
  const handlePageChange = (newPage: number, reportKey = selectedReportKey, category = selectedCategory) => {
    setCurrentPage(newPage);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(`brandsentry_reports_page_${reportKey}`, String(newPage));
      sessionStorage.setItem('brandsentry_reports_page', String(newPage));
    }
    if (router.isReady) {
      router.replace(
        {
          pathname: router.pathname,
          query: {
            ...router.query,
            category,
            report: reportKey,
            page: newPage,
          },
        },
        undefined,
        { shallow: true }
      );
    }
  };

  // Fetch Cases list for dropdown filter
  const { data: suggestionCases = [], refetch: refetchCases } = useQuery({
    queryKey: ['reports-suggestions-cases'],
    queryFn: () => apiClient.listSuggestions().catch(() => []),
    staleTime: 60 * 1000,
  });

  // Dynamic Live Report Data from PostgreSQL Backend
  const {
    data: liveReportData = [],
    isLoading: isLoadingReport,
    refetch: refetchReportData,
    isRefetching,
  } = useQuery({
    queryKey: ['live-report-data', selectedReportKey],
    queryFn: () => apiClient.getReportData(selectedReportKey).catch(() => []),
  });

  // Available Reports Configuration matching BRD Section 5.2.9
  const reportConfigs = useMemo(() => {
    return {
      marketing: [
        {
          key: 'case_summary',
          title: 'Case Summary Report',
          description: 'Overview of brand naming cases created by the Brand Marketing Team with submission status.',
          badge: 'MARKETING',
        },
        {
          key: 'generated_names',
          title: 'Generated Brand Names Report',
          description: 'AI-generated brand names coined per case with coining strategies and batch selections.',
          badge: 'MARKETING',
        },
        {
          key: 'brand_screening',
          title: 'Brand Screening Report',
          description: 'Summary of AI screening scores, recommendation ratings (Medium / Low), and conflict checks.',
          badge: 'MARKETING',
        },
        {
          key: 'review_batch',
          title: 'Review Batch Report',
          description: 'Review batch submission details, packaging timelines, and current trademark queue status.',
          badge: 'MARKETING',
        },
        {
          key: 'user_submissions',
          title: 'User-wise Submission Report',
          description: 'Breakdown of cases created, review batches prepared, and names submitted per user.',
          badge: 'MARKETING',
        },
      ],
      trademark: [
        {
          key: 'tm_search_results',
          title: 'Trademark Search Result Report',
          description: 'Evaluated brand names with IP risk levels, conflicting marks, pharmacy presence, and dates.',
          badge: 'TRADEMARK',
        },
        {
          key: 'approved_brands',
          title: 'Approved Brand Names Report',
          description: 'Full list of officially approved brand marks with clearance remarks and certificate dates.',
          badge: 'TRADEMARK',
        },
        {
          key: 'case_aging',
          title: 'Case Aging Report',
          description: 'Review turnaround durations, days spent in current stage, and delayed review tracking.',
          badge: 'TRADEMARK',
        },
        {
          key: 'tm_review_summary',
          title: 'Trademark Review Summary Report',
          description: 'Aggregated trademark review performance metrics: Total reviewed, approved, rejected, and turnaround time.',
          badge: 'TRADEMARK',
        },
      ],
      operational: [
        {
          key: 'ai_usage',
          title: 'AI Usage Analytics Report',
          description: 'Platform-wide AI generation, screening requests, prompt/completion token usage, and feature trends.',
          badge: 'SUPER ADMIN',
        },
      ],
    };
  }, []);

  // Update selected report if category changes
  const handleCategoryChange = (cat: ReportCategory) => {
    setSelectedCategory(cat);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('brandsentry_reports_selected_cat', cat);
    }
    const available = reportConfigs[cat];
    const newReport = available && available.length > 0 ? available[0].key : selectedReportKey;
    setSelectedReportKey(newReport);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('brandsentry_reports_selected_key', newReport);
    }
    handlePageChange(1, newReport, cat);
  };

  const handleSelectReport = (key: string) => {
    setSelectedReportKey(key);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('brandsentry_reports_selected_key', key);
    }
    handlePageChange(1, key, selectedCategory);
  };

  // Filtered & Sorted Rows from live database data
  const processedRows = useMemo(() => {
    let list = [...liveReportData];

    // Search filter across all row values
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((row) =>
        Object.values(row).some((val) =>
          String(val).toLowerCase().includes(q)
        )
      );
    }

    // Case filter
    if (caseFilter !== 'all') {
      list = list.filter((row) =>
        row.case_name?.toLowerCase().includes(caseFilter.toLowerCase()) ||
        row.molecule?.toLowerCase().includes(caseFilter.toLowerCase())
      );
    }

    // Date From / To filters
    if (dateFrom) {
      list = list.filter((row) => {
        const rowDate = row.created_date || row.generation_date || row.screening_date || row.submission_date || row.approval_date || row.submitted_date || row.review_date;
        return !rowDate || rowDate >= dateFrom;
      });
    }
    if (dateTo) {
      list = list.filter((row) => {
        const rowDate = row.created_date || row.generation_date || row.screening_date || row.submission_date || row.approval_date || row.submitted_date || row.review_date;
        return !rowDate || rowDate <= dateTo;
      });
    }

    // Status filter
    if (statusFilter !== 'all') {
      list = list.filter((row) => {
        const val = row.overall_status || row.batch_status || row.risk_level || row.aging_status || row.tm_status;
        return val && String(val).toLowerCase().includes(statusFilter.toLowerCase());
      });
    }

    // Sorting
    if (sortField) {
      list.sort((a, b) => {
        const aVal = a[sortField] ?? '';
        const bVal = b[sortField] ?? '';
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
        }
        return sortOrder === 'asc'
          ? String(aVal).localeCompare(String(bVal))
          : String(bVal).localeCompare(String(aVal));
      });
    }

    return list;
  }, [liveReportData, searchQuery, caseFilter, statusFilter, dateFrom, dateTo, sortField, sortOrder]);

  // Pagination calculation
  const totalRecords = processedRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);
  const startEntry = totalRecords > 0 ? (safeCurrentPage - 1) * pageSize + 1 : 0;
  const endEntry = Math.min(safeCurrentPage * pageSize, totalRecords);

  // Keep currentPage state in sync if totalRecords shrinks below current page
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [totalPages, currentPage]);

  const paginatedRows = useMemo(() => {
    const start = (safeCurrentPage - 1) * pageSize;
    return processedRows.slice(start, start + pageSize);
  }, [processedRows, safeCurrentPage, pageSize]);

  // Handle Sort Toggle
  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  // Export Current Report to Excel (.xlsx) (Bold blue headers + normal styled data + auto fit)
  const handleExportExcel = () => {
    try {
      setIsExporting(true);

      const formattedRows = formatRowsHeaders(processedRows);
      const ws = XLSX.utils.json_to_sheet(formattedRows);
      formatFullTableWorksheet(ws, 0);

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Report Data');

      const fileName = `BrandSentry_${selectedReportKey}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, fileName);
      toast.success(`Exported ${processedRows.length} live records to ${fileName}`);
    } catch (err) {
      toast.error('Failed to export Excel report');
    } finally {
      setIsExporting(false);
    }
  };

  // If user does not have permission to view reports per BRD Section 5.2.9
  if (!canAccessReports) {
    return (
      <div className="p-8 max-w-2xl mx-auto my-12 text-center bg-white border border-gray-200 rounded-xl shadow-sm space-y-4">
        <div className="w-12 h-12 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center mx-auto">
          <FileSpreadsheet className="w-6 h-6" />
        </div>
        <h2 className="text-xl font-bold text-gray-900">Reports & MIS Restricted</h2>
        <p className="text-sm text-gray-500">
          Reports & MIS access is reserved for Administrators and Team Admins per Section 5.2.9 of the BrandSentry BRD.
        </p>
      </div>
    );
  }

  // Active Report Details
  const activeReport = Object.values(reportConfigs)
    .flat()
    .find((r) => r.key === selectedReportKey);

  return (
    <div className="p-6 md:p-8 max-w-[1440px] mx-auto space-y-6">
      {/* Role-Gated Category Tabs */}
      {/* Category Navigators & Top-Right Refresh Button */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          {(isSuperAdmin || isAdmin || isBrandMarketingAdmin) && (
            <button
              onClick={() => handleCategoryChange('marketing')}
              className={cn(
                'px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2',
                selectedCategory === 'marketing'
                  ? 'bg-orange-600 text-white shadow-sm'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              )}
            >
              <Layers className="w-3.5 h-3.5" />
              Brand Marketing Reports
              <span className={cn('px-1.5 py-0.5 rounded text-[10px]', selectedCategory === 'marketing' ? 'bg-orange-700 text-white' : 'bg-gray-100 text-gray-600')}>
                {reportConfigs.marketing.length}
              </span>
            </button>
          )}

          {(isSuperAdmin || isAdmin || isTrademarkAdmin) && (
            <button
              onClick={() => handleCategoryChange('trademark')}
              className={cn(
                'px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2',
                selectedCategory === 'trademark'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              )}
            >
              <Scale className="w-3.5 h-3.5" />
              Trademark Clearance Reports
              <span className={cn('px-1.5 py-0.5 rounded text-[10px]', selectedCategory === 'trademark' ? 'bg-emerald-700 text-white' : 'bg-gray-100 text-gray-600')}>
                {reportConfigs.trademark.length}
              </span>
            </button>
          )}

          {(isSuperAdmin || isAdmin || hasPermission('reports', 'view_financials')) && (
            <button
              onClick={() => handleCategoryChange('operational')}
              className={cn(
                'px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2',
                selectedCategory === 'operational'
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              )}
            >
              <Sparkles className="w-3.5 h-3.5" />
              AI &amp; Operational Analytics
              <span className={cn('px-1.5 py-0.5 rounded text-[10px]', selectedCategory === 'operational' ? 'bg-purple-700 text-white' : 'bg-gray-100 text-gray-600')}>
                {reportConfigs.operational.length}
              </span>
            </button>
          )}
        </div>

        {/* Refresh button positioned beside navigators with gap */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            refetchReportData();
            refetchCases();
            toast.success('Report data refreshed from PostgreSQL');
          }}
          disabled={isLoadingReport || isRefetching}
          className="text-xs h-9 px-3 gap-1.5 border-gray-300 text-gray-700 bg-white hover:bg-gray-50 shadow-sm flex-shrink-0 cursor-pointer"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', (isLoadingReport || isRefetching) && 'animate-spin text-orange-600')} />
          Refresh
        </Button>
      </div>

      {/* Sub-Reports Selector Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        {reportConfigs[selectedCategory]?.map((rpt) => {
          const isSelected = selectedReportKey === rpt.key;
          return (
            <div
              key={rpt.key}
              onClick={() => handleSelectReport(rpt.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  handleSelectReport(rpt.key);
                }
              }}
              role="button"
              tabIndex={0}
              className={cn(
                'p-3.5 rounded-xl border cursor-pointer transition-all duration-150 flex flex-col justify-between text-left',
                isSelected
                  ? 'bg-orange-50/70 border-orange-400 shadow-sm ring-1 ring-orange-300'
                  : 'bg-white border-gray-200 hover:border-gray-300 hover:shadow-xs'
              )}
            >
              <div>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded tracking-wide', isSelected ? 'bg-orange-200 text-orange-800' : 'bg-gray-100 text-gray-600')}>
                    {rpt.badge}
                  </span>
                  {isSelected && <div className="w-2 h-2 rounded-full bg-orange-600" />}
                </div>
                <h3 className={cn('text-xs font-bold leading-snug truncate mt-1', isSelected ? 'text-orange-950' : 'text-gray-900')}>
                  {rpt.title}
                </h3>
                <p className="text-[11px] text-gray-500 line-clamp-2 mt-1 leading-relaxed">
                  {rpt.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Filter & Search Toolbar */}
      <Card className="border border-gray-200/80 bg-white shadow-sm">
        <CardContent className="p-3.5">
          <div className="flex flex-col lg:flex-row gap-3 items-center justify-between">
            {/* Search */}
            <div className="relative flex-1 w-full max-w-sm">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <Input
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder="Search within this report..."
                className="pl-9 pr-9 h-9 text-xs bg-gray-50/50 border-gray-200 w-full"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setCurrentPage(1);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded-md hover:bg-gray-100 transition-colors"
                  title="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Filters Row */}
            <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto">
              {/* Date From */}
              <div className="flex items-center gap-1.5 bg-gray-50/50 border border-gray-200 rounded-md px-2 py-1 h-9">
                <span className="text-[11px] text-gray-500 font-medium">From:</span>
                <input
                  type="date"
                  value={dateFrom}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => {
                    const val = e.target.value;
                    const today = new Date().toISOString().slice(0, 10);
                    if (val && val > today) {
                      toast.error('Future dates are not permitted');
                      return;
                    }
                    setDateFrom(val);
                    handlePageChange(1);
                  }}
                  className="bg-transparent text-xs text-gray-800 focus:outline-none"
                />
              </div>

              {/* Date To */}
              <div className="flex items-center gap-1.5 bg-gray-50/50 border border-gray-200 rounded-md px-2 py-1 h-9">
                <span className="text-[11px] text-gray-500 font-medium">To:</span>
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
                    handlePageChange(1);
                  }}
                  className="bg-transparent text-xs text-gray-800 focus:outline-none"
                />
              </div>

              {/* Case Filter */}
              <Select
                value={caseFilter}
                onValueChange={(val) => {
                  setCaseFilter(val);
                  handlePageChange(1);
                }}
              >
                <SelectTrigger className="h-9 text-xs w-48 bg-gray-50/50 border-gray-200 truncate">
                  <SelectValue placeholder="All Cases" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  <SelectItem value="all">All Cases</SelectItem>
                  {suggestionCases.map((c: any) => {
                    const label = c.case_name || `${c.generic_name} (${c.case_id || 'Case'})`;
                    return (
                      <SelectItem key={c.case_id || c.id} value={c.generic_name || c.case_id}>
                        {label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>

              {/* Reset Filters */}
              {(searchQuery || caseFilter !== 'all' || statusFilter !== 'all' || dateFrom || dateTo) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearchQuery('');
                    setCaseFilter('all');
                    setStatusFilter('all');
                    setDateFrom('');
                    setDateTo('');
                    handlePageChange(1);
                  }}
                  className="text-xs text-orange-600 hover:text-orange-700 h-9 px-2"
                >
                  Clear Filters
                </Button>
              )}

              {/* Export to Excel (.xlsx) */}
              {hasPermission('reports', 'export_mis') && (
                <Button
                  size="sm"
                  onClick={handleExportExcel}
                  disabled={isExporting || processedRows.length === 0}
                  className="text-xs h-9 px-3 gap-1.5 bg-orange-600 hover:bg-orange-700 text-white font-semibold shadow-sm flex-shrink-0"
                >
                  {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  Export Excel (.xlsx)
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Active Report Header & Data Table */}
      <Card className="border border-gray-200/80 bg-white shadow-sm overflow-hidden">
        <CardHeader className="bg-gray-50/70 border-b border-gray-200 px-5 py-3.5 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-orange-600" />
              {activeReport?.title}
              <span className="text-xs font-normal text-gray-500 ml-2">
                ({processedRows.length} {processedRows.length === 1 ? 'record' : 'records'})
              </span>
            </CardTitle>
            <p className="text-xs text-gray-500 mt-0.5">{activeReport?.description}</p>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {isLoadingReport ? (
              <div className="py-16 text-center text-gray-400">
                <Loader2 className="w-6 h-6 animate-spin mx-auto text-orange-600 mb-2" />
                <p className="text-xs text-gray-500">Querying live reporting data from PostgreSQL database…</p>
              </div>
            ) : processedRows.length === 0 ? (
              <div className="py-16 text-center text-gray-400">
                <FileText className="w-10 h-10 mx-auto mb-2 opacity-30 text-gray-400" />
                <p className="text-sm font-medium text-gray-600">No records found matching your active filters</p>
                <p className="text-xs text-gray-400 mt-1">Try broadening your date range or clearing the search query</p>
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50/90 border-b border-gray-200 text-gray-500 font-bold uppercase tracking-wider text-[11px]">
                    {Object.keys(processedRows[0] || {}).map((colKey) => (
                      <th
                        key={colKey}
                        onClick={() => handleSort(colKey)}
                        className="text-left py-3 px-4 cursor-pointer hover:bg-gray-100/70 transition-colors select-none"
                      >
                        <div className="flex items-center gap-1.5">
                          <span>{colKey.replace(/_/g, ' ')}</span>
                          <ArrowUpDown className={cn('w-3 h-3', sortField === colKey ? 'text-orange-600' : 'text-gray-400')} />
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {paginatedRows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-orange-50/40 transition-colors">
                      {Object.entries(row).map(([colKey, cellVal]: any, cIdx) => {
                        const valStr = String(cellVal ?? '—');
                        const isRiskCol = colKey.includes('risk') || colKey.includes('recommendation');
                        const isStatusCol = colKey.includes('status');

                        return (
                          <td key={cIdx} className="py-3 px-4 whitespace-nowrap">
                            {isRiskCol ? (
                              <span
                                className={cn(
                                  'px-2 py-0.5 rounded-full text-[11px] font-bold border inline-block',
                                  valStr === 'LOW' || valStr.includes('Low')
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : valStr === 'MEDIUM' || valStr.includes('Medium')
                                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                                    : 'bg-red-50 text-red-700 border-red-200'
                                )}
                              >
                                {valStr}
                              </span>
                            ) : isStatusCol ? (
                              <span
                                className={cn(
                                  'px-2 py-0.5 rounded-full text-[11px] font-semibold border inline-block',
                                  valStr.includes('Approved') || valStr.includes('Completed') || valStr.includes('Cleared')
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : valStr.includes('Under Review') || valStr.includes('Track')
                                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                                    : valStr.includes('Needs Attention') || valStr.includes('Delayed')
                                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                                    : 'bg-gray-100 text-gray-700 border-gray-200'
                                )}
                              >
                                {valStr}
                              </span>
                            ) : colKey === 'brand_name' ? (
                              <span className="font-bold text-gray-900">{valStr}</span>
                            ) : colKey === 'case_name' ? (
                              <span className="font-semibold text-gray-800">{valStr}</span>
                            ) : (
                              valStr
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination Toolbar */}
          {totalRecords > 0 && (
            <div className="px-5 py-3.5 bg-gray-50/70 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-600">
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  Showing <strong>{startEntry}</strong> to <strong>{endEntry}</strong> of <strong>{totalRecords}</strong> records
                </span>
                <div className="flex items-center gap-1.5 ml-2">
                  <span className="text-gray-500">Rows per page:</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => {
                      setPageSize(Number(v));
                      handlePageChange(1);
                    }}
                  >
                    <SelectTrigger className="h-7 w-20 text-xs bg-white border-gray-300">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="20">20</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                      <SelectItem value="100">100</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(Math.max(1, safeCurrentPage - 1))}
                  disabled={safeCurrentPage <= 1}
                  className="h-8 px-2.5 text-xs text-gray-700 gap-1 bg-white hover:bg-gray-50 border-gray-300"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Prev
                </Button>

                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.min(5, totalPages) }, (_, idx) => {
                    let pNum = idx + 1;
                    if (totalPages > 5) {
                      if (safeCurrentPage > 3) {
                        pNum = safeCurrentPage - 2 + idx;
                        if (pNum + (4 - idx) > totalPages) {
                          pNum = totalPages - 4 + idx;
                        }
                      }
                    }
                    const isCurrent = safeCurrentPage === pNum;
                    return (
                      <Button
                        key={pNum}
                        variant={isCurrent ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handlePageChange(pNum)}
                        className={cn(
                          'h-8 w-8 text-xs font-semibold p-0',
                          isCurrent
                            ? 'bg-orange-600 hover:bg-orange-700 text-white shadow-sm'
                            : 'text-gray-700 bg-white hover:bg-gray-50 border-gray-300'
                        )}
                      >
                        {pNum}
                      </Button>
                    );
                  })}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(Math.min(totalPages, safeCurrentPage + 1))}
                  disabled={safeCurrentPage >= totalPages}
                  className="h-8 px-2.5 text-xs text-gray-700 gap-1 bg-white hover:bg-gray-50 border-gray-300"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
