# Chrome Web Store listing

Source assets and the submission checklist for the Web Store listing. Moved here from
`discerned-ext/store-assets/` — nothing in the extension build reads them, and they are now
consumed by more than one listing (Web Store, nostrapps.com).

| File | Use |
|---|---|
| `STORE-SUBMISSION.md` | Submission checklist + the listing's description copy |
| `promo-tile-440x280-azure.png` | Small promo tile |
| `marquee-1400x560.png`, `discerned-marquee-1400x560-azure-option1.png` | Marquee variants |

**The four screenshots are NOT here.** They live at `discerned-web/public/press/screenshot{1..4}.png`
so they can be served from `discerned.online` for third-party directory listings — see
`../directories/README.md`. One copy only: don't duplicate them back into this folder.

Screenshots are 1280x800, the Web Store's expected size. When replacing one, overwrite the file
in `public/press/` (the served URL is stable) and re-upload to the Web Store dashboard
separately — the two are not linked.
