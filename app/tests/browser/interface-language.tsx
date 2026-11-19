import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ProfileNameForm } from "@/components/settings/profile";
import { LanguagePicker, LanguageProvider } from "@/lib/i18n/provider";
import { queryClient } from "@/query-client";
import "@/styles.css";

const root = document.querySelector("#root");
if (!root) throw new Error("Missing browser test root");

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <LanguageProvider>
      <ProfileNameForm initialName="Maya Chen" />
      <LanguagePicker />
    </LanguageProvider>
  </QueryClientProvider>,
);
