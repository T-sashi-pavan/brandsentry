import React, { useRef, useState } from 'react';
import { usePersistentState } from '@/lib/usePersistentState';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Database,
  FlaskConical,
  Globe,
  ShoppingCart,
  Upload,
  Loader2,
  ShieldAlert,
  Wifi,
  WifiOff,
  Landmark,
  Building2,
  Clock,
  History,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  AlertTriangle,
  Plus,
  Edit2,
  Copy,
  Trash2,
  Search,
  Download,
  FileSpreadsheet,
  ArrowUpDown,
  X,
  CheckSquare,
  Square,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { apiClient } from '@/api/client';
import { listCases } from '@/lib/caseStore';
import type { DataSourceStatus } from '@/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn, formatDate } from '@/lib/utils';

const SOURCE_ICONS: Record<string, React.ElementType> = {
  who_inn: FlaskConical,
  iqvia: Database,
  epharmacy: ShoppingCart,
  google_search: Globe,
};

type MasterDataType = 'who_inn' | 'iqvia' | 'international_market' | 'registered_not_in_use' | null;

// ===========================================================================
// Screening Data Source Row
// ===========================================================================

function DataSourceRow({
  source,
  canToggle,
}: {
  source: DataSourceStatus;
  canToggle: boolean;
}) {
  const qc = useQueryClient();
  const [showDetails, setShowDetails] = useState(false);
  const Icon = SOURCE_ICONS[source.id] ?? Database;

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => apiClient.setDataSourceEnabled(source.id, enabled),
    onSuccess: (updated) => {
      toast.success(`${updated.name} ${updated.enabled ? 'connected' : 'disconnected'}.`);
      qc.invalidateQueries({ queryKey: ['data-sources'] });
    },
    onError: () => toast.error('Could not update this data source. Please try again.'),
  });

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-4 p-4 rounded-xl border transition-colors',
          source.enabled ? 'border-gray-100 bg-white shadow-xs' : 'border-gray-200 bg-gray-50/50'
        )}
      >
        <div
          className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0',
            source.enabled ? 'bg-orange-100' : 'bg-gray-100'
          )}
        >
          <Icon className={cn('w-5 h-5', source.enabled ? 'text-orange-600' : 'text-gray-400')} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 truncate">{source.name}</p>
          <p className="text-xs text-gray-500 truncate">{source.description}</p>
        </div>
        <span
          className={cn(
            'flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full flex-shrink-0',
            source.connected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          )}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', source.connected ? 'bg-green-500' : 'bg-gray-400')} />
          {source.connected ? 'Connected' : 'Not Connected'}
        </span>
        <Button size="sm" variant="outline" className="flex-shrink-0 text-xs h-8" onClick={() => setShowDetails(true)}>
          View Details
        </Button>
      </div>

      <Dialog open={showDetails} onOpenChange={setShowDetails}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className="w-5 h-5 text-orange-600" /> {source.name}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-500">{source.description}</p>
          <p className="text-xs font-medium text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
            {source.detail}
          </p>
          {canToggle && (
            <Button
              variant="outline"
              disabled={toggleMutation.isPending}
              onClick={() => toggleMutation.mutate(!source.enabled)}
              className={cn(
                'w-full flex items-center gap-1.5',
                source.enabled
                  ? 'text-gray-500 border-gray-200 hover:border-red-200 hover:text-red-500'
                  : 'text-orange-700 border-orange-200 hover:bg-orange-50'
              )}
            >
              {toggleMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : source.enabled ? (
                <WifiOff className="w-3.5 h-3.5" />
              ) : (
                <Wifi className="w-3.5 h-3.5" />
              )}
              {source.enabled ? 'Disconnect' : 'Connect'}
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistoricalCaseRow() {
  const [showDetails, setShowDetails] = useState(false);
  const connected = listCases().length > 0;

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-4 p-4 rounded-xl border transition-colors',
          connected ? 'border-gray-100 bg-white shadow-xs' : 'border-gray-200 bg-gray-50/50'
        )}
      >
        <div
          className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0',
            connected ? 'bg-orange-100' : 'bg-gray-100'
          )}
        >
          <History className={cn('w-5 h-5', connected ? 'text-orange-600' : 'text-gray-400')} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 truncate">Historical Case Repository</p>
          <p className="text-xs text-gray-500 truncate">
            Identify previously generated, approved, rejected, or analysed brand names.
          </p>
        </div>
        <span
          className={cn(
            'flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full flex-shrink-0',
            connected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          )}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', connected ? 'bg-green-500' : 'bg-gray-400')} />
          {connected ? 'Connected' : 'Not Connected'}
        </span>
        <Button size="sm" variant="outline" className="flex-shrink-0 text-xs h-8" onClick={() => setShowDetails(true)}>
          View Details
        </Button>
      </div>

      <Dialog open={showDetails} onOpenChange={setShowDetails}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="w-5 h-5 text-orange-600" /> Historical Case Repository
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-500">
            Identify previously generated, approved, rejected, or analysed brand names.
          </p>
          <p className="text-xs font-medium text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
            {connected
              ? `${listCases().length} saved case(s) available in this session.`
              : 'No cases saved yet in this session. Create a case from AI Name Generator or Brand Analysis to populate this source.'}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ===========================================================================
// Upload Card (Block Level with File Input, Upload & Replace, and Manage Link)
// ===========================================================================

