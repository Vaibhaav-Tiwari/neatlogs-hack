# Tally Business Plan

Submission version, 12 October 2026. This is a business hypothesis supported by
a small working-product experiment, not a forecast backed by paying customers.
**Measured** means recorded in real Tally runs; **assumption** means a scenario
input that still needs validation. Run costs are estimates from recorded tokens
and configured model list prices, not provider invoices.

## Problem and Customer

Coding-agent teams can spend top-model prices on routine tasks while losing
visibility into retries, abandoned work and verification outcomes. Subscription
or account-level limits do not tell a team how much one task should cost.

Our proposed customer is the engineering lead or budget owner of a team already
using coding agents, with repeatable, testable tasks and enough agent spend to
justify cost controls. This customer profile is a hypothesis: we have not
verified willingness to pay or signed customers. Engineering headcount alone is
not evidence of coding-agent seats, agent spend or savings.

## Product

Tally is a local CLI that chooses a configured model tier for each task, sets a
spend ceiling, watches usage and verifies the result before publishing a task
PR. A capped or failed attempt can escalate to a stronger tier with the earlier
branch and metadata-only Entire checkpoint context. Generated summaries remain
off by default. Polling and metering can overshoot a ceiling; it is not a hard
provider-side billing limit.

Workers run sequentially through direct Claude Code or Codex commands, or
through Agent Orchestrator (AO), including parallel AO workers. Neatlogs history
supplies observed pass rates and costs for task size and actual model when
enough observations exist; otherwise Tally explicitly uses priors/configured
caps. Entire supplies graph sizing and checkpoint evidence. cfo.ai supplies
the monthly budget and records real spend. Local ledger and CSV records remain
available when integrations are unavailable.

## Pricing and the Baseline

**Proposed pricing: share of savings.** The customer pays a share of what Tally
saved, and nothing when it saves nothing. The example share below is an
**assumption**, not a committed commercial rate.

```text
Monthly fee = agreed share x max(0, agreed baseline cost - actual Tally cost)
```

The baseline must be agreed before billing, using a matched sample of tasks
executed on the customer's chosen top model, with the same starting code,
task text and verification criteria. The agreement must specify task mix,
accepted outcomes, model prices, caching treatment and how repeats are sampled.
Tally cost includes failed attempts, escalations and operational retries for
that workload; unstarted or unresolved work cannot be counted as savings.
Matched successful outcomes are required before comparing value delivered.

For a pilot, report estimated savings first and reconcile costs with provider
bills before charging. A previous month's bill can help plan a budget but is
not a matched-task baseline. Pricing a cheap model's tokens at top-model rates
is a price comparison, not measured savings: a stronger model may use different
tokens. Agreeing a reliable baseline and a billing/audit process is still work
to do; the proposed commercial fee is not automatically collected by Tally.

## What Is Measured

Three matched tasks were run once per pass against the same pinned starting
commit and identical task text. Two other planned tasks were not run.

| Pass | Routing | Estimated total USD | USD per task | Final tasks passing | Cheaper than A |
| --- | --- | ---: | ---: | ---: | ---: |
| A | Every task on the top tier | 1.21693600 | 0.40564533 | 3/3 | Baseline |
| B | Tally v1, built-in priors | 0.30932564 | 0.10310855 | 3/3 | 74.58% (about 75%) |
| C | Tally v2, history enabled | 0.42632384 | 0.14210795 | 3/3 | 64.97% (about 65%) |

Evidence identifiers: source `9f18111e948a0a7c7e09c99dc86f854ca595e1a8`,
pinned task base `565e6ccd757ff794ead643dac7359efe67ec9db2`, runs
`run-20261012T104159Z-comparison-A`,
`run-20261012T105538Z-comparison-B` and
`run-20261012T111142Z-comparison-C`.

Each pass also had three separately recorded zero-token startup retries from
an experiment spawn timing bug. These are infrastructure retries, not model
failures or additional model attempts-to-success; recorded costs remain in the
totals. The 3/3 pass rate is the final verified task rate, not a claim of clean
starts. cfo.ai was off in these comparison passes to avoid concurrent writes.

**Limits:** three tasks, one run each per pass, in one repository; no confidence
intervals or repeatability claim. In C only the large task used observed
Neatlogs statistics: its top-cost expectation changed from $1.50 to about
$0.303 from two samples. No selected tier or cap changed between B and C.
The other tasks still used priors; learned caps require five successful
observations for the relevant size/model. C read shared history, not an
isolated dataset containing only B. C cost more than B: this experiment does
not establish that trace-driven routing improves on prior-only routing.
Model variability and caching are confounders. Most earlier tasks were small
documentation changes. Graph size did not show a clear linear cost signal in
this sample; it is not a validated general cost predictor.

Other real-run evidence establishes capability, not commercial performance:

