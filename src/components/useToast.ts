import { createContext, useContext } from "react";

export type ToastVariant = "success" | "error" | "info";

export type ToastContextValue = {
  show: (message: string, variant?: ToastVariant) => void;
};

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within a ToastProvider");
  return context;
}
