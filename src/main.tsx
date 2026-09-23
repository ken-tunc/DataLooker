import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ToastProvider } from "./components/Toast";
import "./index.css";
import { ErrorBoundary } from "./lib/ErrorBoundary";
import { queryClient } from "./lib/queryClient";

if ("__TAURI_INTERNALS__" in window) document.documentElement.dataset.window = "native";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in document.");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