- All four runner/harness paths completed verified work: Codex via AO, Claude
  Code via AO, Claude Code direct and Codex direct; see the README's
  [real-run evidence](../README.md#real-run-evidence).
- Cap-and-escalate worked in `run-20261012-100856Z`: the cheap attempt was
  stopped at a $0.018 ceiling (recorded spend $0.01956044), then the middle
  attempt passed at $0.16957640. Its ceiling diagnosis came from the ledger,
  not an error that the worker trace exposed.
- Parallel AO workers completed verified tasks in
  `run-20261012-120222Z`, with worker trace IDs recorded and cfo.ai spend
  reconciled to the ledger. This is a capability proof, not a throughput study.

## Unit Economics: One Hypothetical Customer

| Input or Calculation | Value | Basis |
| --- | ---: | --- |
| Engineers using coding agents | 25 | Assumption; not a measured seat count |
| Top-model spend per engineer per month | $200 | Assumption; must be checked against actual agent usage |
| Baseline monthly agent spend | $5,000 | Scenario: 25 x $200 |
| Share of spend/workload routable to cheaper tiers | 60% | Assumption; requires workload-weighted validation |
| Saving on that routable portion, including retries | 80% | Assumption; not established by the experiment |
| Monthly saving | $2,400 | Scenario: $5,000 x 60% x 80% |
| Tally share of savings | 20% | Assumption |
| Monthly revenue per customer | $480 | Scenario: $2,400 x 20% |
| Customer's retained monthly saving | $1,920 | Scenario: $2,400 - $480 |

The draft's 80% assumed saving was discounted from an earlier roughly 95%
**same-token list-price gap**, allowing for retries and escalation. That price
gap was not a measured task saving. **80% is above, not below, the measured
65-75% aggregate saving in this three-task experiment.** It must not be called
conservative relative to that result. Savings on the routable subset and
savings across the whole workload also have different denominators. Keep
$480 as an illustrative assumption-driven scenario, not an evidenced revenue
projection. Replace these inputs with customer workload and bill data.

## Pilot Funnel: First Six Months

CrustData Job Search returned 25 posts; two ambiguous/incomplete posts were
dropped and three duplicate-company posts grouped, leaving **20 distinct
company-domain hiring-intent leads**. Their engineering job descriptions name
coding tools. This establishes a prospecting signal, not deployed use, buying
intent, qualified customers, paying pilots or market size. Posting companies
may be staffing firms, cross-posts can represent the same employer, and sources
were not independently visited. No customer names are claimed here.

| Stage | Number | Basis |
| --- | ---: | --- |
| Hiring-intent leads discovered | 20 | API-derived evidence, not buyer qualification |
| Leads contacted in six months | 200 | Assumption; needs additional prospect discovery, not extrapolation from the 20 |
| Pilot conversion | 5% | Assumption |
| Pilots started | 10 | Scenario: 200 x 5% |
| Pilot-to-paying conversion | 40% | Assumption |
| Paying customers | 4 | Scenario: 10 x 40%; no signed customers evidenced |
| Monthly revenue at month six | $1,920 | Scenario: 4 x $480; not cumulative six-month revenue |

The job-intent search cost **0.75 credits**, including the account's reported
fixed query cost; do not quote a result-only rate as the total. The secondary
10-company firmographic search cost 6.3 credits and had no verified coding-tool
use. Neither query match counts nor the historical 2,085 raw matches are TAM
or qualified buyer counts. `tally market --replay` produces the cached
JSON/CSV/Markdown report without another search or credit spend.

## Costs and Delivery

- **Model cost:** Tally makes no model calls of its own in the demonstrated
  deterministic routing and metadata-only handoff path. Workers use the
  customer's model accounts; their spend is a customer expense, not free
  compute. Optional model-assisted sizing or generated summaries would add
  costs if explicitly enabled and are not assumed here.
- **Integrations:** Neatlogs, Entire and cfo.ai plan costs have not been
  established for a commercial customer; no invented monthly amount is used.
- **Prospecting:** CrustData costs credits; the cached lead report is reusable.
  Future qualification budgets must use account-specific pricing and limits.
- **Hosting:** the CLI runs locally; the project website is static. Commercial
  hosting, support, onboarding, security, billing and maintenance costs remain
  unmeasured. $480 is revenue, not profit or validated gross margin.

## cfo.ai in the Product and the Plan

In the product, Tally reads the current month's agent budget and existing spend
from the selected cfo.ai workspace/scenario. Real attempt spend is written back
and read back for reconciliation with the local ledger. Simulated costs are
never written to cfo.ai; failed writes leave local CSV evidence. Read access
and write-back have worked on real runs, separately from the cfo.ai-off
three-pass comparison.

The [Tally business plan page in cfo.ai](https://app.cfo.ai/s/p_AQGqpgYkMjM1YmZjNzEtNmZjMi00NmYxLTk3YjktN2RlMjZjMzY5YjZjDWRlZmF1bHRfbGF5ZXI)
holds the earlier planning scenario with editable assumptions. This document
updates its evidence and caveats; it does not claim that those updates have
already been synchronized to the page or write any financial model data.
The plan is separate from the live agent budget/spend tables.

## Risks and Next Validation

1. Repeat more matched tasks across repositories, task types and models;
   measure verification failures, escalation costs, caching and startup errors.
   Test whether history actually changes model/cap choices and improves results.
2. Agree auditable baselines and reconciliation rules with pilot users before
   charging a share. Validate actual spend, budget pain and willingness to pay,
   rather than deriving agent spend from headcount.
3. Qualify the hiring-intent leads directly and measure the funnel. The 200
   contacts and all conversion/revenue figures remain assumptions.
4. Fix concurrent cfo.ai write-back: two separate Tally processes can overwrite
   one page's spend cells because cached base-plus-run writes are not atomic
   increments. Use one writer per shared model until this is addressed.
5. Add explicit init disclosure/consent for finance-link sharing. Enabled cfo.ai
   currently causes configured budget/spend URLs to be posted in task PR bodies
   without a separate question. Links do not grant access, but exposing finance
   workspace addresses still matters; avoid configuring shareable links until
   this behavior is acceptable to the repository owner.
6. Establish integration costs, support/security obligations and a repeatable
   onboarding path. Mixed-harness AO switching after a Claude attempt, direct
   escalation and no-account onboarding still need broader live validation.

The measured result supports a pilot experiment: lower estimated cost with
the same final pass count on this tiny sample. It does not establish a market
size, guaranteed savings, profitability or product-market fit.
