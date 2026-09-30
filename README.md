# Rooted / OwnPlace Demo

This is the smallest runnable Rooted proof: two Kinfolk, each with their own key and their own simulated cloud, follow each other, and OwnPlace renders each porch. The storage provider is replaceable; the protocol package is shared.

## Run

Requires Node.js 18+.

```sh
npm install
npm run publish
npm run web
npm test
```

Open the URL printed by Vite (normally `http://localhost:5173`). The publish command seeds two Kinfolk: Alex on `demo/stores/nextcloud-sim` and Sam on `demo/stores/google-drive-sim`, each with one signed story and following the other. `npm run verify` checks each porch on its own. Post as Sam with `npm run post -- --title T --body B --author-id kinfolk-sam`; the web composer posts as Alex. Subscribe a reader to one Kinfolk's members-only posts with `npm run subscribe -- --author-id kinfolk-sam --reader-id reader-a --reader-pubkey reader-a.pub`; the reader lands in `subscribers.json` on that Kinfolk's porch only. Sam comments with `npm run post -- --author-id kinfolk-sam --reply-to <story id> --body B`, writes on Alex's wall with `--wall kinfolk-alex`, and deletes his own reply with `npm run delete-reply -- --author-id kinfolk-sam --id <story id>`; logged in as Alex, the page has a Comment box on every post and a Write on Sam's wall box in Sam's column.

Each OwnPlace copy can name its own operator Kinfolk, so copies on different machines can be told apart: `OWNPLACE_OPERATOR_ID=kinfolk-jordan OWNPLACE_OPERATOR_NAME=Jordan npm run publish` (optionally `OWNPLACE_OPERATOR_BIO`). Set the same variables for the web server and every CLI on that copy. They replace Alex's id, name and bio everywhere the operator is used (web posts, the Your invite panel, the operator's contacts, `npm run publish`, `post`, `delete-reply`, `subscribe` and `verify`); the porch and cloud stay `nextcloud-sim` / kevcloud and Sam is unchanged. The id must be a safe Kinfolk id other than `kinfolk-sam`, the name 1 to 120 characters and the bio at most 500; anything else refuses to start. Unset, the operator is Alex Rowan as before.

Write API auth: set `OWNPLACE_WRITE_TOKEN`; on HTTPS deploys also set `COOKIE_SECURE=1` so session cookies require TLS.

Public URL (operator): the server binds `127.0.0.1:8091`. Expose it via
Tailscale serve (`tailscale serve --bg --https=<port> http://127.0.0.1:8091`)
or an nginx `location /ownplace/` proxy with `proxy_set_header X-Forwarded-Proto $scheme`.
Reads stay public; writes still require the operator token/session.
`GET /api/health` returns `{ok:true}` for uptime checks.
Followers on other instances read this porch at `https://<public-url>/porch/nextcloud-sim` (add that as an `https:` contact address); only signed package files and `timeline.json` are served there.
Behind TLS the session cookie is marked Secure automatically
(or force with `COOKIE_SECURE=1`).

New packages use persistent Ed25519 Kinfolk identities. The publisher stores private keys in `~/.local/share/ownplace/identities/` (override with `OWNPLACE_IDENTITY_DIR`); back them up securely. `kinfolk.json` publishes the public key, and the headless Kinfolk client verifies the latest package manifest signature and content hashes. Historical timeline reads verify each history package's Ed25519 manifest/signature and content hashes before display; unverified or legacy demo-placeholder entries are hidden, never presented as authenticated. A newly fetched public key is self-asserted: pin or verify it out of band before trusting an identity across time. Legacy demo-placeholder packages remain accessible as files, but verifying readers reject them; republish to obtain a signed package. Public stories are plaintext; gated stories seal the body for the entitled readers (AES-256-GCM data key wrapped per reader via X25519) while title and metadata stay public. Gated packages also carry a signed `entitlements.json` sidecar (`{ storyId, entitled: [{ readerId }] }`, ids only) so readers can discover entitlement without trial-decrypting; the CLI seals for many readers at once with `npm run post -- --entitle-readers readers.json`.

## Layout

- `packages/protocol`: Kinfolk, story, manifest, signature types and canonical hashing.
- `packages/storage`: `ObjectStore` and `LocalFolderStore`, with WebDAV and Google Drive scaffolds.
- `packages/timeline`: shared story-package build, verified index read/rebuild, follows, and publishing to the author's own porch.
- `apps/creator-bot`: sample package publisher.
- `apps/client-sims`: headless Kinfolk clients that verify each porch on its own (hashes, signatures, owner key, pinned follows).
- `apps/ownplace-web`: Vite/React reader, one column per Kinfolk porch.
- `apps/voice-bridge`: Python Slack Socket Mode listener bridging push-to-talk meeting turns to OpenCode reasoning.
- `docs/architecture.md`: data flow and adapter boundary.
- `docs/google-drive-access.md`: safe future authorization procedure.
