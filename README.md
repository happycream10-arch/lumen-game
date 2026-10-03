# LUMEN — 별빛 수집가

A Korean browser creature-card collection game with server-owned currency, collections, random packs, crafting, three coin minigames, and asynchronous two-account pack duels.

## Content
- 48 original creature illustrations in three regions, six rarity editions per creature, 288 collectible entries. Rarity editions share the species illustration.
- Five-card packs, region-specific pools, premium final slot, disclosed odds, and a 20-pack UR pity rule.
- Timing, matching, and sorting minigames, with capped server-calculated rewards. Timing accuracy is reported by the browser; this is a casual game, not a cheat-resistant competitive economy.
- Per-account D1 saves. Coins and draws are resolved on the server. Revision compare-and-swap and request receipts prevent duplicate purchases/reward claims during retries.
- Six-character rooms restricted to two authenticated participants; each opens five standard packs, keeps the cards, and compares rarity points. Polls every four seconds while the room is visible.
- Responsive Korean interface, reduced motion, optional synthesized sound, collection filters, card details, duplicate dust, crafting, and one-time milestones.

## Build and verification
`npm ci`
`npm run db:generate` only after schema changes
`npm run build`
`node scripts/test-game.mjs`

The build produces a Cloudflare Worker in dist/server/index.js. Public text and compressed artwork are embedded for a self-contained deployment; no third-party art hosting is required. Fonts have local/system fallbacks.

## Hosting assumptions
D1 logical binding DB; migrations in drizzle. The authenticated identity comes exclusively from the Sites dispatcher header oai-authenticated-user-id. /signin-with-chatgpt and /signout-with-chatgpt are dispatch-owned. Never trust a client-provided identity header on a standalone external host; replace this integration with a verified authentication system before moving outside Sites. Site audience is managed by the hosting platform and remains private until explicitly shared.

## Release status
This is a playable web build, not a Steam-shippable binary. No desktop installer, Steamworks integration, controller certification, external-user access provisioning, production load test, or completed browser/device QA is included. Native browser QA was unavailable in the authoring environment; core economy, API isolation, idempotency, minigames, rooms and serving are covered by the executable verification script.

Original source atlas PNGs were generated as 4×4 grids; compressed WebP assets are in public/assets. Illustrations were generated with the built-in image generation tool from original creature concepts. No Pokémon artwork, names or logos are used.

## Version 1.1 standalone release
- Run `node standalone/server.mjs` with Node 24; the release ZIP includes the compiled Worker, so no dependency install is needed to play.
- Independent username/password accounts, scrypt password hashes, HttpOnly sessions, one-time recovery code rotation, login rate limiting, and strict origin checks. The standalone adapter strips all caller-supplied platform identity headers.
- Real SQLite saves, migration journal, Docker/Caddy HTTPS deployment, and a Korean operator guide in standalone/사용설명서.txt.
- `node scripts/test-release.mjs` verifies complete two-account play and disk persistence; `node scripts/test-http.mjs` tests the actual HTTP server.
- Sites still uses its platform boundary; the forwarded authenticated email is accepted as a stable hashed identity when the platform supplies email without user ID. Anonymous requests remain blocked.
- A public external URL is not provisioned: this workspace disallows public/external access and no external hosting account is connected. The standalone release does not remove or circumvent the access policy on the existing Site.
