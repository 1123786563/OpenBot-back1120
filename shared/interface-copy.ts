export type InterfaceTranslator = (
  message: string,
  values?: Record<string, string | number>,
) => string;
export const englishInterface: InterfaceTranslator = (message, values = {}) =>
  message.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder,
  );
