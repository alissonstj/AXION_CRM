import { getRequestConfig } from 'next-intl/server';

type Messages = Record<string, unknown>;

// Recursively overlays `override` onto `base`, key by key, instead of
// replacing whole namespaces. This lets a locale file be translated
// incrementally (namespace by namespace, batch by batch) while any
// key it hasn't reached yet still resolves to the English string
// instead of showing up blank/missing.
function deepMerge(base: Messages, override: Messages): Messages {
  const result: Messages = { ...base };
  for (const key of Object.keys(override)) {
    const baseValue = base[key];
    const overrideValue = override[key];
    if (
      typeof overrideValue === 'object' &&
      overrideValue !== null &&
      !Array.isArray(overrideValue) &&
      typeof baseValue === 'object' &&
      baseValue !== null &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(baseValue as Messages, overrideValue as Messages);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

export default getRequestConfig(async () => {
  // Read the locale from the environment, defaulting to 'pt-BR'
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'pt-BR';

  const en = (await import(`../../messages/en.json`)).default as Messages;

  let messages: Messages = en;
  if (locale !== 'en') {
    try {
      const localeMessages = (await import(`../../messages/${locale}.json`))
        .default as Messages;
      // English stays the fallback for any key the locale file hasn't
      // translated yet, so batches can ship incrementally.
      messages = deepMerge(en, localeMessages);
    } catch (error) {
      // Fallback to English if the dictionary for the requested locale doesn't exist yet
      messages = en;
    }
  }

  return {
    locale,
    messages
  };
});
