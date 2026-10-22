# Vendor Capacity Checklist — 200 Parallel Interviews

Fill this in **before** running the staged load test.  
Check each item against your **live account dashboards**, not just the plan docs.

---

## 1. LiveKit

| Item | Required for 200 | Your current limit | Status |
|---|---|---|---|
| Plan | Scale or higher | _____  | [ ] |
| Participant concurrency | ≥ 250 (1.25× headroom) | _____ | [ ] |
| WebRTC participant minutes / month | ≥ 200 interviews × avg 20 min = 4,000 min | _____ | [ ] |
| Server API RPM | ≥ 400 req/min (2 req per interview start) | _____ | [ ] |

**Where to check:** https://cloud.livekit.io → Project → Settings → Project tab

---

## 2. AssemblyAI (Universal Streaming — primary STT)

| Item | Required for 200 | Your current limit | Status |
|---|---|---|---|
| Account type | Pay-as-you-go or higher | _____ | [ ] |
| New session starts / min | ≥ 100/min (ramped, not burst) | _____ | [ ] |
| Concurrent streams | Unlimited with ramp (auto-scales at 70% utilisation) | n/a | ✅ |
| Credits remaining | Enough for 200 × 20 min = 66.7 hr STT at $0.0043/min ≈ $17 | _____ | [ ] |

**Where to check:** https://www.assemblyai.com/app → Billing + Usage  
**Note:** Free accounts: 5 new sessions/min — NOT sufficient. Paid baseline: 100/min.

---

## 3. Gladia (STT fallback)

| Item | Required for 200 | Your current limit | Status |
|---|---|---|---|
| Plan | Paid or Enterprise | _____ | [ ] |
| Live concurrent sessions | ≥ 30 (paid default) or custom enterprise | _____ | [ ] |
| GLADIA_MAX_CONCURRENT env var set? | Set to match your plan ceiling - 5 | _____ | [ ] |

**Where to check:** https://app.gladia.io → Account → Plan  
**Note:** Gladia is used only as fallback — 30 concurrent is acceptable if AssemblyAI handles the main load.  
If planning to use Gladia as primary for some interviews, request enterprise concurrency.

---

## 4. OpenAI

| Item | Required for 200 | Your current limit | Status |
|---|---|---|---|
| Account tier | Tier 3+ ($100 paid, 7+ days) recommended | _____ | [ ] |
| GPT-4o RPM | ≥ 400/min (2 calls per turn × max 5 turns/interview × 200) | _____ | [ ] |
| GPT-4o-mini RPM | ≥ 200/min (1 scoring call per turn) | _____ | [ ] |
| TTS-1 RPM | ≥ 1,000/min (5 speak calls per interview) | _____ | [ ] |
| Monthly spend limit | ≥ $500/mo at 200 interviews/day (estimate) | _____ | [ ] |

**Where to check:** https://platform.openai.com/settings/organization/limits  
**Note:** Response headers also show current limits: `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`.

---

## 5. Application DB (local PostgreSQL)

| Item | Required for 200 | Current setting | Status |
|---|---|---|---|
| DATABASE_POOL_SIZE env var | ≥ 60 for 200 parallel turns | 20 (default) | [ ] |
| Max DB connections (postgres) | ≥ pool size + 10 headroom | check `SHOW max_connections` | [ ] |
| Server RAM for pool | ~5 MB per connection × 60 = ~300 MB overhead | _____ | [ ] |

**How to check:**
```bash
# In the running Postgres container:
docker exec -it ai-interview-local-postgres psql -U postgres -c "SHOW max_connections;"
```

**Recommended .env.local for load testing:**
```
DATABASE_POOL_SIZE=60
```

---

## 6. Next.js server capacity

| Item | Required for 200 | Notes |
|---|---|---|
| Node.js heap | ≥ 2 GB for high concurrency | Set `NODE_OPTIONS=--max-old-space-size=2048` |
| Concurrent requests | Each turn is ~200–500ms of async I/O — Node handles hundreds | No change needed |
| Rate-limiting middleware | Consider adding `next-rate-limit` or Cloudflare WAF for production | Optional |

---

## 7. Pre-load test checklist

- [ ] All 6 vendor sections above are green
- [ ] DB has ≥ 200 pre-seeded `interview_sessions` with `status = 'active'` for synthetic tests
- [ ] k6 `scripts/load-test.js` updated with real token list (`SharedArray`)
- [ ] Run smoke test (1 VU) successfully
- [ ] Run stage_25 — p95 turn latency < 3s, error rate < 1%
- [ ] Run stage_50 — same thresholds
- [ ] Run stage_100 — same thresholds
- [ ] Run stage_200 — target thresholds in load-test.js

---

## 8. Load-test run command

```bash
# Install k6 (Ubuntu/Debian)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Smoke test only
k6 run scripts/load-test.js --env BASE_URL=http://localhost:3000 \
  --include-system-env-vars false \
  --scenario smoke

# Full staged test (run after all checks pass)
k6 run scripts/load-test.js --env BASE_URL=https://your-staging-domain.com
```
