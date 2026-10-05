# ADR 0009: Fixed-horizon frequentist statistics with SRM detection

- Status: accepted
- Date: 2026-10-01

## Context

Experiment results must be explainable and correct by default. The common failure modes are peeking, broken randomization and multiple comparisons.

## Decision

- Conversion metrics: two-proportion z-test (pooled SE for the test, unpooled SE for the 95% CI of the difference), relative lift.
- Numeric metrics: Welch t-test on per-unit sums (units without events count as zero), Welch–Satterthwaite degrees of freedom, CI from the t quantile.
- Sample ratio mismatch: χ² goodness-of-fit of observed units against the configured rollout weights; p < 0.001 shows "the experiment may be broken".
- A sample size calculator (normal approximation, Bonferroni-adjusted α for more than two variations), a peeking warning until the planned sample size is reached, and a multiple-comparisons warning.
- Units are counted at their first exposure inside the experiment window; metric events count only after the unit's first exposure.
- Distributions (normal, Student t via the regularized incomplete beta, χ² via the regularized gamma) are implemented in about 200 lines and tested against independently computed values.

## Consequences

- Simple, widely understood numbers; the demo experiment detects the built-in +8% relative effect of variant B with 27 000 visitors while SRM stays green.
- Fixed-horizon tests are invalid if you stop at the first p < 0.05; this is mitigated with warnings, not prevented. Sequential tests (mSPRT, always-valid p-values) or CUPED variance reduction are listed as next steps.
- With three variations, one of the null variations can appear significant by chance (seen in the demo data for revenue); the UI shows the Bonferroni threshold instead of hiding it.
