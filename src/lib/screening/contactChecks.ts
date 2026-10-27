import { parsePhoneNumberFromString } from "libphonenumber-js/max";

// Contact checks that need no AI and send nothing to the candidate.
//  - Email: does the domain exist and accept mail (DNS MX lookup)? Is it a throw-away service?
//    Passing means "can receive email", NOT "this person owns the inbox".
//  - Phone: valid number for its country (Google's libphonenumber rules), mobile or landline.
//    Passing means "a real-looking number", NOT "this person answers it".

/** Common disposable / throw-away email providers. Not exhaustive. */
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com", "10minutemail.com", "10minutemail.net",
  "tempmail.com", "temp-mail.org", "tempmail.net", "yopmail.com", "trashmail.com", "getnada.com", "nada.email",
  "dispostable.com", "maildrop.cc", "mintemail.com", "throwawaymail.com", "fakeinbox.com", "mohmal.com",
  "emailondeck.com", "mailnesia.com", "tempr.email", "discard.email", "spamgourmet.com", "burnermail.io",
]);

export function isDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return DISPOSABLE.has(d) || Array.from(DISPOSABLE).some((x) => d.endsWith(`.${x}`));
}

export interface EmailCheck {
  email: string;
  domain: string;
  /** true = domain accepts mail · false = domain missing / no mail server · null = couldn't check */
  accepts_mail: boolean | null;
  detail: "mail_server_found" | "no_mail_server" | "domain_not_found" | "lookup_failed";
  disposable: boolean;
}

export interface ContactChecks {
  emails: EmailCheck[];
  checked_at: string;
}

/** DNS functions, injectable so tests never hit the network. */
export interface DnsLike {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
}

const DNS_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), DNS_TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export async function checkEmailDomain(email: string, dns: DnsLike): Promise<EmailCheck> {
  const domain = (email.split("@")[1] ?? "").toLowerCase().trim();
  const base = { email, domain, disposable: isDisposableDomain(domain) };
  if (!domain) return { ...base, accepts_mail: false, detail: "domain_not_found" };
  try {
    const mx = await withTimeout(dns.resolveMx(domain));
    if (mx.some((r) => r.exchange && r.exchange !== ".")) return { ...base, accepts_mail: true, detail: "mail_server_found" };
    return { ...base, accepts_mail: false, detail: "no_mail_server" };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOTFOUND") return { ...base, accepts_mail: false, detail: "domain_not_found" };
    if (code === "ENODATA") {
      // No MX record: mail may still be delivered to the domain's A record (RFC 5321 fallback).
      try {
        const a = await withTimeout(dns.resolve4(domain));
        return a.length ? { ...base, accepts_mail: true, detail: "mail_server_found" } : { ...base, accepts_mail: false, detail: "no_mail_server" };
      } catch {
        return { ...base, accepts_mail: false, detail: "no_mail_server" };
      }
    }
    return { ...base, accepts_mail: null, detail: "lookup_failed" };
  }
}

// ── Resolvers ──
// Some machines (VPN / security software) point Node's DNS client at a local proxy that refuses
// direct queries. We try the system resolver first; if it can't be reached (not a real "no such
// domain" answer), we ask over HTTPS (DNS-over-HTTPS), which uses the same network path as the
// app's other HTTPS calls. Only the email's DOMAIN is ever looked up. CV_EMAIL_DOH_URL=off disables it.

const INFRA_ERRORS = new Set(["ECONNREFUSED", "ETIMEOUT", "ECONNRESET", "EREFUSED", "ESERVFAIL", "ECANCELLED", "EAI_AGAIN"]);

function dohUrl(): string | null {
  const v = (process.env.CV_EMAIL_DOH_URL ?? "https://cloudflare-dns.com/dns-query").trim();
  return v && v.toLowerCase() !== "off" ? v : null;
}

interface DohAnswer { type: number; data: string }

async function dohQuery(url: string, domain: string, type: "MX" | "A"): Promise<DohAnswer[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DNS_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: ctrl.signal });
    if (!res.ok) throw Object.assign(new Error("doh_http"), { code: "ESERVFAIL" });
    const j = (await res.json()) as { Status: number; Answer?: DohAnswer[] };
    if (j.Status === 3) throw Object.assign(new Error("nxdomain"), { code: "ENOTFOUND" });
    if (j.Status !== 0) throw Object.assign(new Error("doh_status"), { code: "ESERVFAIL" });
    const want = type === "MX" ? 15 : 1;
    const answers = (j.Answer ?? []).filter((a) => a.type === want);
    if (!answers.length) throw Object.assign(new Error("nodata"), { code: "ENODATA" });
    return answers;
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export function dohResolver(url: string): DnsLike {
  return {
    resolveMx: async (d) =>
      (await dohQuery(url, d, "MX")).map((a) => {
        const [pri, host] = a.data.trim().split(/\s+/);
        return { priority: Number(pri) || 0, exchange: (host ?? "").replace(/\.$/, "") };
      }),
    resolve4: async (d) => (await dohQuery(url, d, "A")).map((a) => a.data),
  };
}

/** System DNS first; DNS-over-HTTPS only when the system resolver can't be reached. */
export function resilientResolver(system: DnsLike, fallback: DnsLike | null = dohUrl() ? dohResolver(dohUrl()!) : null): DnsLike {
  const run = async <T>(f: (r: DnsLike) => Promise<T>): Promise<T> => {
    try {
      return await f(system);
    } catch (err) {
      if (fallback && INFRA_ERRORS.has((err as { code?: string })?.code ?? "")) return f(fallback);
      throw err;
    }
  };
  return { resolveMx: (d) => run((r) => r.resolveMx(d)), resolve4: (d) => run((r) => r.resolve4(d)) };
}

export async function runContactChecks(emails: string[], dns: DnsLike): Promise<ContactChecks> {
  const unique = Array.from(new Set(emails.map((e) => e.trim()).filter(Boolean))).slice(0, 3);
  return { emails: await Promise.all(unique.map((e) => checkEmailDomain(e, dns))), checked_at: new Date().toISOString() };
}

export interface PhoneCheck {
  value: string;
  valid: boolean;
  country: string | null;
  type: string | null;
  /** The CV had no country code, so the default country was assumed. */
  assumed_country: boolean;
  international: string | null;
}

export function defaultPhoneCountry(): string {
  const c = (process.env.CV_DEFAULT_PHONE_COUNTRY ?? "IN").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : "IN";
}

export function analyzePhone(value: string, defaultCountry = defaultPhoneCountry()): PhoneCheck {
  const hasCc = /^\s*(\+|00)/.test(value);
  const normalized = value.trim().replace(/^00/, "+");
  // libphonenumber's country codes are a typed union; any 2-letter code is accepted at runtime.
  const p = parsePhoneNumberFromString(normalized, defaultCountry as Parameters<typeof parsePhoneNumberFromString>[1]);
  if (!p) return { value, valid: false, country: null, type: null, assumed_country: !hasCc, international: null };
  return {
    value,
    valid: p.isValid(),
    country: p.country ?? null,
    type: p.getType() ?? null,
    assumed_country: !hasCc,
    international: p.formatInternational(),
  };
}
