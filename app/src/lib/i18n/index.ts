import {
  isLanguagePreference,
  type LanguagePreference,
} from "@openbot/shared/user-preferences";
import i18next from "i18next";
import {
  createElement,
  Fragment,
  type ReactNode,
  useSyncExternalStore,
} from "react";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export type InterfaceLocale = "en" | "zh-CN";
export const LANGUAGE_STORAGE_KEY = "openbot.interface-language";
export function resolveLocale(
  preference: LanguagePreference,
  browserLanguage: string,
): InterfaceLocale {
  return preference === "system"
    ? /^zh(?:-|$)/i.test(browserLanguage)
      ? "zh-CN"
      : "en"
    : preference;
}
export function readLocalLanguage(): LanguagePreference {
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguagePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}
export function saveLocalLanguage(preference: LanguagePreference) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    /* The in-memory selection still works when storage is unavailable. */
  }
}
export const i18n = i18next.createInstance();
void i18n.init({
  initAsync: false,
  resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
  lng: resolveLocale(
    readLocalLanguage(),
    typeof navigator === "undefined" ? "en" : navigator.language,
  ),
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});
export function getLocale(): InterfaceLocale {
  return i18n.language === "zh-CN" ? "zh-CN" : "en";
}
export function localeFormatter<T>(
  create: (locale: InterfaceLocale) => T,
): () => T {
  const formats = new Map<InterfaceLocale, T>();
  return () => {
    const locale = getLocale();
    const existing = formats.get(locale);
    if (existing !== undefined) return existing;
    const formatter = create(locale);
    formats.set(locale, formatter);
    return formatter;
  };
}
export function setInterfaceLanguage(preference: LanguagePreference) {
  void i18n.changeLanguage(
    resolveLocale(
      preference,
      typeof navigator === "undefined" ? "en" : navigator.language,
    ),
  );
}
export function ui(
  message: string,
  values?: Record<string, string | number>,
): string {
  return i18n.t(message, { ...values, defaultValue: message });
}
export function uiNodes(message: string, slots: ReactNode[]): ReactNode[] {
  return ui(message)
    .split(/(\{\{slot\d+\}\})/)
    .map((part) => {
      const match = /^\{\{slot(\d+)\}\}$/.exec(part);
      return match
        ? createElement(Fragment, { key: match[1] }, slots[Number(match[1])])
        : part;
    });
}
const subscribe = (listener: () => void) => {
  i18n.on("languageChanged", listener);
  return () => {
    i18n.off("languageChanged", listener);
  };
};
export function useLocale(): InterfaceLocale {
  return useSyncExternalStore(subscribe, getLocale, () => "en");
}
function updateDocumentLanguage() {
  if (typeof document !== "undefined")
    document.documentElement.lang = getLocale();
}
i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage();