function UploadCard({
  icon: Icon,
  title,
  count,
  disabled,
  disabledNote,
  onManage,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  count: number;
  disabled?: boolean;
  disabledNote?: string;
  onManage?: () => void;
}) {
  return (
    <Card className={cn(disabled && 'opacity-60', 'border border-gray-200/80 bg-white shadow-xs flex flex-col justify-between')}>
      <CardContent className="p-5 flex flex-col justify-between h-full space-y-3">
        <div>
          <div className="w-10 h-10 rounded-xl bg-orange-50 border border-orange-100 flex items-center justify-center flex-shrink-0 mb-2">
            <Icon className="w-5 h-5 text-orange-600" />
          </div>

          <p className="font-semibold text-gray-900 text-sm truncate">{title}</p>
          <p className="text-xs text-gray-400 truncate">{count.toLocaleString()} entries loaded</p>
        </div>

        {disabled ? (
          <p className="text-xs text-gray-400 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 mt-auto">
            {disabledNote}
          </p>
        ) : (
          onManage && (
            <Button
              size="sm"
              onClick={onManage}
              className="w-full flex items-center justify-center gap-1.5 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold h-8 shadow-xs mt-auto"
            >
              Manage <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          )
        )}
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// Full Master Data List View (All features cleanly placed inside)
// ===========================================================================

function MasterDataListView({
  type,
  onBack,
}: {
  type: 'who_inn' | 'iqvia' | 'international_market' | 'registered_not_in_use';
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canSync = hasPermission('data_sources', 'sync_sources');
  const appendFileInputRef = useRef<HTMLInputElement>(null);
  const revisionFileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = usePersistentState('brandsentry_filter_datasources_search', '');
  const [sortField, setSortField] = useState<string>('brand_name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Pagination for IQVIA
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [activeFilter, setActiveFilter] = useState<boolean | undefined>(undefined);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Modals state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [isBulkUploading, setIsBulkUploading] = useState(false);
  const [isBulkDeleteModalOpen, setIsBulkDeleteModalOpen] = useState(false);
  const [isClearAllModalOpen, setIsClearAllModalOpen] = useState(false);
  const [isBulkUploadModalOpen, setIsBulkUploadModalOpen] = useState(false);
  const [pendingRevisionFile, setPendingRevisionFile] = useState<File | null>(null);

  // Form fields
  const [brandName, setBrandName] = useState('');
  const [activeIngredient, setActiveIngredient] = useState('');
  const [country, setCountry] = useState('');
  const [tmClass, setTmClass] = useState('5');
  const [appNumber, setAppNumber] = useState('');
  const [appDate, setAppDate] = useState('');
  const [statusVal, setStatusVal] = useState('Registered');
  const [validTill, setValidTill] = useState('');
  const [remarks, setRemarks] = useState('');
  const [whoRef, setWhoRef] = useState('');

  // IQVIA Specific form fields
  const [iqviaMolecules, setIqviaMolecules] = useState('');
  const [iqviaAtcIv, setIqviaAtcIv] = useState('');
  const [iqviaCompany, setIqviaCompany] = useState('');
  const [iqviaProductLaunch, setIqviaProductLaunch] = useState('');
  const [iqviaValMatCurrent, setIqviaValMatCurrent] = useState('');
  const [iqviaValMatPrev, setIqviaValMatPrev] = useState('');
  const [iqviaValGrPct, setIqviaValGrPct] = useState('');
  const [iqviaUnMatCurrent, setIqviaUnMatCurrent] = useState('');
  const [iqviaUnMatPrev, setIqviaUnMatPrev] = useState('');
  const [iqviaUnGrPct, setIqviaUnGrPct] = useState('');
  const [iqviaNoOfMol, setIqviaNoOfMol] = useState('');
  const [iqviaPlainComb, setIqviaPlainComb] = useState('PLAIN');
  const [iqviaIsActive, setIqviaIsActive] = useState(true);

  // Fetch WHO INN records (server-side pagination & search)
  const whoQuery = useQuery({
    queryKey: ['master-data-who-inn', searchQuery, page, pageSize],
    queryFn: () => apiClient.getWhoInnRecords({ q: searchQuery || undefined, page, page_size: pageSize }),
    enabled: type === 'who_inn',
  });

  // Fetch IQVIA records (with server-side pagination & search)
  const iqviaQuery = useQuery({
    queryKey: ['master-data-iqvia', searchQuery, activeFilter, page, pageSize],
    queryFn: () => apiClient.getIqviaRecords({ q: searchQuery || undefined, is_active: activeFilter, page, page_size: pageSize }),
    enabled: type === 'iqvia',
  });

  // Fetch International Market records (server-side pagination & search)
  const intlQuery = useQuery({
    queryKey: ['master-data-international-market', searchQuery, page, pageSize],
    queryFn: () => apiClient.getInternationalMarketRecords({ q: searchQuery || undefined, page, page_size: pageSize }),
    enabled: type === 'international_market',
  });

  // Fetch Registered Not in Use records (server-side pagination & search)
  const regQuery = useQuery({
    queryKey: ['master-data-registered-not-in-use', searchQuery, page, pageSize],
    queryFn: () => apiClient.getRegisteredNotInUseRecords({ q: searchQuery || undefined, page, page_size: pageSize }),
    enabled: type === 'registered_not_in_use',
  });

  const isLoading =
    type === 'who_inn'
      ? whoQuery.isLoading
      : type === 'iqvia'
      ? iqviaQuery.isLoading
      : type === 'international_market'
      ? intlQuery.isLoading
      : regQuery.isLoading;

  const records =
    (type === 'who_inn'
      ? whoQuery.data?.items
      : type === 'iqvia'
      ? iqviaQuery.data?.items
      : type === 'international_market'
      ? intlQuery.data?.items
      : regQuery.data?.items) || [];

  const totalIqviaCount = iqviaQuery.data?.total ?? 0;
  const totalIqviaPages = iqviaQuery.data?.total_pages ?? 1;

  // Total record count / page count across whichever registry is active —
  // all 4 are server-paginated now, so this drives the shared pagination
  // controls and the "Total N master records" line below.
  const totalRecordCount =
    type === 'who_inn' ? (whoQuery.data?.total ?? 0)
      : type === 'iqvia' ? totalIqviaCount
      : type === 'international_market' ? (intlQuery.data?.total ?? 0)
      : (regQuery.data?.total ?? 0);
  const totalPages =
    type === 'who_inn' ? (whoQuery.data?.total_pages ?? 1)
      : type === 'iqvia' ? totalIqviaPages
      : type === 'international_market' ? (intlQuery.data?.total_pages ?? 1)
      : (regQuery.data?.total_pages ?? 1);

  // Every registry is server-paginated now, so the header's sort affordance
  // only reorders the current page (same as IQVIA's pre-existing behavior) —
  // a full-dataset sort would need a server-side order_by, not asked for here.
  const sortedRecords = records;

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const openCreateModal = () => {
    setEditingRecord(null);
    setBrandName('');
    setActiveIngredient('');
    setCountry('');
    setTmClass('5');
    setAppNumber('');
    setAppDate('');
    setStatusVal('Registered');
    setValidTill('');
    setRemarks('');
    setWhoRef('');
    // IQVIA fields
    setIqviaMolecules('');
    setIqviaAtcIv('');
    setIqviaCompany('');
    setIqviaProductLaunch('');
    setIqviaValMatCurrent('');
    setIqviaValMatPrev('');
    setIqviaValGrPct('');
    setIqviaUnMatCurrent('');
    setIqviaUnMatPrev('');
    setIqviaUnGrPct('');
    setIqviaNoOfMol('1');
    setIqviaPlainComb('PLAIN');
    setIqviaIsActive(true);
    setIsFormOpen(true);
  };

  const openEditModal = (rec: any) => {
    setEditingRecord(rec);
    setBrandName(rec.brand_ims || rec.inn_name || rec.brand_name || '');
    setActiveIngredient(rec.active_ingredient || '');
    setCountry(rec.country || '');
    setTmClass(rec.trademark_class ? String(rec.trademark_class) : '5');
    setAppNumber(rec.application_number || '');
    setAppDate(rec.application_date ? rec.application_date.slice(0, 10) : '');
    setStatusVal(rec.status || 'Registered');
    setValidTill(rec.valid_till ? rec.valid_till.slice(0, 10) : '');
    setRemarks(rec.remarks || '');
    setWhoRef(rec.who_publication_reference || '');
    // IQVIA fields
    setIqviaMolecules(rec.molecules || '');
    setIqviaAtcIv(rec.atc_iv || '');
    setIqviaCompany(rec.company || '');
    setIqviaProductLaunch(rec.product_launch || '');
    setIqviaValMatCurrent(rec.val_mat_current != null ? String(rec.val_mat_current) : '');
    setIqviaValMatPrev(rec.val_mat_prev != null ? String(rec.val_mat_prev) : '');
    setIqviaValGrPct(rec.val_gr_pct != null ? String(rec.val_gr_pct) : '');
    setIqviaUnMatCurrent(rec.un_mat_current != null ? String(rec.un_mat_current) : '');
    setIqviaUnMatPrev(rec.un_mat_prev != null ? String(rec.un_mat_prev) : '');
    setIqviaUnGrPct(rec.un_gr_pct != null ? String(rec.un_gr_pct) : '');
    setIqviaNoOfMol(rec.no_of_mol != null ? String(rec.no_of_mol) : '1');
    setIqviaPlainComb(rec.plain_comb || 'PLAIN');
    setIqviaIsActive(rec.is_active ?? true);
    setIsFormOpen(true);
  };

  const openCopyModal = (rec: any) => {
    setEditingRecord(null);
    setBrandName(`${rec.brand_ims || rec.inn_name || rec.brand_name || ''} (Copy)`);
    setActiveIngredient(rec.active_ingredient || '');
    setCountry(rec.country || '');
    setTmClass(rec.trademark_class ? String(rec.trademark_class) : '5');
    setAppNumber(rec.application_number || '');
    setAppDate(rec.application_date ? rec.application_date.slice(0, 10) : '');
    setStatusVal(rec.status || 'Registered');
    setValidTill(rec.valid_till ? rec.valid_till.slice(0, 10) : '');
    setRemarks(rec.remarks || '');
    setWhoRef(rec.who_publication_reference || '');
    // IQVIA fields
    setIqviaMolecules(rec.molecules || '');
    setIqviaAtcIv(rec.atc_iv || '');
    setIqviaCompany(rec.company || '');
    setIqviaProductLaunch(rec.product_launch || '');
    setIqviaValMatCurrent(rec.val_mat_current != null ? String(rec.val_mat_current) : '');
    setIqviaValMatPrev(rec.val_mat_prev != null ? String(rec.val_mat_prev) : '');
    setIqviaValGrPct(rec.val_gr_pct != null ? String(rec.val_gr_pct) : '');
    setIqviaUnMatCurrent(rec.un_mat_current != null ? String(rec.un_mat_current) : '');
    setIqviaUnMatPrev(rec.un_mat_prev != null ? String(rec.un_mat_prev) : '');
    setIqviaUnGrPct(rec.un_gr_pct != null ? String(rec.un_gr_pct) : '');
    setIqviaNoOfMol(rec.no_of_mol != null ? String(rec.no_of_mol) : '1');
    setIqviaPlainComb(rec.plain_comb || 'PLAIN');
    setIqviaIsActive(rec.is_active ?? true);
    setIsFormOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (type === 'who_inn') {
        const payload = {
          inn_name: brandName,
          who_publication_reference: whoRef || undefined,
        };
        if (editingRecord) {
          return apiClient.updateWhoInnRecord(editingRecord.id, payload);
        } else {
          return apiClient.createWhoInnRecord(payload);
        }
      } else if (type === 'iqvia') {
        const payload = {
          brand_ims: brandName,
          molecules: iqviaMolecules || undefined,
          atc_iv: iqviaAtcIv || undefined,
          company: iqviaCompany || undefined,
          product_launch: iqviaProductLaunch || undefined,
          val_mat_current: iqviaValMatCurrent ? parseFloat(iqviaValMatCurrent) : undefined,
          val_mat_prev: iqviaValMatPrev ? parseFloat(iqviaValMatPrev) : undefined,
          val_gr_pct: iqviaValGrPct ? parseFloat(iqviaValGrPct) : undefined,
          un_mat_current: iqviaUnMatCurrent ? parseFloat(iqviaUnMatCurrent) : undefined,
          un_mat_prev: iqviaUnMatPrev ? parseFloat(iqviaUnMatPrev) : undefined,
          un_gr_pct: iqviaUnGrPct ? parseFloat(iqviaUnGrPct) : undefined,
          no_of_mol: iqviaNoOfMol ? parseInt(iqviaNoOfMol, 10) : undefined,
          plain_comb: iqviaPlainComb || undefined,
          is_active: iqviaIsActive,
        };
        if (editingRecord) {
          return apiClient.updateIqviaRecord(editingRecord.id, payload);
        } else {
          return apiClient.createIqviaRecord(payload);
        }
      } else if (type === 'international_market') {
        const payload = {
          brand_name: brandName,
          active_ingredient: activeIngredient || undefined,
          country: country || undefined,
        };
        if (editingRecord) {
          return apiClient.updateInternationalMarketRecord(editingRecord.id, payload);
        } else {
          return apiClient.createInternationalMarketRecord(payload);
        }
      } else {
        const payload = {
          brand_name: brandName,
          trademark_class: tmClass ? parseInt(tmClass, 10) : undefined,
          application_number: appNumber || undefined,
          application_date: appDate ? new Date(appDate).toISOString() : undefined,
          status: statusVal || undefined,
          valid_till: validTill ? new Date(validTill).toISOString() : undefined,
          remarks: remarks || undefined,
        };
        if (editingRecord) {
          return apiClient.updateRegisteredNotInUseRecord(editingRecord.id, payload);
        } else {
          return apiClient.createRegisteredNotInUseRecord(payload);
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-data-who-inn'] });
      qc.invalidateQueries({ queryKey: ['master-data-iqvia'] });
      qc.invalidateQueries({ queryKey: ['master-data-international-market'] });
      qc.invalidateQueries({ queryKey: ['master-data-registered-not-in-use'] });
      qc.invalidateQueries({ queryKey: ['reference-data-status'] });
      qc.invalidateQueries({ queryKey: ['data-sources'] });
      toast.success(editingRecord ? 'Record updated in database' : 'New record created in database');
      setIsFormOpen(false);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || 'Failed to save record.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (type === 'who_inn') {
        return apiClient.deleteWhoInnRecord(id);
      } else if (type === 'iqvia') {
        return apiClient.deleteIqviaRecord(id);
      } else if (type === 'international_market') {
        return apiClient.deleteInternationalMarketRecord(id);
      } else {
        return apiClient.deleteRegisteredNotInUseRecord(id);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-data-who-inn'] });
      qc.invalidateQueries({ queryKey: ['master-data-iqvia'] });
      qc.invalidateQueries({ queryKey: ['master-data-international-market'] });
      qc.invalidateQueries({ queryKey: ['master-data-registered-not-in-use'] });
      qc.invalidateQueries({ queryKey: ['reference-data-status'] });
      qc.invalidateQueries({ queryKey: ['data-sources'] });
      toast.success('Record deleted from master data');
      setDeleteTarget(null);
    },
    onError: () => toast.error('Failed to delete record.'),
  });

  const toggleIqviaActiveMutation = useMutation({
    mutationFn: (id: string) => apiClient.toggleIqviaRecordActive(id),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['master-data-iqvia'] });
      qc.invalidateQueries({ queryKey: ['data-sources'] });
      qc.invalidateQueries({ queryKey: ['reference-data-status'] });
      toast.success(`"${updated.brand_ims}" marked as ${updated.is_active ? 'Active' : 'Inactive'}`);
    },
    onError: () => toast.error('Failed to update record status.'),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (clearAll: boolean) =>
      apiClient.bulkDeleteIqviaRecords({
        ids: clearAll ? undefined : Array.from(selectedIds),
        clear_all: clearAll,
      }),
    onSuccess: (res) => {
      setSelectedIds(new Set());
      setIsBulkDeleteModalOpen(false);
      setIsClearAllModalOpen(false);
      qc.invalidateQueries({ queryKey: ['master-data-iqvia'] });
      qc.invalidateQueries({ queryKey: ['data-sources'] });
      qc.invalidateQueries({ queryKey: ['reference-data-status'] });
      toast.success(res.message);
    },
    onError: () => toast.error('Failed to delete records.'),
  });

  const invalidateMasterDataQueries = () => {
    qc.invalidateQueries({ queryKey: ['master-data-who-inn'] });
    qc.invalidateQueries({ queryKey: ['master-data-iqvia'] });
    qc.invalidateQueries({ queryKey: ['master-data-international-market'] });
    qc.invalidateQueries({ queryKey: ['master-data-registered-not-in-use'] });
    qc.invalidateQueries({ queryKey: ['reference-data-status'] });
    qc.invalidateQueries({ queryKey: ['data-sources'] });
  };

  // "Upload File" — adds rows, keeps existing records (server skips duplicate names).
  const handleAppendUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsBulkUploading(true);
      const res =
        type === 'who_inn' ? await apiClient.uploadWhoInnPdfAppend(file)
          : type === 'iqvia' ? await apiClient.uploadIqviaAppend(file)
          : type === 'international_market' ? await apiClient.uploadInternationalMarketAppend(file)
          : await apiClient.uploadRegisteredNotInUseAppend(file);
      toast.success(res.message);
      invalidateMasterDataQueries();
      setIsBulkUploadModalOpen(false);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Upload failed.');
    } finally {
      setIsBulkUploading(false);
      if (appendFileInputRef.current) appendFileInputRef.current.value = '';
    }
  };

  // "Revision Upload" — picking a file here only stages it; the actual
  // replace-all only runs once the user confirms in the dialog below,
  // since it permanently deletes every existing record for this registry.
  const handleRevisionFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPendingRevisionFile(file);
  };

  const confirmRevisionUpload = async () => {
    const file = pendingRevisionFile;
    if (!file) return;

    try {
      setIsBulkUploading(true);
      if (type === 'who_inn') {
        const res = await apiClient.uploadWhoInnPdf(file);
        toast.success(res.message);
      } else if (type === 'iqvia') {
        const res = await apiClient.uploadIqvia(file);
        toast.success(res.message);
      } else if (type === 'international_market') {
        const res = await apiClient.uploadInternationalMarket(file);
        toast.success(res.message);
      } else {
        const res = await apiClient.uploadRegisteredNotInUse(file);
        toast.success(res.message);
      }
      invalidateMasterDataQueries();
      setIsBulkUploadModalOpen(false);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Revision upload failed.');
    } finally {
      setIsBulkUploading(false);
      setPendingRevisionFile(null);
      if (revisionFileInputRef.current) revisionFileInputRef.current.value = '';
    }
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === records.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(records.map((r: any) => r.id)));
    }
  };

  const title =
    type === 'who_inn'
      ? 'WHO INN Registry Master Data'
      : type === 'iqvia'
      ? 'IQVIA Extract Master Data'
      : type === 'international_market'
      ? 'International Markets Master Data'
      : 'Registered but Not in Use Master Data';

  const subtitle =
    type === 'who_inn'
      ? 'Exact template: Sr No. | INN Name | W.H.O Publication Reference'
      : type === 'iqvia'
      ? '13 Required Columns: BRAND_IMS | MOLECULES | ATC_IV | COMPANY | PRODUCT_LAUNCH | VAL_MAT_JUN_26 | VAL_MAT_JUN_25 | VAL_GR_PCT | UN_MAT_JUN_26 | UN_MAT_JUN_25 | UN_GR_PCT | NO_OF_MOL | PLAIN_COMB'
      : type === 'international_market'
      ? 'Exact template: Sr No. | Mark | Molecule'
      : 'Exact template: Sl No | TradeMark Name | Class | Appl No | Appl Date | TMR STATUS | Valid till | Description';

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-200">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onBack}
            className="h-9 px-3 gap-1.5 border-gray-300 text-gray-700 bg-white shadow-xs hover:bg-gray-50"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Data Sources
          </Button>
          <div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">{title}</h1>
            <p className="text-xs text-gray-500 line-clamp-1">{subtitle}</p>
          </div>
        </div>

        {/* Action Toolbar Inside Master Details View — Export / Bulk Upload / Add Record */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Export */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (type === 'who_inn') apiClient.exportWhoInnMasterData();
              else if (type === 'iqvia') apiClient.exportIqviaMasterData();
              else if (type === 'international_market') apiClient.exportInternationalMarketMasterData();
              else apiClient.exportRegisteredNotInUseMasterData();
              toast.success('Exporting current master data...');
            }}
            className="text-xs h-9 gap-1.5 border-gray-300 text-gray-700 bg-white shadow-xs"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-green-600" />
            Export
          </Button>

          {/* Bulk Upload — opens a modal with Download Template / Upload File (add) / Revision Upload (replace) */}
          {canSync && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsBulkUploadModalOpen(true)}
              className="text-xs h-9 gap-1.5 border-purple-200 text-purple-700 bg-purple-50 hover:bg-purple-100 shadow-xs font-semibold"
            >
              <Upload className="w-3.5 h-3.5" />
              Bulk Upload
            </Button>
          )}

          {/* Add Single Record */}
          {canSync && (
            <Button
              size="sm"
              onClick={openCreateModal}
              className="text-xs h-9 gap-1.5 bg-orange-600 hover:bg-orange-700 text-white font-semibold shadow-sm"
            >
              <Plus className="w-4 h-4" />
              Add Single Record
            </Button>
          )}
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <Card className="border border-gray-200/80 bg-white shadow-sm">
        <CardContent className="p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 w-full max-w-xl">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <Input
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                placeholder={type === 'iqvia' ? 'Search by Brand IMS, Molecules, or Company...' : 'Search master data records...'}
                className="pl-9 pr-9 h-9 text-xs bg-gray-50/50 border-gray-200"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setPage(1);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded-md hover:bg-gray-100 transition-colors"
                  title="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {type === 'iqvia' && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <Button
                  size="sm"
                  variant={activeFilter === undefined ? 'default' : 'outline'}
                  onClick={() => { setActiveFilter(undefined); setPage(1); }}
                  className="text-[11px] h-9 px-2.5"
                >
                  All
                </Button>
                <Button
                  size="sm"
                  variant={activeFilter === true ? 'default' : 'outline'}
                  onClick={() => { setActiveFilter(true); setPage(1); }}
                  className="text-[11px] h-9 px-2.5"
                >
                  Active Only
                </Button>
                <Button
                  size="sm"
                  variant={activeFilter === false ? 'default' : 'outline'}
                  onClick={() => { setActiveFilter(false); setPage(1); }}
                  className="text-[11px] h-9 px-2.5"
                >
                  Inactive
                </Button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            {type === 'iqvia' && selectedIds.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setIsBulkDeleteModalOpen(true)}
                className="text-xs h-9 gap-1.5 font-semibold"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete Selected ({selectedIds.size})
              </Button>
            )}

            {type === 'iqvia' && totalIqviaCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsClearAllModalOpen(true)}
                className="text-xs h-9 gap-1.5 border-red-200 text-red-600 hover:bg-red-50 font-medium"
              >
                Clear Entire Dataset
              </Button>
            )}

            <span className="text-xs font-medium text-gray-500 flex-shrink-0">
              Total <strong>{totalRecordCount.toLocaleString()}</strong> master records
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="border border-gray-200/80 bg-white shadow-sm overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {isLoading ? (
              <div className="py-16 text-center text-gray-400">
                <Loader2 className="w-6 h-6 animate-spin mx-auto text-orange-600 mb-2" />
                Loading master records...
              </div>
            ) : sortedRecords.length === 0 ? (
              <div className="py-16 text-center text-gray-400">
                <Database className="w-10 h-10 mx-auto mb-2 opacity-30 text-gray-400" />
                <p className="text-sm font-medium text-gray-600">No master data records loaded</p>
                <p className="text-xs text-gray-400 mt-1">
                  Click "Add Single Record" to create an entry or use "Bulk Upload" to import a file.
                </p>
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50/90 border-b border-gray-200 text-gray-500 font-bold uppercase tracking-wider text-[10px]">
                    {type === 'iqvia' && (
                      <th className="py-3 px-3 text-center w-8">
                        <button
                          type="button"
                          onClick={toggleSelectAll}
                          className="text-gray-500 hover:text-gray-900"
                        >
                          {selectedIds.size === records.length && records.length > 0 ? (
                            <CheckSquare className="w-4 h-4 text-orange-600" />
                          ) : (
                            <Square className="w-4 h-4 text-gray-400" />
                          )}
                        </button>
                      </th>
                    )}

                    <th
                      onClick={() => handleSort('brand_name')}
                      className="text-left py-3.5 px-3 cursor-pointer hover:bg-gray-100"
                    >
                      <div className="flex items-center gap-1">
                        <span>{type === 'who_inn' ? 'INN NAME' : type === 'iqvia' ? 'BRAND IMS' : 'MARK / BRAND NAME'}</span>
                        <ArrowUpDown className="w-3 h-3 text-gray-400" />
                      </div>
                    </th>

                    {type === 'who_inn' ? (
                      <th className="text-left py-3.5 px-4">W.H.O PUBLICATION REFERENCE</th>
                    ) : type === 'iqvia' ? (
                      <>
                        <th className="text-left py-3.5 px-3 min-w-[140px]">MOLECULES</th>
                        <th className="text-left py-3.5 px-2">ATC IV</th>
                        <th className="text-left py-3.5 px-3 min-w-[120px]">COMPANY</th>
                        <th className="text-left py-3.5 px-2">LAUNCH</th>
                        <th className="text-right py-3.5 px-2">VAL MAT (CURR)</th>
                        <th className="text-right py-3.5 px-2">VAL MAT (PREV)</th>
                        <th className="text-right py-3.5 px-2">VAL GR %</th>
                        <th className="text-right py-3.5 px-2">UN MAT (CURR)</th>
                        <th className="text-right py-3.5 px-2">UN MAT (PREV)</th>
                        <th className="text-right py-3.5 px-2">UN GR %</th>
                        <th className="text-center py-3.5 px-2">MOL</th>
                        <th className="text-center py-3.5 px-2">COMB</th>
                        <th className="text-center py-3.5 px-2">STATUS</th>
                      </>
                    ) : type === 'international_market' ? (
                      <th className="text-left py-3.5 px-4">MOLECULE / ACTIVE INGREDIENT</th>
                    ) : (
                      <>
                        <th className="text-left py-3.5 px-4">CLASS</th>
                        <th className="text-left py-3.5 px-4">APPL NO</th>
                        <th className="text-left py-3.5 px-4">STATUS</th>
                        <th className="text-left py-3.5 px-4">DESCRIPTION / REMARKS</th>
                      </>
                    )}

                    <th className="text-left py-3.5 px-3">CREATED</th>
                    <th className="text-center py-3.5 px-3 w-28">ACTIONS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {sortedRecords.map((rec: any) => {
                    const isSelected = selectedIds.has(rec.id);
                    return (
                      <tr
                        key={rec.id}
                        className={cn(
                          'hover:bg-orange-50/40 transition-colors',
                          isSelected && 'bg-orange-50/60',
                          type === 'iqvia' && !rec.is_active && 'opacity-60 bg-gray-50/50'
                        )}
                      >
                        {type === 'iqvia' && (
                          <td className="py-2.5 px-3 text-center">
                            <button
                              type="button"
                              onClick={() => toggleSelectRow(rec.id)}
                              className="text-gray-500 hover:text-gray-900"
                            >
                              {isSelected ? (
                                <CheckSquare className="w-4 h-4 text-orange-600" />
                              ) : (
                                <Square className="w-4 h-4 text-gray-400" />
                              )}
                            </button>
                          </td>
                        )}

                        <td className="py-2.5 px-3 font-bold text-gray-900">
                          {rec.brand_ims || rec.inn_name || rec.brand_name}
                        </td>

                        {type === 'who_inn' ? (
                          <td className="py-2.5 px-4 text-gray-600 font-medium">
                            {rec.who_publication_reference || '—'}
                          </td>
                        ) : type === 'iqvia' ? (
                          <>
                            <td className="py-2.5 px-3 text-gray-600 font-medium max-w-xs truncate" title={rec.molecules || ''}>
                              {rec.molecules || '—'}
                            </td>
                            <td className="py-2.5 px-2 text-gray-500 font-mono text-[11px]">{rec.atc_iv || '—'}</td>
                            <td className="py-2.5 px-3 text-gray-700 font-medium truncate max-w-[150px]" title={rec.company || ''}>
                              {rec.company || '—'}
                            </td>
                            <td className="py-2.5 px-2 text-gray-500 text-[11px]">{rec.product_launch || '—'}</td>
                            <td className="py-2.5 px-2 text-right font-mono text-gray-800">
                              {rec.val_mat_current != null ? Number(rec.val_mat_current).toLocaleString() : '—'}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-gray-500">
                              {rec.val_mat_prev != null ? Number(rec.val_mat_prev).toLocaleString() : '—'}
                            </td>
                            <td className="py-2.5 px-2 text-right font-semibold">
                              {rec.val_gr_pct != null ? (
                                <span className={rec.val_gr_pct >= 0 ? 'text-green-600' : 'text-red-500'}>
                                  {rec.val_gr_pct > 0 ? '+' : ''}{rec.val_gr_pct}%
                                </span>
                              ) : '—'}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-gray-800">
                              {rec.un_mat_current != null ? Number(rec.un_mat_current).toLocaleString() : '—'}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-gray-500">
                              {rec.un_mat_prev != null ? Number(rec.un_mat_prev).toLocaleString() : '—'}
                            </td>
                            <td className="py-2.5 px-2 text-right font-semibold">
                              {rec.un_gr_pct != null ? (
                                <span className={rec.un_gr_pct >= 0 ? 'text-green-600' : 'text-red-500'}>
                                  {rec.un_gr_pct > 0 ? '+' : ''}{rec.un_gr_pct}%
                                </span>
                              ) : '—'}
                            </td>
                            <td className="py-2.5 px-2 text-center text-gray-600">{rec.no_of_mol ?? '—'}</td>
                            <td className="py-2.5 px-2 text-center text-[10px] uppercase font-bold text-gray-500">{rec.plain_comb || '—'}</td>
                            <td className="py-2.5 px-2 text-center">
                              <button
                                type="button"
                                onClick={() => toggleIqviaActiveMutation.mutate(rec.id)}
                                className={cn(
                                  'px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors cursor-pointer',
                                  rec.is_active
                                    ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                                    : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'
                                )}
                                title="Click to toggle Active/Inactive"
                              >
                                {rec.is_active ? 'Active' : 'Inactive'}
                              </button>
                            </td>
                          </>
                        ) : type === 'international_market' ? (
                          <td className="py-2.5 px-4 text-gray-600 font-medium">{rec.active_ingredient || '—'}</td>
                        ) : (
                          <>
                            <td className="py-2.5 px-4 text-gray-600 font-semibold">{rec.trademark_class ? `Class ${rec.trademark_class}` : '—'}</td>
                            <td className="py-2.5 px-4 text-gray-600">{rec.application_number || '—'}</td>
                            <td className="py-2.5 px-4">
                              <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-semibold">
                                {rec.status || 'Registered'}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 text-gray-500 max-w-xs truncate">{rec.remarks || '—'}</td>
                          </>
                        )}

                        <td className="py-2.5 px-3 text-gray-400 text-[11px] whitespace-nowrap">
                          {rec.created_at ? formatDate(rec.created_at) : '—'}
                        </td>

                        <td className="py-2.5 px-3 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => openEditModal(rec)}
                              title="Edit Record"
                              className="p-1.5 rounded-lg text-gray-500 hover:text-orange-600 hover:bg-orange-50 transition-colors cursor-pointer"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => openCopyModal(rec)}
                              title="Copy / Clone Record"
                              className="p-1.5 rounded-lg text-gray-500 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer"
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setDeleteTarget(rec)}
                              title="Delete Record"
                              className="p-1.5 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination Controls — all 4 registries are server-paginated */}
          {totalRecordCount > 0 && (
            <div className="p-3 bg-gray-50/80 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-600">
              <div className="flex items-center gap-2">
                <span>Show</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  className="bg-white border border-gray-200 rounded px-2 py-1 text-xs"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span>records per page</span>
              </div>

              <div className="flex items-center gap-2">
                <span>
                  Page <strong>{page}</strong> of <strong>{totalPages}</strong> ({totalRecordCount.toLocaleString()} total items)
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add / Edit Record Modal */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className={cn(type === 'iqvia' ? 'max-w-2xl max-h-[85vh] overflow-y-auto' : 'max-w-lg')}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-bold text-gray-900">
              {editingRecord ? <Edit2 className="w-4 h-4 text-orange-600" /> : <Plus className="w-4 h-4 text-orange-600" />}
              {editingRecord ? `Edit ${type === 'iqvia' ? 'IQVIA Record' : 'Single Record'}` : `Add New ${type === 'iqvia' ? 'IQVIA Record' : 'Record'}`}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            <div>
              <label className="font-bold text-gray-700 block mb-1">
                {type === 'who_inn' ? 'INN Name' : type === 'iqvia' ? 'BRAND IMS (Brand Name)' : type === 'international_market' ? 'Mark (Brand Name)' : 'TradeMark Name'} <span className="text-red-500">*</span>
              </label>
              <Input
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder={type === 'who_inn' ? 'e.g. ABACAVIR' : type === 'iqvia' ? 'e.g. AUGMENTIN' : type === 'international_market' ? 'e.g. TICAPLET' : 'e.g. A2CLEAR'}
                className="h-9 text-xs font-semibold"
              />
            </div>

            {type === 'who_inn' ? (
              <div>
                <label className="font-bold text-gray-700 block mb-1">W.H.O Publication Reference</label>
                <Input
                  value={whoRef}
                  onChange={(e) => setWhoRef(e.target.value)}
                  placeholder="e.g. List 77 (1997)"
                  className="h-9 text-xs"
                />
              </div>
            ) : type === 'iqvia' ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">Molecules (Composition)</label>
                    <Input
                      value={iqviaMolecules}
                      onChange={(e) => setIqviaMolecules(e.target.value)}
                      placeholder="e.g. AMOXICILLIN+CLAVULANIC ACID"
                      className="h-9 text-xs"
                    />
                  </div>
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">Company (Manufacturer)</label>
                    <Input
                      value={iqviaCompany}
                      onChange={(e) => setIqviaCompany(e.target.value)}
                      placeholder="e.g. GSK"
                      className="h-9 text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">ATC IV Code</label>
                    <Input
                      value={iqviaAtcIv}
                      onChange={(e) => setIqviaAtcIv(e.target.value)}
                      placeholder="e.g. J01C2"
                      className="h-9 text-xs"
                    />
                  </div>
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">Product Launch (YYYYMM)</label>
                    <Input
                      value={iqviaProductLaunch}
                      onChange={(e) => setIqviaProductLaunch(e.target.value)}
                      placeholder="e.g. 199805"
                      className="h-9 text-xs"
                    />
                  </div>
                </div>

                {/* Financial & Unit Metrics */}
                <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 space-y-3">
                  <p className="text-[11px] font-bold text-gray-700 uppercase tracking-wide">Sales &amp; Volume Metrics</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="font-semibold text-gray-600 block mb-1 text-[11px]">VAL MAT (CURRENT)</label>
                      <Input
                        type="number"
                        value={iqviaValMatCurrent}
                        onChange={(e) => setIqviaValMatCurrent(e.target.value)}
                        placeholder="e.g. 450000000"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="font-semibold text-gray-600 block mb-1 text-[11px]">VAL MAT (PREV)</label>
                      <Input
                        type="number"
                        value={iqviaValMatPrev}
                        onChange={(e) => setIqviaValMatPrev(e.target.value)}
                        placeholder="e.g. 410000000"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="font-semibold text-gray-600 block mb-1 text-[11px]">VAL GR % (Optional)</label>
                      <Input
                        type="number"
                        step="0.01"
                        value={iqviaValGrPct}
                        onChange={(e) => setIqviaValGrPct(e.target.value)}
                        placeholder="auto-derived"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="font-semibold text-gray-600 block mb-1 text-[11px]">UN MAT (CURRENT)</label>
                      <Input
                        type="number"
                        value={iqviaUnMatCurrent}
                        onChange={(e) => setIqviaUnMatCurrent(e.target.value)}
                        placeholder="e.g. 25000000"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="font-semibold text-gray-600 block mb-1 text-[11px]">UN MAT (PREV)</label>
                      <Input
                        type="number"
                        value={iqviaUnMatPrev}
                        onChange={(e) => setIqviaUnMatPrev(e.target.value)}
                        placeholder="e.g. 23500000"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="font-semibold text-gray-600 block mb-1 text-[11px]">UN GR % (Optional)</label>
                      <Input
                        type="number"
                        step="0.01"
                        value={iqviaUnGrPct}
                        onChange={(e) => setIqviaUnGrPct(e.target.value)}
                        placeholder="auto-derived"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">No. of Molecules</label>
                    <Input
                      type="number"
                      value={iqviaNoOfMol}
                      onChange={(e) => setIqviaNoOfMol(e.target.value)}
                      placeholder="1"
                      className="h-9 text-xs"
                    />
                  </div>
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">Plain / Comb</label>
                    <select
                      value={iqviaPlainComb}
                      onChange={(e) => setIqviaPlainComb(e.target.value)}
                      className="w-full bg-white border border-gray-200 rounded-md px-3 h-9 text-xs text-gray-700"
                    >
                      <option value="PLAIN">PLAIN</option>
                      <option value="COMB">COMB</option>
                    </select>
                  </div>
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">Active Status</label>
                    <select
                      value={iqviaIsActive ? 'true' : 'false'}
                      onChange={(e) => setIqviaIsActive(e.target.value === 'true')}
                      className="w-full bg-white border border-gray-200 rounded-md px-3 h-9 text-xs text-gray-700"
                    >
                      <option value="true">Active (Screening Enabled)</option>
                      <option value="false">Inactive (Disabled)</option>
                    </select>
                  </div>
                </div>
              </>
            ) : type === 'international_market' ? (
              <div>
                <label className="font-bold text-gray-700 block mb-1">Molecule (Active Ingredient)</label>
                <Input
                  value={activeIngredient}
                  onChange={(e) => setActiveIngredient(e.target.value)}
                  placeholder="e.g. TICAGRELOR"
                  className="h-9 text-xs"
                />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">Class</label>
                    <Input
                      type="number"
                      value={tmClass}
                      onChange={(e) => setTmClass(e.target.value)}
                      placeholder="5"
                      className="h-9 text-xs"
                    />
                  </div>
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">Appl No</label>
                    <Input
                      value={appNumber}
                      onChange={(e) => setAppNumber(e.target.value)}
                      placeholder="5693827"
                      className="h-9 text-xs"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">TMR Status</label>
                    <Input
                      value={statusVal}
                      onChange={(e) => setStatusVal(e.target.value)}
                      placeholder="Registered"
                      className="h-9 text-xs"
                    />
                  </div>
                  <div>
                    <label className="font-bold text-gray-700 block mb-1">Appl Date</label>
                    <Input
                      type="date"
                      value={appDate}
                      onChange={(e) => setAppDate(e.target.value)}
                      className="h-9 text-xs"
                    />
                  </div>
                </div>
                <div>
                  <label className="font-bold text-gray-700 block mb-1">Description / Remarks</label>
                  <Input
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="Dormant mark"
                    className="h-9 text-xs"
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setIsFormOpen(false)} className="text-xs h-9">
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!brandName.trim() || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
              className="bg-orange-600 hover:bg-orange-700 text-white text-xs h-9 font-semibold gap-1.5"
            >
              {saveMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {editingRecord ? 'Save Changes' : 'Create Record'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 text-red-600 flex items-center justify-center mx-auto mb-2">
            <Trash2 className="w-6 h-6" />
          </div>
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-gray-900 text-center">
              Delete Record?
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-gray-500 my-2">
            Are you sure you want to permanently delete <strong>"{deleteTarget?.brand_ims || deleteTarget?.inn_name || deleteTarget?.brand_name}"</strong> from master data?
          </p>
          <DialogFooter className="justify-center gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)} className="text-xs h-8">
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-red-600 hover:bg-red-700 text-white text-xs h-8 font-semibold"
            >
              {deleteMutation.isPending && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              Confirm Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Selected Modal */}
      <Dialog open={isBulkDeleteModalOpen} onOpenChange={setIsBulkDeleteModalOpen}>
        <DialogContent className="max-w-sm text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 text-red-600 flex items-center justify-center mx-auto mb-2">
            <Trash2 className="w-6 h-6" />
          </div>
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-gray-900 text-center">
              Delete {selectedIds.size} Selected Record(s)?
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-gray-500 my-2">
            This action cannot be undone. These records will be permanently removed from IQVIA master data.
          </p>
          <DialogFooter className="justify-center gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => setIsBulkDeleteModalOpen(false)} className="text-xs h-8">
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={bulkDeleteMutation.isPending}
              onClick={() => bulkDeleteMutation.mutate(false)}
              className="bg-red-600 hover:bg-red-700 text-white text-xs h-8 font-semibold"
            >
              {bulkDeleteMutation.isPending && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              Delete {selectedIds.size} Records
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear All Dataset Modal */}
      <Dialog open={isClearAllModalOpen} onOpenChange={setIsClearAllModalOpen}>
        <DialogContent className="max-w-sm text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 text-red-600 flex items-center justify-center mx-auto mb-2">
            <Trash2 className="w-6 h-6" />
          </div>
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-gray-900 text-center">
              Clear Entire IQVIA Dataset?
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-gray-500 my-2">
            This will permanently delete all <strong>{totalIqviaCount}</strong> IQVIA records from the system.
          </p>
          <DialogFooter className="justify-center gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => setIsClearAllModalOpen(false)} className="text-xs h-8">
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={bulkDeleteMutation.isPending}
              onClick={() => bulkDeleteMutation.mutate(true)}
              className="bg-red-600 hover:bg-red-700 text-white text-xs h-8 font-semibold"
            >
              {bulkDeleteMutation.isPending && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              Clear Entire Dataset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Upload Modal — Download Template / Upload File (add) / Revision Upload (replace) */}
      <Dialog open={isBulkUploadModalOpen} onOpenChange={setIsBulkUploadModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-gray-900">Bulk Upload</DialogTitle>
          </DialogHeader>

          <div className="space-y-3 mt-1">
            {/* Download Template */}
            <div className="flex items-center justify-between gap-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-800">Download Template</p>
                <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{subtitle}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (type === 'who_inn') apiClient.downloadWhoInnTemplate();
                  else if (type === 'iqvia') apiClient.downloadIqviaTemplate();
                  else if (type === 'international_market') apiClient.downloadInternationalMarketTemplate();
                  else apiClient.downloadRegisteredNotInUseTemplate();
                  toast.success('Downloading empty template matching official format...');
                }}
                className="text-xs h-8 gap-1.5 border-gray-300 text-gray-700 bg-white shadow-xs flex-shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </Button>
            </div>

            {/* Upload File — append, skips duplicate names, keeps existing records */}
            <div className="p-3 bg-emerald-50/60 border border-emerald-200 rounded-lg space-y-2">
              <p className="text-xs font-semibold text-emerald-800">Upload File</p>
              <p className="text-[11px] text-emerald-700/80">
                Adds new rows below the existing records. Any row whose name already exists is skipped — nothing already in the table is changed or removed.
              </p>
              <input
                type="file"
                ref={appendFileInputRef}
                accept={type === 'who_inn' ? '.pdf,.xlsx' : type === 'iqvia' ? '.xlsx,.xlsb' : '.xlsx'}
                onChange={handleAppendUploadFile}
                className="hidden"
              />
              <Button
                size="sm"
                disabled={isBulkUploading}
                onClick={() => appendFileInputRef.current?.click()}
                className="text-xs h-8 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-xs"
              >
                {isBulkUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Choose File to Add
              </Button>
            </div>

            {/* Revision Upload — replaces the entire table, confirmed separately below */}
            <div className="p-3 bg-red-50/60 border border-red-200 rounded-lg space-y-2">
              <p className="text-xs font-semibold text-red-800 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Revision Upload
              </p>
              <p className="text-[11px] text-red-700/80">
                Replaces the entire table — all {totalRecordCount.toLocaleString()} existing record(s) are permanently deleted and replaced with this file's records.
              </p>
              <input
                type="file"
                ref={revisionFileInputRef}
                accept={type === 'who_inn' ? '.pdf,.xlsx' : type === 'iqvia' ? '.xlsx,.xlsb' : '.xlsx'}
                onChange={handleRevisionFileSelected}
                className="hidden"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={isBulkUploading}
                onClick={() => revisionFileInputRef.current?.click()}
                className="text-xs h-8 gap-1.5 border-red-300 text-red-700 bg-white hover:bg-red-50 font-semibold shadow-xs"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Choose File to Replace All
              </Button>
            </div>
          </div>

          <DialogFooter className="mt-1">
            <Button variant="outline" size="sm" onClick={() => setIsBulkUploadModalOpen(false)} className="text-xs h-8">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revision Upload Confirmation — replace-all is destructive, so it's staged via
          pendingRevisionFile and only runs once the user explicitly confirms here. */}
      <Dialog open={!!pendingRevisionFile} onOpenChange={(open) => { if (!open) { setPendingRevisionFile(null); if (revisionFileInputRef.current) revisionFileInputRef.current.value = ''; } }}>
        <DialogContent className="max-w-sm text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 text-red-600 flex items-center justify-center mx-auto mb-2">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-gray-900 text-center">
              Replace All Existing Records?
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-gray-500 my-2">
            This will permanently delete all <strong>{totalRecordCount.toLocaleString()}</strong> existing {title} record(s) and replace them with the contents of <strong>"{pendingRevisionFile?.name}"</strong>. This cannot be undone.
          </p>
          <DialogFooter className="justify-center gap-2 mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setPendingRevisionFile(null); if (revisionFileInputRef.current) revisionFileInputRef.current.value = ''; }}
              className="text-xs h-8"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={isBulkUploading}
              onClick={confirmRevisionUpload}
              className="bg-red-600 hover:bg-red-700 text-white text-xs h-8 font-semibold"
            >
              {isBulkUploading && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              Confirm &amp; Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ===========================================================================
// Main Data Sources Page
// ===========================================================================

export function DataSourcesPage() {
  const { isAdmin, hasPermission } = useAuth();
  const [activeMasterData, setActiveMasterData] = usePersistentState<MasterDataType>('brandsentry_filter_datasources_activeTab', null);

  const sourcesQuery = useQuery({
    queryKey: ['data-sources'],
    queryFn: () => apiClient.getDataSources(),
  });

  const statusQuery = useQuery({
    queryKey: ['reference-data-status'],
    queryFn: () => apiClient.getReferenceDataStatus(),
  });

  // If viewing Master Data details
  if (activeMasterData) {
    return (
      <div className="min-h-screen bg-[#fffaf5] px-6 py-8">
        <div className="max-w-[1400px] mx-auto">
          <MasterDataListView
            type={activeMasterData}
            onBack={() => setActiveMasterData(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fffaf5] px-6 py-8">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Section 1: Screening Sources */}
        <div>
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
            Screening Sources{' '}
            {sourcesQuery.data && (
              <span className="text-gray-400 normal-case font-normal">
                · {sourcesQuery.data.sources.length + 1} Sources
              </span>
            )}
          </h2>
          {sourcesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading data source status…
            </div>
          ) : (
            <div className="space-y-3">
              {sourcesQuery.data?.sources.map((source) => (
                <DataSourceRow key={source.id} source={source} canToggle={hasPermission('data_sources', 'configure_apis')} />
              ))}
              <HistoricalCaseRow />
            </div>
          )}
          {!hasPermission('data_sources', 'configure_apis') && (
            <p className="text-xs text-gray-400 mt-3 flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5" /> Connect/Disconnect requires administrator privileges.
            </p>
          )}
        </div>

        {/* Section 2: Import Data & Master Registries */}
        {hasPermission('data_sources', 'sync_sources') && (
          <div>
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-1">
              Import Data &amp; Master Registries
            </h2>
            <p className="text-xs text-gray-400 mb-3">
              Click any master registry below to view records, add single entries, download templates, or perform bulk uploads.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* WHO INN */}
              <UploadCard
                icon={FlaskConical}
                title="WHO INN Registry"
                subtitle="PDF Import"
                count={statusQuery.data?.who_inn_row_count ?? 0}
                onManage={() => setActiveMasterData('who_inn')}
              />

              {/* IQVIA Extract */}
              <UploadCard
                icon={Database}
                title="IQVIA Extract"
                subtitle="Licensed Extract (.xlsx / .xlsb)"
                count={statusQuery.data?.iqvia_row_count ?? 0}
                onManage={() => setActiveMasterData('iqvia')}
              />

              {/* Registered but Not in Use */}
              <UploadCard
                icon={Landmark}
                title="Registered but Not in Use"
                subtitle="Excel Registry"
                count={statusQuery.data?.registered_not_in_use_row_count ?? 0}
                onManage={() => setActiveMasterData('registered_not_in_use')}
              />

              {/* International Market Brands */}
              <UploadCard
                icon={Building2}
                title="International Market Brands"
                subtitle="Overseas Registry"
                count={statusQuery.data?.international_market_row_count ?? 0}
                onManage={() => setActiveMasterData('international_market')}
              />
            </div>
            <p className="text-[11px] text-gray-400 mt-3 flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              WHO INN, IQVIA Extract, Registered-but-Not-in-Use, and International Market Brands are actively checked during trademark screening.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
