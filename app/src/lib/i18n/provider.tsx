import {
  isLanguagePreference,
  type LanguagePreference,
} from "@openbot/shared/user-preferences";
import {
  notifyManager,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  saveUserPreferencesMutationOptions,
  userPreferencesQueryOptions,
} from "@/lib/settings/message-list";
import {
  LANGUAGE_STORAGE_KEY,
  readLocalLanguage,
  saveLocalLanguage,
  setInterfaceLanguage,
  ui,
  useLocale,
} from ".";

type LanguageSettings = {
  language: LanguagePreference;
  choose: (language: LanguagePreference) => void;
  saving: boolean;
  unsynced: boolean;
  retry: () => void;
};
const LanguageContext = createContext<LanguageSettings | null>(null);
const currentUserQuery = currentUserQueryOptions();

export function LanguageProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  useQuery(currentUserQuery);
  // Sign-out removes the auth query while this provider stays mounted.
  const owner = useSyncExternalStore(
    useCallback(
      (changed) =>
        queryClient
          .getQueryCache()
          .subscribe(notifyManager.batchCalls(changed)),
      [queryClient],
    ),
    () => queryClient.getQueryData(currentUserQuery.queryKey)?.id,
    () => undefined,
  );
  const preferences = useQuery(userPreferencesQueryOptions(owner));
  const [local, setLocal] = useState(readLocalLanguage);
  const [draft, setDraft] = useState<{
    owner: string;
    language: LanguagePreference;
  } | null>(null);
  const saveOptions = saveUserPreferencesMutationOptions(queryClient, owner);
  const preferenceKey = userPreferencesQueryOptions(owner).queryKey;
  const save = useMutation({
    ...saveOptions,
    onMutate: () => queryClient.cancelQueries({ queryKey: preferenceKey }),
    onSuccess: async (...args) => {
      await queryClient.cancelQueries({ queryKey: preferenceKey });
      await saveOptions.onSuccess?.(...args);
    },
  });
  const activeDraft = draft?.owner === owner ? draft : null;
  const language = owner
    ? (activeDraft?.language ?? preferences.data?.language ?? "system")
    : local;
  useEffect(() => {
    setDraft((current) => (current?.owner === owner ? current : null));
  }, [owner]);
  useEffect(() => {
    setInterfaceLanguage(language);
  }, [language]);
  useEffect(() => {
    const detect = () => setInterfaceLanguage(language);
    const stored = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY) setLocal(readLocalLanguage());
    };
    window.addEventListener("languagechange", detect);
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener("languagechange", detect);
      window.removeEventListener("storage", stored);
    };
  }, [language]);
  function persist(next: LanguagePreference) {
    if (!owner) {
      saveLocalLanguage(next);
      setLocal(next);
      setInterfaceLanguage(next);
      return;
    }
    setDraft({ owner, language: next });
    setInterfaceLanguage(next);
    save.mutate(
      { language: next },
      {
        onSuccess: () =>
          setDraft((current) =>
            current?.owner === owner && current.language === next
              ? null
              : current,
          ),
      },
    );
  }
  return (
    <LanguageContext
      value={{
        language,
        choose: persist,
        saving: save.isPending && activeDraft !== null,
        unsynced: activeDraft !== null && save.isError,
        retry: () => {
          if (activeDraft) persist(activeDraft.language);
        },
      }}
    >
      {children}
    </LanguageContext>
  );
}

export function LanguagePicker() {
  useLocale();
  const settings = useContext(LanguageContext);
  if (!settings) throw new Error("LanguagePicker requires LanguageProvider");
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <label className="flex items-center justify-between gap-4">
        <span>{ui("Language")}</span>
        <select
          className="max-w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={settings.language}
          disabled={settings.saving}
          aria-busy={settings.saving}
          onChange={(event) => {
            if (isLanguagePreference(event.target.value))
              settings.choose(event.target.value);
          }}
        >
          <option value="system">{ui("Follow browser")}</option>
          <option value="zh-CN" lang="zh-CN">
            简体中文
          </option>
          <option value="en" lang="en">
            English
          </option>
        </select>
      </label>
      {settings.unsynced && (
        <p role="alert" className="text-sm text-destructive">
          {ui("Language has not synced to your other devices.")}{" "}
          <button type="button" className="underline" onClick={settings.retry}>
            {ui("Retry")}
          </button>
        </p>
      )}
    </div>
  );
}
