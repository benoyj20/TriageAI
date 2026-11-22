import { X } from 'lucide-react';
import { useDialog } from '../lib/useDialog.js';

export default function Modal({ title, onClose, children, width = 'max-w-xl' }) {
  const ref = useDialog(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 px-4 pt-[8vh]" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${width} rounded-md bg-card shadow-2xl ring-1 ring-black/5`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-sand-2 hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 pb-5">{children}</div>
      </div>
    </div>
  );
}
