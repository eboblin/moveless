/** What `get_param("bank")` says about the sample file. */
export interface BankView {
  phase: "off" | "ok" | "load" | "fail";
  /** 0..100 while phase is load. The voice fills the last percent only after the file is in place. */
  percent: number;
}

/** `ok` is mapped, `off` means this build has nothing to fetch, `fail` is the last attempt, digits are the running percent. */
export function parseBankParam(raw: string | null): BankView {
  if (raw === "ok") return { phase: "ok", percent: 100 };
  if (raw === "fail") return { phase: "fail", percent: 0 };
  if (raw === null || raw === "" || raw === "off") return { phase: "off", percent: 0 };
  if (/^\d{1,3}$/.test(raw)) {
    const percent = Number(raw);
    if (percent >= 0 && percent <= 100) return { phase: "load", percent };
  }
  return { phase: "off", percent: 0 };
}
