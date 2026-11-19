import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./query-client";
import { router } from "./router";
import { LanguageProvider } from "./lib/i18n/provider";
import { installIdentityGuards } from "./lib/auth/identity";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

// Before anything renders: the cache-write freeze and the cross-tab identity broadcast only work
// if they are watching from the start. See `lib/auth/identity.ts`.
installIdentityGuards();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("OpenBot could not find the application root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <RouterProvider router={router} context={{ queryClient }} />
      </LanguageProvider>
    </QueryClientProvider>
  </StrictMode>,
);
