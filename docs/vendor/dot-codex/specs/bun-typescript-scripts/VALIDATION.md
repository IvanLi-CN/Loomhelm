# Bun + TypeScript Migration Validation

This report binds the verification evidence to the code candidate `ff18c1c4` (`ff18c1c4ed83e24f07ea9b207be4134629e29bfc`) in parent PR base `e7b7d8e14924c05b50eab8e4f67cd8d4eb0658e2`. The report is carried by a later documentation commit on the parent PR; the macOS run remains bound to the exact code candidate SHA.

## Agent VM

- Session: `bun-migration-parent-final`, generation 8, Linux x86_64, 2 vCPU, 4 GiB RAM.
- Runtime: Bun `1.4.4`, `@types/bun` `1.4.4`, sharp `0.35.5`, GNU bash `5.2.37`, jq installed.
- Source was synchronized into the VM before every validation run. No host test or validation command was used.

## Validation commands

The final VM run completed with exit code 0:

```text
bun install --frozen-lockfile
bun run validate
bash -n bin/plan-cli.sh
bun check bin/modules/plan/contract.ts bin/modules/plan/review.ts bin/plan_review_view.ts bin/plan_contract_check.ts
```

`bun run validate` reported source-policy success (`source <=400`, `tests <=600`), no type errors in 442 files, and all 448 formatted files. Domain totals were core 25 pass/1 skip, hosting 24 pass, flow 27 pass, plan 89 pass/1 skip, docs 21 pass, workspace 25 pass, visual 45 pass/10 skip, waves 14 pass, and checks 40 pass. The aggregate is 310 pass, 12 skip, and 0 fail.

The compatibility verifier reported `entrypoints=82`, `scenarios=986`, `missing=0`. The state summary was `audited=875`, `equivalent=38`, `baseline_failed=54`, and `baseline_unavailable=19`; the latter are recorded baseline facts and do not represent missing Bun mappings.

The current Linux native suite completed with 34 pass, 9 platform skips, and 0 fail. It covered exclusive lock contention, no-follow reads, symlink and hard-link rejection, atomic publication, path containment, image limits, and process-isolation adapters. The skipped cases require macOS clonefile/sandbox capabilities.

## macOS GitHub Actions evidence

The manual-only workflow [run 41171412584](https://github.com/IvanLi-CN/dot-codex/actions/runs/41171412584) checked out source revision `ff18c1c4ed83e24f07ea9b207be4134629e29bfc` on `macOS-ARM64` / macOS `14.8.9` with Bun `1.4.4`. The explicit native suites completed with core 2 pass / 0 fail and visual 41 pass / 0 fail, for 43 pass / 0 fail and 91 expectations. The uploaded identity artifact records the source revision and runner.

The first workflow attempt failed only because the SIGPIPE probe invoked `/usr/bin/perl`, which GitHub's macOS Seatbelt denied while resolving `/usr/bin/perl5.34`; the probe now uses the equivalent `/bin/bash` target and the exact-head rerun passed.

## Performance comparison

On the same Agent VM, each command ran serially 30 times against the same inputs. Values are p50/p95 wall time and peak resident memory; no fixed speedup is promised.

```json
{
  "bun_cold": { "p50_ms": 0.0, "p95_ms": 20.0, "peak_rss_kb": 12224 },
  "bun_plan": { "p50_ms": 30.0, "p95_ms": 90.0, "peak_rss_kb": 38000 },
  "bun_replay": { "p50_ms": 70.0, "p95_ms": 140.0, "peak_rss_kb": 34804 },
  "python_cold": { "p50_ms": 0.0, "p95_ms": 10.0, "peak_rss_kb": 8712 },
  "python_plan": { "p50_ms": 40.0, "p95_ms": 60.0, "peak_rss_kb": 19748 },
  "python_replay": { "p50_ms": 70.0, "p95_ms": 150.0, "peak_rss_kb": 17736 }
}
```

The benchmark used the cold-start command, the canonical wave-thread plan fixture, and the confirmed UI-route replay fixture. Bun was faster for plan parsing and had lower plan/replay p95 in this run; its peak RSS was higher. These are measurements for this VM and input set, not a release guarantee.

## Platform disposition

Linux full-suite evidence remains historical for the earlier e59 candidate because the owner prohibited local and Agent VM reruns after the test-gate policy change. macOS native A11 evidence is complete for the ff18 code candidate through the manual GitHub Actions run above. The default `test:all` and `validate` paths intentionally exclude native suites; native validation is explicit and manual-only.

The verified P2 findings from earlier review, including timestamp year-zero handling and the pre-trap launcher startup window, remain intentionally deferred under the owner instruction to fix only P0/P1 findings.
