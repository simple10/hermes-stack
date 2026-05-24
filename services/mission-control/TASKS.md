# MissionControl — TODO

Short-lived task list for follow-ups that don't yet warrant a spec/plan pair.
Move items to `docs/plans/` when they grow beyond a checkbox.

## Pending

- [ ] **2026-05-30 or later** — bump `@cloudflare/vitest-pool-workers` from `0.16.6`
      back to latest (likely `0.16.9` or newer by then). Pinned down on
      2026-05-23 because `0.16.7`/`0.16.8`/`0.16.9` were still inside pmg's
      5-day supply-chain cooldown. Check with:
      ```sh
      curl -s "https://registry.npmjs.org/@cloudflare/vitest-pool-workers" \
        | jq -r '.["dist-tags"].latest'
      ```
      then `pnpm up @cloudflare/vitest-pool-workers@<latest>` and re-run the
      per-file test loop to verify.
