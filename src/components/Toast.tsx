import type { Toast } from '../types';
import { Check, Info, Undo, X } from 'lucide-react';
import { useEffect, useState } from 'react';

interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center w-full px-4 max-w-sm pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(toast.id), 300);
    }, 3500);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const handleAction = () => {
    toast.undoAction?.();
    setExiting(true);
    setTimeout(() => onDismiss(toast.id), 300);
  };

  return (
    <div
      className={`pointer-events-auto flex items-center gap-3 pl-4 pr-2 py-2.5 rounded-xl bg-ink-800 text-sand-50 shadow-soft-lg max-w-full transition-all duration-300 ${
        exiting ? 'opacity-0 translate-y-3' : 'animate-slide-up'
      }`}
    >
      {toast.type === 'success' && <Check className="w-4 h-4 text-sage-300 shrink-0" />}
      {toast.type === 'info' && <Info className="w-4 h-4 text-accent-300 shrink-0" />}
      {toast.type === 'undo' && <Info className="w-4 h-4 text-accent-300 shrink-0" />}
      <span className="text-sm font-medium flex-1">{toast.message}</span>
      {toast.type === 'undo' && toast.undoAction && (
        <button
          onClick={handleAction}
          className="text-accent-300 font-semibold text-sm px-2 py-1 rounded-lg hover:bg-surface/10 transition-colors flex items-center gap-1"
        >
          <Undo className="w-3.5 h-3.5" />
          Undo
        </button>
      )}
      <button
        onClick={() => {
          setExiting(true);
          setTimeout(() => onDismiss(toast.id), 300);
        }}
        className="p-1 rounded-lg hover:bg-surface/10 transition-colors shrink-0"
      >
        <X className="w-3.5 h-3.5 text-sand-300" />
      </button>
    </div>
  );
}
