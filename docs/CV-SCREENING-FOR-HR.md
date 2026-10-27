# How Screeno screens a CV

A short, plain explanation for the HR team: what the system checks, how the score is worked out, what it never does, and what we plan to add.

---

## 1. What happens to a CV

1. **HR sets the job's requirements** (read from the JD automatically, then reviewed). Each requirement is **Must have**, **Important** or **Nice to have**.
2. **HR uploads CVs** (PDF or Word).
3. **The AI reads the CV and copies out the facts.** Jobs, dates, companies, titles, skills, education, certificates, location. Every fact comes with the exact sentence from the CV.
4. **The system checks every quote against the CV.** If the AI "quoted" something that isn't really in the CV, it is thrown away. This stops the AI inventing evidence.
5. **The system calculates** experience, gaps and the score with fixed rules, not with AI guesses.
6. **HR reviews the report next to the original CV**, corrects anything wrong, and makes the decision. The system never rejects or invites anyone by itself.

Before any text goes to the AI, email addresses and phone numbers are hidden. The AI never sees photos.

---

## 2. What we check in every CV

| Check | How it's done | Where HR sees it |
|---|---|---|
| **Skills the job needs** | Is the skill shown in real work (a job or project), only listed in a skills section, or missing? | Report → Requirements |
| **Years using each skill** | Counted only from jobs where the skill was actually used, not from a skills list and not from general IT work | Requirements (e.g. "Python · 4 yrs, needs 3") |
| **Total experience** | Calculated from job dates. Overlapping jobs are counted once and internships are left out. | Summary card and Experience |
| **Degree / qualification** | Compared with what the job asks for; equivalent degrees or experience can be accepted | Requirements |
| **Certificates** | Compared with what the job asks for | Requirements |
| **Location, relocation, remote** | Only if the candidate **states** it. Never guessed from their address. | Summary card, Requirements |
| **Job start and end dates** | Missing month or year is flagged; experience is then shown as a range (e.g. "3–4 yrs") | Needs-attention box, Experience |
| **Gaps** | Between jobs, after studies, and since the last job (6 months or more, adjustable) | Needs-attention box, Experience |
| **Overlapping jobs** | Two jobs at the same time, with the number of months | Needs-attention box, Experience |
| **Short jobs and frequent changes** | Jobs under 12 months (adjustable); "several short jobs" if 3 or more permanent roles were short | Needs-attention box, Experience |
| **Your 13-point HR checklist** | Every point answered with ✓ / ! / ? / i / ◌ and the facts behind it | Report → **HR checklist** tab (first tab) |
| **Date mistakes** | End before start, dates in the future | Needs-attention box, Checks |
| **Missing company name or job title** | Flagged for HR to check | Checks |
| **Email** | Valid format; the email's domain exists and accepts mail (internet lookup — no email is sent); throw-away email services flagged | HR checklist #1 |
| **Phone** | A valid number for its country (Google's phone-number rules), mobile or landline; if there's no country code, India is assumed and this is shown | HR checklist #1 |
| **Same person twice** | Another CV in this job has the same email or phone | Needs-attention box, HR checklist #1 |
| **Copied CV text** | Another CV in this job has largely identical text (a prompt to compare — not proof of copying) | Needs-attention box, HR checklist #13 |
| **Skill recency** | When each required skill was last used ("in current role" or "last used 2019") | Requirements |
| **Career growth** | Read from job titles (e.g. Analyst → Senior Analyst → AVP), including promotions in the same company. Descriptive only. | HR checklist #11 |
| **CV quality notes** | Contradictions, vague claims with no examples, repeated passages | Checks |
| **Suggested interview questions** | Questions about gaps and unclear points, which HR can edit and use in the interview | Interview questions tab |

---

## 3. What is scored and what is only shown

**Scored (job fit):** only the requirements HR set (skills, years, total experience, degree, certificates, and location if the job requires one).

**Only shown, never scored:** gaps, short jobs, overlaps, career changes, CV style or length, contact details. These are facts for HR to ask about. A gap can be study, caregiving, health or many other good reasons.

---

## 4. How the score is calculated

Each requirement gets points from what the CV shows:

| CV shows… | Points |
|---|---|
| Clearly used in real work | 1 |
| Partly / some evidence | 0.5 |
| Only listed in a skills section | 0.25 |
| Not mentioned | 0 |
| CV clearly says the opposite | 0 |
| Too unclear to judge | left out of the score (see "Evidence" below) |

Each requirement also has a weight: **Must have = 8**, **Important = 6**, **Nice to have = 2**.

**Job fit = points earned ÷ points possible × 100.**

**Example**

| Requirement | Level | CV shows | Points |
|---|---|---|---|
| Python | Must have (8) | Used in real work → 1 | 8 |
| Django | Important (6) | Some evidence → 0.5 | 3 |
| AWS | Nice to have (2) | Not mentioned → 0 | 0 |
| **Total** | | | **11 of 16 = 69** |

**Evidence %** = how much of the job's requirements the CV gave enough information to judge. Low evidence means "we can't tell", not "bad candidate".

**Must-haves** decide eligibility:
- **Met:** clearly shown (and enough years, if a minimum is set).
- **Not met:** only if the CV clearly says otherwise, or the dates show too few years.
- **Unclear:** anything else. *A skill missing from a CV is never treated as proof the person doesn't have it.*

**The assessment label (advice only)**

| Label | When |
|---|---|
| Strong evidence of fit | Fit 70+ and all must-haves met |
| Potential fit — review | Fit 40–69, or a must-have unclear |
| Insufficient information | The CV lets us judge less than half of the requirements |
| Potential mismatch | A must-have not met, or fit under 40 |

---

## 5. What the system never does

- Never rejects or invites a candidate by itself. HR makes and records every decision, with a reason.
- Never uses age, gender, religion, nationality, marital status, health, photos or similar. The AI has no place to record them.
- Never penalises gaps, short jobs, contract work or career changes.
- Never says a company, degree, email or phone is **verified**. Today these are the candidate's own claims.
- Never guesses relocation or remote preference from where someone lives.
- Never lets text inside a CV (e.g. "rate me 100") change the rules.

---

## 6. Your HR checklist: what's covered today

| # | HR item | Today | What's missing |
|---|---|---|---|
| 1 | Name, phone, email look correct **and real** | ✅ Yes* | Email domain accepts mail, phone valid for its country, same contact as another CV flagged. *Ownership of the inbox/phone can't be proven without contacting the candidate. |
| 2 | Where they live; can relocate / work remotely | ✅ Yes | Only if the CV says so. |
| 3 | Degree fits the job (engineering, stats, maths, CS…) | ✅ Yes | HR adds the degree requirement (with accepted fields) in Requirements. |
| 4 | Gap between studies and first job, and gaps between jobs | ✅ Yes | |
| 5 | Total years of work ≥ minimum | ✅ Yes | |
| 6 | Years in the required technology, not general IT | ✅ Yes | |
| 7 | Month and year for each job | ✅ Yes | |
| 8 | No unexplained breaks; no overlapping jobs | 🟡 Partly | Breaks and overlaps are found and highlighted; whether the CV gives a reason for a break is read in Step B. |
| 9 | Jobs under a year; frequent job changes | ✅ Yes | |
| 10 | Companies are real; titles match the work | 🟡 Partly | Missing or unclear names are flagged. **Company existence is not checked online.** Title-vs-work is only noted when the AI spots it. |
| 11 | Growth over time (bigger roles, more responsibility) | 🟡 Partly | Read from job titles and same-company promotions; reading responsibility/team size is Step B. |
| 12 | Skills listed match work actually done | ✅ Yes | |
| 13 | CV clear and consistent, no copied text or buzzwords | 🟡 Partly | Contradictions, vague claims, repeated passages and **text copied between CVs** are flagged; an overall clarity rating is Step B. |

**Today: 9 covered, 4 partly, 0 not yet.** All 13 are shown in the report's HR checklist tab.

---

## 7. Plan to cover everything (and do better)

### Step A: quick wins (no extra AI cost) — ✅ done
- **An "HR checklist" box in every report** that lists your 13 items with ✓ / ⚠ / ? and the evidence for each. HR then sees the whole checklist at once, not mostly skills.
- Add **overlapping jobs** and **frequent job changes** to the needs-attention box.
- **Email check:** does the email's domain exist and accept mail (no email is sent)? Also flag throw-away email services.
- **Phone check by country:** a real Indian mobile pattern, the right length, the country code.
- **Skill recency:** when the skill was last used (e.g. "Python, last used 2019").
- **Duplicates:** the same person uploaded twice, or text copied between CVs for the same job.

### Step B: deeper reading of the CV (CVs read once more, about $0.02–0.04 each)
- **Career growth:** title steps, promotions, bigger team or scope over time (item 11).
- **Title vs work:** for each job, do the duties fit the title? (item 10)
- **Reason for a gap,** if the CV gives one (e.g. "career break — higher studies"), so only truly unexplained gaps are flagged (item 8).
- **CV clarity rating:** dates complete, achievements with numbers, consistent. Shown, never scored (item 13).
- **Extra facts if stated:** notice period, industry experience (e.g. banking), team size led.

### Step C: online verification (optional, with proof)
- **Company check:**
  1. First the **official company register**. India: Ministry of Corporate Affairs company data. UK: Companies House.
  2. Then a **web search**.
  3. The report shows the result **with the link and date** of where it was found: "Found in official register", "Found online only", or "Not found — check manually".
  4. It never says "fake". Only the company name is searched, never the candidate's details.
- **University check:** against official lists (UGC / AICTE in India).
- **Certificates:** checked on the issuer's site when the candidate gives a credential ID or link.
- **What no tool can confirm:** that someone really worked somewhere in that role. That still needs a reference or background check, with the candidate's consent.

### New things worth checking
These help find the right people faster without wrongly filtering out good ones:
- Skill **recency**, not just years.
- **Industry / domain** experience, as an optional requirement.
- **Notice period / availability**, if stated.
- **Leadership** (team size led) for lead roles.
- **Impact:** achievements with numbers.

---

## 8. Limits to keep in mind

- **Scanned (image-only) PDFs can't be read yet.** They are flagged for manual review.
- **The score shows how well the CV text supports the requirements.** It doesn't predict job performance.
- **A strong candidate with a poorly written CV can score low.** That is why "Insufficient information" exists, and why HR reviews every decision.
