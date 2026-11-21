import { X, CheckCircle2, AlertCircle, Info } from "lucide-react";

import { useApp } from "@/lib/store";
import { cn } from "@/components/ui/primitives";

export function Toasts() {
  const toasts = useApp((state) => state.toasts);
  const dismiss = useApp((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={cn("toast", `toast--${toast.kind}`)}>
          <span className="toast__icon">
            {toast.kind === "success" ? (
              <CheckCircle2 size={15} />
            ) : toast.kind === "error" ? (
              <AlertCircle size={15} />
            ) : (
              <Info size={15} />
            )}
          </span>
          <span className="toast__text">{toast.text}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="关闭提示"
            onClick={() => dismiss(toast.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
