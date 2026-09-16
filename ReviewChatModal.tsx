import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MessageSquare, X, Send, Loader2, Shield,
  Scale, Clock, Sparkles,
} from 'lucide-react';
import { apiClient } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { cn, formatDate } from '@/lib/utils';
import type { LegalReview, ReviewMessage } from '@/types';

interface ReviewChatModalProps {
  open: boolean;
  onClose: () => void;
  review: LegalReview;
  batchId?: string;
}

export function ReviewChatModal({ open, onClose, review, batchId }: ReviewChatModalProps) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [draft, setDraft] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const messagesQuery = useQuery({
    queryKey: ['review-messages', review.id],
    queryFn: () => apiClient.getReviewMessages(review.id),
    enabled: open,
    refetchInterval: open ? 4000 : false,
  });

  const messages = messagesQuery.data ?? review.messages ?? [];

  const postMutation = useMutation({
    mutationFn: (text: string) => apiClient.postReviewMessage(review.id, text),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: ['review-messages', review.id] });
      if (batchId) {
        qc.invalidateQueries({ queryKey: ['legal-batch', batchId] });
      }
      qc.invalidateQueries({ queryKey: ['legal-batches'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-count'] });
      toast.success('Note sent to review discussion thread');
    },
    onError: () => {
      toast.error('Failed to send note. Please try again.');
    },
  });

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    postMutation.mutate(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }, [open, messages.length]);

  if (!open) return null;

  const isTrademark = (role?: string) => {
    const r = (role || '').toLowerCase();
    return r.includes('trademark') || r.includes('counsel') || r.includes('legal');
  };

  const isMarketing = (role?: string) => {
    const r = (role || '').toLowerCase();
    return r.includes('brand') || r.includes('market') || r.includes('submitter');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl border border-gray-200 flex flex-col max-h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); } }}
        role="button"
        tabIndex={0}
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-gray-50 via-white to-blue-50/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center flex-shrink-0 shadow-sm">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-bold text-gray-900 uppercase tracking-wide">
                  {review.brand_name}
                </h3>
                <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-600">
                  {review.status.replace('_', ' ').toUpperCase()}
                </span>
                {review.case_name && (
                  <span className="text-xs text-gray-500 font-medium truncate max-w-[200px]">
                    · {review.case_name}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                Collaborative notes thread between Trademark Counsel & Brand Marketing Team
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Message Thread */}
        <div className="flex-1 p-4 sm:p-5 overflow-y-auto space-y-4 bg-gray-50/50 min-h-[260px]">
          {messagesQuery.isLoading ? (
            <div className="flex items-center justify-center h-48 text-gray-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
              <span className="text-sm">Loading discussion notes...</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center text-gray-400">
              <div className="w-12 h-12 rounded-full bg-blue-50 text-blue-400 flex items-center justify-center mb-3">
                <MessageSquare className="w-6 h-6" />
              </div>
              <p className="text-sm font-semibold text-gray-700">No discussion notes yet</p>
              <p className="text-xs text-gray-400 max-w-sm mt-1">
                Use the box below to send clarifications, revision feedback, or justification notes.
              </p>
            </div>
          ) : (
            messages.map((msg: ReviewMessage, idx: number) => {
              const tm = isTrademark(msg.sender_role);
              const mkt = isMarketing(msg.sender_role);
              const isCurrentUser = user && (user.id === msg.sender_id || user.email === msg.sender_name);

              return (
                <div
                  key={msg.id || idx}
                  className={cn(
                    'p-3.5 rounded-xl border transition-all text-xs space-y-1.5 shadow-sm',
                    tm
                      ? 'bg-amber-50/90 border-amber-200/80 text-amber-950'
                      : mkt
                      ? 'bg-blue-50/90 border-blue-200/80 text-blue-950'
                      : 'bg-white border-gray-200 text-gray-900'
                  )}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap pb-1 border-b border-black/5">
                    <div className="flex items-center gap-1.5">
                      {tm ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-200/80 text-amber-900 flex items-center gap-1">
                          <Scale className="w-3 h-3" />
                          Trademark Counsel
                        </span>
                      ) : mkt ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-200/80 text-blue-900 flex items-center gap-1">
                          <Sparkles className="w-3 h-3" />
                          Brand Marketing
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 flex items-center gap-1">
                          <Shield className="w-3 h-3" />
                          {msg.sender_role || 'Team Member'}
                        </span>
                      )}
                      <span className="font-bold text-gray-900 text-xs">
                        {msg.sender_name}
                      </span>
                      {isCurrentUser && (
                        <span className="text-[10px] text-gray-500 font-medium">(You)</span>
                      )}
                    </div>
                    {msg.created_at && (
                      <span className="text-[10px] text-gray-400 font-medium flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDate(msg.created_at)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed whitespace-pre-wrap font-normal">
                    {msg.message}
                  </p>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Footer */}
        <div className="p-3.5 sm:p-4 border-t border-gray-200 bg-white">
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a note, response, or justification for this candidate name... (Press Enter to send)"
              rows={2}
              className="w-full text-xs p-2.5 rounded-xl border border-gray-300 bg-gray-50 focus:bg-white text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:outline-none transition-all resize-none"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-gray-400 hidden sm:inline">
                Shift + Enter for new line
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onClose}
                  className="h-8 text-xs text-gray-600 hover:bg-gray-100"
                >
                  Close
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  onClick={handleSend}
                  disabled={!draft.trim() || postMutation.isPending}
                  className="h-8 text-xs font-bold gap-1.5 bg-blue-600 hover:bg-blue-700 text-white shadow-sm"
                >
                  {postMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  Send Note
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
