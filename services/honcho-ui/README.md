# honcho-ui

[OpenConcho](https://github.com/offendingcommit/openconcho) — static SPA
viewer for Honcho. Built from a pinned commit (`HONCHO_UI_VERSION` lever).
`SERVICE_REQUIRES=honcho` (cascades the full honcho stack on enable).

Open at https://honcho-ui.<project>.orb.local (OrbStack auto-HTTPS). The
connect form is pre-filled with a same-origin Honcho proxy (nginx
reverse-proxies `/honcho/` on the same origin to bypass Honcho's hardcoded
CORS allowlist); just click Save (entering a token if you have one).

No model levers, no DB, no secrets — all behavior comes from `honcho-api`.
