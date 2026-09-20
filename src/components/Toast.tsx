import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ToastContext, type ToastVariant } from "./useToast";

type Toast = {
  id: number;
  message: string;
  variant: ToastVariant;
};

const TOAST_DURATION_MS = 4000;

const VARIANT_CLASS: Record<ToastVariant, string> = {
  success: "alert-success",
  error: "alert-error",
  info: "alert-info",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const handle of pending) clearTimeout(handle);
      pending.clear();
    };
  }, []);

  const show = useCallback((message: string, variant: ToastVariant = "info") => {
    nextId.current += 1;
    const id = nextId.current;
    setToasts((current) => [...current, { id, message, variant }]);
    const handle = setTimeout(() => {
      timers.current.delete(handle);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
    timers.current.add(handle);
  }, []);

  return (
    <ToastContext value={{ show }}>
      {children}
      <div className="toast toast-end z-50">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="alert"
            className={`alert ${VARIANT_CLASS[toast.variant]} shadow-lg`}
            data-testid="toast"
            data-variant={toast.variant}
          >
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}
