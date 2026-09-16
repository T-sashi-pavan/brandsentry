import axios, { type AxiosInstance } from 'axios';
import type {
  BrandSearchResponse, ScreeningRequest, GenerateNamesRequest,
  GeneratedName, IntelligenceData, AuditLogListResponse, User,
  LegalReview, SubmitReviewRequest,
  LegalReviewBatch, LegalReviewBatchDetail, SubmitBatchRequest,
  DataSourceStatus, CompareRequest, CompareResult, CartItem,
  DashboardMetrics,
} from '@/types';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
      // The JWT now lives only in the httpOnly access_token/refresh_token
      // cookies the backend sets on /auth/login — this makes every request
      // (and the raw axios.post/fetch calls below that don't go through
      // `this.client`) actually send them cross-origin.
      withCredentials: true,
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        const url = error.config?.url || '';
        const isLoginRequest = url.includes('/auth/login');
        const isBackgroundPoll = url.includes('/notifications');
        if (error.response?.status === 401 && !isLoginRequest && !isBackgroundPoll) {
          localStorage.removeItem('pharma_user');
          if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
            window.location.href = '/login';
          }
        }
        return Promise.reject(error);
      }
    );
  }

  // Auth & Profile
  async login(email: string, password: string) {
    const { data } = await this.client.post('/auth/login', { email, password });
    return data as { access_token: string; token_type: string; user: User };
  }

  async logout() {
    await this.client.post('/auth/logout');
  }

  async refreshToken() {
    const { data } = await this.client.post('/auth/refresh');
    return data as { access_token: string; token_type: string; user: User };
  }

  async getMe() {
    const { data } = await this.client.get('/auth/me');
    return data as User;
  }

  async ssoStatus() {
    const { data } = await this.client.get('/auth/sso/status');
    return data as { enabled: boolean };
  }

  async updateProfile(payload: { full_name?: string; department?: string }) {
    const { data } = await this.client.patch('/auth/profile', payload);
    return data as User;
  }

  async changePassword(payload: { current_password: string; new_password: string }) {
    const { data } = await this.client.post('/auth/change-password', payload);
    return data as { message: string };
  }

  // Dashboard Analytics
  async getDashboardMetrics(params: {
    date_from?: string;
    date_to?: string;
    user_id?: string;
    case_name?: string;
  } = {}) {
    const { data } = await this.client.get('/dashboard/metrics', { params });
    return data as DashboardMetrics;
  }

  // Brand Screening
  async screenBrand(request: ScreeningRequest) {
    const { data } = await this.client.post('/brands/screen', request, { timeout: 1260000 });
    return data as BrandSearchResponse;
  }

  async getBrandSearch(id: string) {
    const { data } = await this.client.get(`/brands/search/${id}`);
    return data as BrandSearchResponse;
  }

  async compareBrand(request: CompareRequest) {
    const { data } = await this.client.post('/brands/compare', request);
    return data as CompareResult;
  }

  // Brand Intelligence
  async getBrandIntelligence(brandName: string) {
    const { data } = await this.client.get(`/brands/intelligence/${encodeURIComponent(brandName)}`);
    return data as IntelligenceData;
  }

  async saveSuggestion(request: Record<string, unknown>) {
    const { data } = await this.client.post('/suggestions', request);
    return data as { id?: string; case_id?: string } & Record<string, unknown>;
  }

  async listSuggestions() {
    const { data } = await this.client.get('/suggestions');
    return data as Record<string, unknown>[];
  }

  async getSuggestion(caseId: string) {
    const { data } = await this.client.get(`/suggestions/${encodeURIComponent(caseId)}`);
    return data as Record<string, unknown>;
  }

  async updateSuggestion(caseId: string, request: Record<string, unknown>) {
    const { data } = await this.client.put(`/suggestions/${encodeURIComponent(caseId)}`, request);
    return data as Record<string, unknown>;
  }

  // Brand Name Generation (Non-Streaming)
  async generateBrandNames(request: GenerateNamesRequest) {
    const { data } = await this.client.post('/brands/generate', request, { timeout: 1260000 });
    return data as GeneratedName[];
  }

  // Brand Name Generation (Streaming SSE for Real-Time Stage Synchronization)
  async generateBrandNamesStream(
    request: GenerateNamesRequest,
    onProgress: (event: {
      stage: number;
      step_index: number;
      percent: number;
      status: string;
      title: string;
      subtitle?: string;
      error?: string;
      data?: GeneratedName[];
      live_names?: GeneratedName[];
      approved_count?: number;
      target_count?: number;
    }) => void,
    signal?: AbortSignal,
  ): Promise<GeneratedName[]> {
    // Auth rides the httpOnly access_token cookie (H-01) — this is a raw
    // fetch(), not the axios instance above, so it needs its own
    // `credentials: 'include'` to send that cookie cross-origin.
    const response = await fetch(`${BASE_URL}/brands/generate/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      credentials: 'include',
      signal,
    });

    if (!response.ok) {
      let errDetail = 'Name generation request failed';
      try {
        const errJson = await response.json();
        errDetail = errJson.detail || errDetail;
      } catch {
        errDetail = `Request failed with status ${response.status}`;
      }
      throw new Error(errDetail);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body is not readable');

    const decoder = new TextDecoder();
    let buffer = '';
    let finalResults: GeneratedName[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          try {
            const payload = JSON.parse(trimmed.slice(5).trim());
            onProgress(payload);
            if (payload.status === 'failed' && payload.error) {
              throw new Error(payload.error);
            }
            if (payload.data) {
              finalResults = payload.data as GeneratedName[];
            }
          } catch (e) {
            if (e instanceof Error && e.message !== 'Unexpected token') {
              throw e;
            }
          }
        }
      }
    }

    if (buffer.trim().startsWith('data:')) {
      try {
        const payload = JSON.parse(buffer.trim().slice(5).trim());
        onProgress(payload);
        if (payload.data) {
          finalResults = payload.data as GeneratedName[];
        }
      } catch { /* ignore */ }
    }

    return finalResults;
  }

  async getGeneratedNames(limit = 50) {
    const { data } = await this.client.get(`/brands/generated?limit=${limit}`);
    return data as GeneratedName[];
  }

  async getCaseNames(caseId: string) {
    const { data } = await this.client.get(`/brands/case-names?case_id=${encodeURIComponent(caseId)}`);
    return data as {
      names: string[];
      sources: {
        name: string;
        source: 'generator_history' | 'screening_history';
        risk_score?: number;
        risk_level?: string;
        recommendation?: string;
      }[];
    };
  }

  async parseCompareNames(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    // Raw axios.post (not `this.client`), so it needs its own withCredentials
    // to carry the httpOnly access_token cookie (H-01).
    const { data } = await axios.post(`${BASE_URL}/brands/parse-names`, fd, {
      timeout: 60000,
      withCredentials: true,
    });
    return data as { names: string[]; count: number };
  }

  // Reference Data
  async getReferenceDataStatus() {
    const { data } = await this.client.get('/reference-data/status');
    return data as {
      who_inn_row_count: number;
      iqvia_row_count: number;
      registered_not_in_use_row_count: number;
      international_market_row_count: number;
    };
  }

  async getDataSources() {
    const { data } = await this.client.get('/reference-data/data-sources');
    return data as { sources: DataSourceStatus[] };
  }

  async setDataSourceEnabled(sourceId: string, enabled: boolean) {
    const { data } = await this.client.put(`/reference-data/data-sources/${sourceId}`, { enabled });
    return data as DataSourceStatus;
  }

  private async _uploadReferenceDataFile(path: string, file: File) {
    const fd = new FormData();
    fd.append('file', file);
    // Same as parseCompareNames above: raw axios.post needs its own
    // withCredentials for the httpOnly cookie (H-01).
    const { data } = await axios.post(`${BASE_URL}${path}`, fd, {
      timeout: 180000,
      withCredentials: true,
    });
    return data as { rows_imported: number; rows_skipped?: number; message: string };
  }

  async uploadWhoInnPdf(file: File) {
    return this._uploadReferenceDataFile('/reference-data/who-inn/upload', file);
  }

  async uploadWhoInnPdfAppend(file: File) {
    return this._uploadReferenceDataFile('/reference-data/who-inn/upload-append', file);
  }

  async uploadRegisteredNotInUse(file: File) {
    return this._uploadReferenceDataFile('/reference-data/registered-not-in-use/upload', file);
  }

  async uploadRegisteredNotInUseAppend(file: File) {
    return this._uploadReferenceDataFile('/reference-data/registered-not-in-use/upload-append', file);
  }

  async uploadInternationalMarket(file: File) {
    return this._uploadReferenceDataFile('/reference-data/international-market/upload', file);
  }

  async uploadInternationalMarketAppend(file: File) {
    return this._uploadReferenceDataFile('/reference-data/international-market/upload-append', file);
  }

  // Master Data — WHO INN
  async getWhoInnRecords(params?: { q?: string; page?: number; page_size?: number }) {
    const { data } = await this.client.get('/reference-data/who-inn/records', { params });
    return data as {
      items: Array<{
        id: string;
        inn_name: string;
        normalized_name: string;
        who_publication_reference?: string;
        chembl_id?: string;
        molecule_type?: string;
        created_at?: string;
      }>;
      total: number;
      page: number;
      page_size: number;
      total_pages: number;
    };
  }

  async createWhoInnRecord(payload: { inn_name: string; who_publication_reference?: string; chembl_id?: string; molecule_type?: string }) {
    const { data } = await this.client.post('/reference-data/who-inn/records', payload);
    return data;
  }

  async updateWhoInnRecord(id: string, payload: { inn_name?: string; who_publication_reference?: string; chembl_id?: string; molecule_type?: string }) {
    const { data } = await this.client.put(`/reference-data/who-inn/records/${id}`, payload);
    return data;
  }

  async deleteWhoInnRecord(id: string) {
    const { data } = await this.client.delete(`/reference-data/who-inn/records/${id}`);
    return data;
  }

  async downloadWhoInnTemplate() {
    const response = await this.client.get('/reference-data/who-inn/template', { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'WHO_INN_Template.xlsx');
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async exportWhoInnMasterData() {
    const response = await this.client.get('/reference-data/who-inn/export', { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `WHO_INN_Registry_${new Date().toISOString().slice(0, 10)}.xlsx`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // Master Data — International Markets
  async getInternationalMarketRecords(params?: { q?: string; page?: number; page_size?: number }) {
    const { data } = await this.client.get('/reference-data/international-market/records', { params });
    return data as {
      items: Array<{
        id: string;
        brand_name: string;
        normalized_name: string;
        active_ingredient?: string;
        country?: string;
        as_of_date?: string;
        created_at?: string;
      }>;
      total: number;
      page: number;
      page_size: number;
      total_pages: number;
    };
  }

  async createInternationalMarketRecord(payload: { brand_name: string; active_ingredient?: string; country?: string; as_of_date?: string }) {
    const { data } = await this.client.post('/reference-data/international-market/records', payload);
    return data;
  }

  async updateInternationalMarketRecord(id: string, payload: { brand_name?: string; active_ingredient?: string; country?: string; as_of_date?: string }) {
    const { data } = await this.client.put(`/reference-data/international-market/records/${id}`, payload);
    return data;
  }

  async deleteInternationalMarketRecord(id: string) {
    const { data } = await this.client.delete(`/reference-data/international-market/records/${id}`);
    return data;
  }

  async downloadInternationalMarketTemplate() {
    const response = await this.client.get('/reference-data/international-market/template', { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'International_Markets_Template.xlsx');
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async exportInternationalMarketMasterData() {
    const response = await this.client.get('/reference-data/international-market/export', { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `International_Market_Brands_${new Date().toISOString().slice(0, 10)}.xlsx`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // Master Data — Registered but Not in Use
  async getRegisteredNotInUseRecords(params?: { q?: string; page?: number; page_size?: number }) {
    const { data } = await this.client.get('/reference-data/registered-not-in-use/records', { params });
    return data as {
      items: Array<{
        id: string;
        brand_name: string;
        normalized_name: string;
        trademark_class?: number;
        application_number?: string;
        application_date?: string;
        status?: string;
        valid_till?: string;
        remarks?: string;
        as_of_date?: string;
        created_at?: string;
      }>;
      total: number;
      page: number;
      page_size: number;
      total_pages: number;
    };
  }

  async createRegisteredNotInUseRecord(payload: {
    brand_name: string;
    trademark_class?: number;
    application_number?: string;
    application_date?: string;
    status?: string;
    valid_till?: string;
    remarks?: string;
    as_of_date?: string;
  }) {
    const { data } = await this.client.post('/reference-data/registered-not-in-use/records', payload);
    return data;
  }

  async updateRegisteredNotInUseRecord(id: string, payload: {
    brand_name?: string;
    trademark_class?: number;
    application_number?: string;
    application_date?: string;
    status?: string;
    valid_till?: string;
    remarks?: string;
    as_of_date?: string;
  }) {
    const { data } = await this.client.put(`/reference-data/registered-not-in-use/records/${id}`, payload);
    return data;
  }

  async deleteRegisteredNotInUseRecord(id: string) {
    const { data } = await this.client.delete(`/reference-data/registered-not-in-use/records/${id}`);
    return data;
  }

  async downloadRegisteredNotInUseTemplate() {
    const response = await this.client.get('/reference-data/registered-not-in-use/template', { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'Registered_Not_In_Use_Template.xlsx');
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async exportRegisteredNotInUseMasterData() {
    const response = await this.client.get('/reference-data/registered-not-in-use/export', { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `Registered_Not_In_Use_${new Date().toISOString().slice(0, 10)}.xlsx`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // Master Data — IQVIA Extract
  async getIqviaRecords(params?: { q?: string; is_active?: boolean; page?: number; page_size?: number }) {
    const { data } = await this.client.get('/reference-data/iqvia/records', { params });
    return data as import('@/types').IqviaPaginatedResponse;
  }

  async createIqviaRecord(payload: import('@/types').IqviaRecordCreatePayload) {
    const { data } = await this.client.post('/reference-data/iqvia/records', payload);
    return data as import('@/types').IqviaRecord;
  }

  async updateIqviaRecord(id: string, payload: import('@/types').IqviaRecordUpdatePayload) {
    const { data } = await this.client.put(`/reference-data/iqvia/records/${id}`, payload);
    return data as import('@/types').IqviaRecord;
  }

  async deleteIqviaRecord(id: string) {
    const { data } = await this.client.delete(`/reference-data/iqvia/records/${id}`);
    return data;
  }

  async bulkDeleteIqviaRecords(payload: { ids?: string[]; clear_all?: boolean }) {
    const { data } = await this.client.post('/reference-data/iqvia/records/bulk-delete', payload);
    return data as { message: string; deleted_count: number };
  }

  async toggleIqviaRecordActive(id: string) {
    const { data } = await this.client.put(`/reference-data/iqvia/records/${id}/toggle-active`);
    return data as import('@/types').IqviaRecord;
  }

  async uploadIqvia(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    const { data } = await this.client.post('/reference-data/iqvia/upload', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data as { rows_imported: number; rows_skipped?: number; message: string };
  }

  async uploadIqviaAppend(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    const { data } = await this.client.post('/reference-data/iqvia/upload-append', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data as { rows_imported: number; rows_skipped?: number; message: string };
  }

  async downloadIqviaTemplate() {
    const response = await this.client.get('/reference-data/iqvia/template', { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'IQVIA_Master_Data_Template.xlsx');
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async exportIqviaMasterData() {
    const response = await this.client.get('/reference-data/iqvia/export', { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `IQVIA_Master_Data_${new Date().toISOString().slice(0, 10)}.xlsx`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // Audit
  async getAuditLogs(params: {
    page?: number;
    page_size?: number;
    action?: string;
    resource_type?: string;
    user_id?: string;
    search?: string;
    date_from?: string;
    date_to?: string;
  } = {}) {
    const { data } = await this.client.get('/audit/logs', { params });
    return data as AuditLogListResponse;
  }

  async getAuditStats(params: {
    action?: string;
    resource_type?: string;
    user_id?: string;
    search?: string;
    date_from?: string;
    date_to?: string;
  } = {}) {
    const { data } = await this.client.get('/audit/stats', { params });
    return data as { total: number; logins: number; exports: number; screenings: number; generations: number };
  }

  async logExport(brandName: string, format = 'pdf', caseId?: string) {
    await this.client.post('/audit/log-export', {
      brand_name: brandName,
      export_format: format,
      case_id: caseId,
    }).catch(() => {});
  }

  // Admin — User Management
  async getAdminUsers() {
    const { data } = await this.client.get('/admin/users');
    return data as User[];
  }

  async getPermissionsSchema() {
    const { data } = await this.client.get('/admin/permissions/schema');
    return data as {
      available_modules: Record<string, string[]>;
      role_defaults: Record<string, import('@/types').PermissionMap>;
    };
  }

  // Edits the default template for every user assigned `role` (distinct
  // from a single user's custom_permissions override in updateAdminUser).
  async updateRolePermissions(role: string, permissions: import('@/types').PermissionMap) {
    const { data } = await this.client.put(`/admin/role-permissions/${role}`, { permissions });
    return data as { role: string; permissions: import('@/types').PermissionMap };
  }

  async createAdminUser(payload: {
    email: string; full_name: string; password: string;
    role: string; department?: string; is_superuser: boolean;
    custom_permissions?: import('@/types').PermissionMap | null;
  }) {
    const { data } = await this.client.post('/admin/users', payload);
    return data as User;
  }

  async updateAdminUser(id: string, payload: {
    full_name?: string; role?: string; department?: string;
    is_active?: boolean; is_superuser?: boolean;
    custom_permissions?: import('@/types').PermissionMap | null;
    reset_permissions?: boolean;
  }) {
    const { data } = await this.client.patch(`/admin/users/${id}`, payload);
    return data as User;
  }

  async deactivateAdminUser(id: string) {
    await this.client.delete(`/admin/users/${id}`);
  }

  async deleteAdminUser(id: string) {
    await this.client.delete(`/admin/users/${id}/permanent`);
  }

  async resetAdminUserPassword(id: string, new_password: string) {
    const { data } = await this.client.post(`/admin/users/${id}/reset-password`, { new_password });
    return data as { message: string; user_id: string };
  }

  // Legal Review
  async submitForLegalReview(request: SubmitReviewRequest) {
    const { data } = await this.client.post('/legal/submit', request);
    return data as LegalReview;
  }

  async getLegalReviews(status?: string, mine?: boolean) {
    const params: Record<string, string | boolean> = {};
    if (status) params.status = status;
    if (mine) params.mine = true;
    const { data } = await this.client.get('/legal/reviews', { params });
    return data as LegalReview[];
  }

  async getSubmittedReviewNames() {
    const { data } = await this.client.get('/legal/reviews/submitted-names');
    return data as string[];
  }

  async approveLegalReview(id: string, comments?: string, legal_ref?: string) {
    const { data } = await this.client.put(`/legal/reviews/${id}/approve`, { comments, legal_ref });
    return data as LegalReview;
  }

  async rejectLegalReview(id: string, comments?: string) {
    const { data } = await this.client.put(`/legal/reviews/${id}/reject`, { comments });
    return data as LegalReview;
  }

  async requestRevision(id: string, comments?: string) {
    const { data } = await this.client.put(`/legal/reviews/${id}/request-revision`, { comments });
    return data as LegalReview;
  }

  async resubmitLegalReview(id: string, comments?: string, rationale?: string) {
    const { data } = await this.client.put(`/legal/reviews/${id}/resubmit`, { comments, rationale });
    return data as LegalReview;
  }

  async retractLegalReview(id: string) {
    await this.client.delete(`/legal/reviews/${id}`);
  }

  async getReviewMessages(reviewId: string) {
    const { data } = await this.client.get(`/legal/reviews/${reviewId}/messages`);
    return data as import('@/types').ReviewMessage[];
  }

  async postReviewMessage(reviewId: string, message: string) {
    const { data } = await this.client.post(`/legal/reviews/${reviewId}/messages`, { message });
    return data as import('@/types').ReviewMessage;
  }

  // Review Batch cart
  async getCartItems() {
    const { data } = await this.client.get('/legal/cart');
    return data as CartItem[];
  }

  async addCartItem(item: Omit<CartItem, 'id'>) {
    const { data } = await this.client.post('/legal/cart', item);
    return data as { item: CartItem; added: boolean };
  }

  async removeCartItem(id: string) {
    await this.client.delete(`/legal/cart/${id}`);
  }

  async clearCart() {
    await this.client.delete('/legal/cart');
  }

  // Legal Review — batches
  async submitLegalBatch(request: SubmitBatchRequest) {
    const { data } = await this.client.post('/legal/batches', request);
    return data as LegalReviewBatch;
  }

  async getLegalBatches(mine?: boolean) {
    const params: Record<string, boolean> = {};
    if (mine) params.mine = true;
    const { data } = await this.client.get('/legal/batches', { params });
    return data as LegalReviewBatch[];
  }

  async getLegalBatch(id: string) {
    const { data } = await this.client.get(`/legal/batches/${id}`);
    return data as LegalReviewBatchDetail;
  }

  // Reports & MIS Data
  async getReportData(reportKey: string) {
    const { data } = await this.client.get(`/reports/${reportKey}`);
    return data as Array<Record<string, any>>;
  }

  // Data Import
  async getImportStats() {
    const { data } = await this.client.get('/admin/import/stats');
    return data as { trademark: number; market: number; epharmacy: number };
  }

  async importData(type: 'trademark' | 'market' | 'epharmacy', file: File, clearExisting = false) {
    const form = new FormData();
    form.append('file', file);
    const { data } = await this.client.post(
      `/admin/import/${type}?clear_existing=${clearExisting}`,
      form,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
    return data as { type: string; inserted: number; skipped: number; errors: string[]; total_rows: number };
  }

  async downloadImportTemplate(type: 'trademark' | 'market' | 'epharmacy') {
    const response = await this.client.get(`/admin/import/template/${type}`, { responseType: 'blob' });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type === 'trademark' ? 'ip_india_trademark' : type === 'market' ? 'cdsco_market' : 'epharmacy'}_template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async clearImportData(type: 'trademark' | 'market' | 'epharmacy') {
    const { data } = await this.client.delete(`/admin/import/${type}`);
    return data as { deleted: number; type: string };
  }

  // Notifications
  async getNotifications() {
    const { data } = await this.client.get('/notifications');
    return data as import('@/types').Notification[];
  }

  async getUnreadCount() {
    const { data } = await this.client.get('/notifications/unread-count');
    return data as { count: number };
  }

  async markNotificationRead(id: string) {
    await this.client.put(`/notifications/${id}/read`);
  }

  async markAllNotificationsRead() {
    await this.client.put('/notifications/read-all');
  }

  async clearAllNotifications() {
    await this.client.delete('/notifications/clear-all');
  }

  async deleteNotification(id: string) {
    await this.client.delete(`/notifications/${id}`);
  }

  // Platform Settings
  async getRiskWeights() {
    const { data } = await this.client.get('/settings/risk-weights');
    return data as import('@/types').RiskWeights;
  }

  async updateRiskWeights(payload: import('@/types').RiskWeights) {
    const { data } = await this.client.put('/settings/risk-weights', payload);
    return data as import('@/types').RiskWeights;
  }

  async getGradeThresholds() {
    const { data } = await this.client.get('/settings/grade-thresholds');
    return data as import('@/types').GradeThresholds;
  }

  async updateGradeThresholds(payload: import('@/types').GradeThresholds) {
    const { data } = await this.client.put('/settings/grade-thresholds', payload);
    return data as import('@/types').GradeThresholds;
  }

  async getCombinationRules() {
    const { data } = await this.client.get('/settings/combination-rules');
    return data as { rules: Record<string, string>; count: number; total_combinations: number; low_count: number; medium_count: number; high_count: number };
  }

  async updateCombinationRules(payload: { rules?: Record<string, string> }) {
    const { data } = await this.client.put('/settings/combination-rules', payload);
    return data as { rules: Record<string, string>; count: number; total_combinations: number; low_count: number; medium_count: number; high_count: number };
  }

}

export const apiClient = new ApiClient();
