// Deterministic contact extraction + masking. Contact details are found with regexes (not the LLM)
// and replaced with placeholders before any text is sent to OpenAI (data minimisation).
// "valid" here means SYNTACTICALLY valid only — nothing is ever verified (no email/SMS is sent).

export interface ContactFinding {
  value: string;
  placeholder: string;
  format_valid: boolean;
}
export interface PhoneFinding extends ContactFinding {
  has_country_code: boolean;
  digits: number;
}
export interface ContactInfo {
  emails: ContactFinding[];
  phones: PhoneFinding[];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Candidate phone numbers: optional +, then digits with common separators. Filtered further below.
const PHONE_RE = /(?<![\w+])(?:\+|00)?\d[\d\s().\-]{6,18}\d(?!\w)/g;

/** Stricter check than EMAIL_RE: no leading/trailing/double dots, sane lengths. */
export function isEmailFormatValid(email: string): boolean {
  if (email.length > 254) return false;
  const [local, domain] = email.split("@");
  if (!local || !domain || local.length > 64) return false;
  if (/^\.|\.$|\.\./.test(local) || /^[.-]|[.-]$|\.\./.test(domain)) return false;
  return /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(domain);
}

function looksLikeDateOrRange(s: string): boolean {
  const t = s.trim();
  // 2019 - 2021, 01/2019, 2019.01, 12.05.2020, 2020-01-15
  return (
    /^\d{4}\s*[-–.]\s*\d{2,4}$/.test(t) ||
    /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(t) ||
    /^\d{4}[./-]\d{1,2}([./-]\d{1,2})?$/.test(t) ||
    /^\d{1,2}[./-]\d{4}\s*[-–]\s*\d{1,2}[./-]\d{4}$/.test(t)
  );
}

function allMatches(re: RegExp, text: string): string[] {
  const out: string[] = [];
  const r = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) out.push(m[0]);
  return out;
}

export function findContacts(text: string): ContactInfo {
  const emails: ContactFinding[] = [];
  const seenEmail = new Set<string>();
  for (const m of allMatches(EMAIL_RE, text)) {
    const v = m.replace(/\.$/, "");
    const key = v.toLowerCase();
    if (seenEmail.has(key)) continue;
    seenEmail.add(key);
    emails.push({ value: v, placeholder: `[EMAIL_${emails.length + 1}]`, format_valid: isEmailFormatValid(v) });
  }

  const phones: PhoneFinding[] = [];
  const seenPhone = new Set<string>();
  const withoutEmails = text.replace(EMAIL_RE, (e) => " ".repeat(e.length));
  for (const m of allMatches(PHONE_RE, withoutEmails)) {
    const v = m.trim();
    if (looksLikeDateOrRange(v)) continue;
    const digits = v.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) continue;
    if (seenPhone.has(digits)) continue;
    seenPhone.add(digits);
    const hasCc = v.startsWith("+") || v.startsWith("00");
    phones.push({
      value: v,
      placeholder: `[PHONE_${phones.length + 1}]`,
      // E.164 allows at most 15 digits; national numbers are usually ≥ 8 digits.
      format_valid: hasCc ? digits.length >= 8 && digits.length <= 15 : digits.length >= 8 && digits.length <= 12,
      has_country_code: hasCc,
      digits: digits.length,
    });
  }
  return { emails, phones };
}

/** Replace every found email/phone with its placeholder. */
export function maskContacts(text: string, info: ContactInfo = findContacts(text)): string {
  let out = text;
  for (const e of info.emails) out = out.split(e.value).join(e.placeholder);
  for (const p of [...info.phones].sort((a, b) => b.value.length - a.value.length)) out = out.split(p.value).join(p.placeholder);
  return out;
}
