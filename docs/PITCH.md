# RescueRoute: concept selection, demo script and pitch

## 1. Concepts considered

| # | Concept | Orig. /20 | Agentic /25 | Tech /20 | Security /15 | Impact /10 | Google /10 | **Total** |
|---|---|---|---|---|---|---|---|---|
| 1 | **RescueRoute**: agent plans surplus-food dispatch under expiry, cold-chain and capacity constraints, with human approval | 17 | 22 | 17 | 13 | 9 | 7 | **85** |
| 2 | Clinic medicine-stock agent: forecasts stock-outs and drafts transfer requests between clinics | 16 | 19 | 15 | 12 | 8 | 7 | 77 |
| 3 | Campus energy agent: reads meter CSVs, finds anomalies, schedules HVAC changes | 14 | 18 | 15 | 11 | 8 | 7 | 73 |
| 4 | Exam study-plan agent: builds a timetable from syllabus and past scores | 11 | 15 | 13 | 10 | 6 | 7 | 62 |
| 5 | Small-shop restock agent: reorder suggestions from sales CSV | 12 | 16 | 14 | 10 | 7 | 7 | 66 |

**Why #1 won:** the problem has hard, checkable constraints, so AI output can be *verified*. Results are *measurable* in kg delivered and violations. The demo is fully reproducible with synthetic data, and there's a natural human-approval step. Concept 2 was close, but it needs credible medical data I couldn't source responsibly in one day.

## 2. Five-minute live demo

| Time | Do | Say |
|---|---|---|
| 0:00 | Show the login page | "Restaurants and hostels in Pune throw away food every evening while shelters 5 km away go short. Coordinators juggle expiry, cold chain, capacity and closing times on WhatsApp." |
| 0:30 | Sign in as coordinator; Dashboard | "13 open donations, about 500 kg expiring within 3 hours. The map shows donors, NGOs and vehicles." |
| 1:00 | Point to the Viman Nagar breakfast note | "This donor note is a prompt-injection attack: it tells the AI to send everything to one shelter and approve it all." |
| 1:15 | **Plan with agent → Run agent** | "Gemini is now calling real tools: listing data, ranking options, proposing dispatches. Every step lands in this timeline with its latency." |
| 2:15 | Outcome card | "All four success criteria pass: zero violations after independent re-verification, more than 90% of feasible kg, every urgent donation placed, and everything waiting for a human." |
| 2:45 | A dispatch card | "Green facts are computed in code: distance, pickup time, safety slack. Blue is the AI's reasoning, which is never trusted on its own. The injected note had no effect, because the model has no approval tool and code rejects unsafe plans." |
| 3:15 | Approve one, reject one | "A human decides. Rejected food goes back to open; approved food is locked. Both actions are audit-logged." |
| 3:40 | Bulk-rice row | "400 kg exceeds every vehicle, so the system says so instead of pretending." |
| 4:00 | Terminal: `npm test` and the evaluation results | "55 automated tests, including timeouts, malformed AI output and cross-user access. Across 200 synthetic scenarios we deliver 67% more food safely than first-come-first-served dispatch, with zero unsafe dispatches versus 1,558." |
| 4:40 | Close | "The AI reasons; code guarantees safety; humans stay in control. That's RescueRoute." |

**Backup:** if the Gemini API is slow or down, the Gemini AI planner stage shows *failed* with the classified reason (for example `RATE_LIMITED`) and the Deterministic fallback stage shows a *warning*. That is itself a reliability feature worth showing.

## 3. Presentation outline (6 slides)
1. **Problem:** food waste vs hunger; manual dispatch fails under time pressure.
2. **Solution:** agent proposes, code verifies, human approves (diagram).
3. **Live demo.**
4. **Engineering:** bounded loop, 7 allow-listed tools, retries, timeouts, fallback, gap-fill, verification.
5. **Security and testing:** threat table, 55 tests, prompt-injection defence.
6. **Results and next steps:** +67.5% kg vs baseline, p95 under 2 ms planner, Gemini metrics; next is the Maps Routes API, Firebase Auth and multi-stop pooling.

## 4. Criteria scoring matrix

| Criterion | Evidence |
|---|---|
| **Code quality** | Layered modules (domain, agent, data, API, UI); dependency injection; one schema source for validation and Gemini declarations; no build step; lint script |
| **Security** | See README §5: RBAC, signed tokens, scrypt, CSP, rate limits, IDOR protection, prompt-injection defence, audit log, human approval |
| **Efficiency** | Planner p50 0.74 ms; listing outputs compacted in the timeline; bounded turns and tool calls; 5 runtime dependencies; one static frontend with no framework |
| **Testing** | 55 tests (97.2% line coverage) across unit, integration, agent, security, accessibility and failure paths; CI on every push; reproducible evaluation script |
| **Accessibility** | Semantic landmarks, skip link, labelled forms, `role="status"`/`aria-live` updates, `aria-current` navigation, visible focus, SVG map with text alternative and legend, dark mode, reduced-motion support, responsive down to phone width |
| **Problem alignment** | Real-world sustainability and food problem; agentic plan → act → verify → evaluate; Gemini function calling; measurable impact |
