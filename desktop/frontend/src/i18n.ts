import { useCallback, useState } from "react";
import { getLanguage, setLanguage, type Lang } from "./strings";

const KEY = "xscript.lang";

export function readStoredLang(): Lang {
  try {
    return window.localStorage.getItem(KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

/** Language state for the shell: switching swaps the `t` dictionary first, then re-renders (components read `t` directly). */
export function useLanguage(): [Lang, (l: Lang) => void] {
  const [lang, setLang] = useState<Lang>(() => {
    const l = readStoredLang();
    if (l !== getLanguage()) setLanguage(l);
    return l;
  });
  const change = useCallback((l: Lang) => {
    setLanguage(l);
    try {
      window.localStorage.setItem(KEY, l);
    } catch {
      /* not persisted */
    }
    setLang(l);
  }, []);
  return [lang, change];
}
