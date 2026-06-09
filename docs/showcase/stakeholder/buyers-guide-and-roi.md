# Tessera — Buyer's Guide & ROI

*A practical framework for evaluating Tessera and estimating its return.*

## Who this is for

Team leads and operations buyers in healthcare, legal, finance, nonprofit, and
sales/consumer-goods organizations where staff repeatedly turn source material into
structured deliverables — and where data sensitivity rules out cloud AI tools.

## Is Tessera a fit? A quick qualifier

You're likely a strong fit if **three or more** of these are true:

- [ ] Your team produces recurring structured documents (reports, memos, summaries, proposals,
      decks) from existing source material.
- [ ] Some of that source material is regulated or confidential (PHI, NPI, privileged,
      personal data) and cannot be sent to a cloud AI service.
- [ ] You need outputs to be **defensible** — traceable to sources, structurally complete.
- [ ] Your people spend meaningful time formatting and assembling rather than deciding.
- [ ] You want predictable cost without per-seat-plus-usage cloud AI billing.

## The ROI model

The value is **time reclaimed per deliverable**, multiplied by volume, with quality and risk
benefits on top.

### Time-savings illustration

The figures below are an **illustrative framework**, not a benchmark — plug in your own
numbers. They show the shape of the return, drawn from the kinds of deliverables in this
showcase.

| Deliverable | Typical manual time | With Tessera (draft + edit) | Time saved / unit |
|-------------|--------------------:|----------------------------:|------------------:|
| HIPAA incident report | 4–6 hrs | 1.5–2 hrs | ~3 hrs |
| Contract summary + tracker | 2–3 hrs | 0.5–1 hr | ~2 hrs |
| Credit memo + projection | 5–8 hrs | 2–3 hrs | ~4 hrs |
| Grant proposal | 8–12 hrs | 3–5 hrs | ~5 hrs |
| QBR deck + CRM refresh | 4–6 hrs | 1.5–2 hrs | ~3 hrs |

**Worked example.** A 6-person credit team produces ~8 memos/week. At ~4 hours saved per memo
and a $75/hr loaded cost:

```
8 memos/week × 4 hrs saved × $75/hr = $2,400/week
                                    ≈ $124,800/year reclaimed
```

Even discounting heavily for ramp-up and edge cases, the reclaimed-time value of a single
recurring deliverable type typically dwarfs the tool's cost — and because the model runs
locally, there is **no per-token usage bill** scaling against that volume.

### Beyond time: the benefits that don't show up on a stopwatch

- **Risk reduction.** Template-enforced structure means required sections (e.g. the HIPAA
  four-factor analysis, a credit memo's covenants) can't be skipped under deadline pressure.
- **Defensibility.** Inline citations create an audit trail from claim to source — directly
  reducing review and rework cycles.
- **Consistency.** Every artifact comes out in the same house format, so reviewers trust it
  and downstream readers know where to look.
- **Compliance enablement.** For regulated data, local-first isn't a saving — it's the only
  way to use AI here at all. The "alternative" isn't a cheaper tool; it's doing it by hand.

## Total cost of ownership

- **Software:** open-source, MIT-licensed.
- **Inference:** local model — no per-token API cost, no usage-based cloud bill.
- **Infrastructure:** runs on existing user machines; no server fleet to provision for
  inference.
- **Onboarding:** simplified navigation, an intent-based Create wizard, and automatic
  background model setup minimize ramp time for non-technical staff.

## Evaluation plan (recommended 2-week pilot)

1. **Pick one recurring deliverable** your team produces weekly (start narrow).
2. **Index the real source material** for 3–5 recent instances of it.
3. **Generate and edit** each through the matching template; time the end-to-end effort.
4. **Compare** against your current manual baseline for the same instances.
5. **Have a reviewer/compliance stakeholder** assess the citations and structural
   completeness, not just speed.
6. **Decide** based on reclaimed time × volume, plus the qualitative risk/consistency gains.

## Questions to ask in your evaluation

- Does the output trace cleanly back to our sources?
- Is the structure complete enough that reviewers trust it on the first pass?
- Does it keep sensitive data on the device throughout (verify network behavior)?
- How much editing does a draft need before it's deliverable — and is that shrinking as the
  team learns which templates fit?

## Where to start

Run the pilot on the persona closest to your team in the [showcase](../README.md), and inspect
that persona's [inputs, prompts, and outputs](../artifacts) to calibrate expectations before
you begin.
