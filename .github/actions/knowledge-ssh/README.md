# `knowledge-ssh` — authenticate the private knowledge git dependency in CI

The workspace depends on the **private** `kennguy3n/knowledge` repo as a
git dependency (pinned in the root `Cargo.toml`). GitHub-hosted CI runners
have no credential for it, so any `cargo` step that resolves the dependency
graph (`clippy`, `build`, `test`, `metadata`, `vet`) fails at the git-fetch
step. See `docs/adr/0011-knowledge-substrate-integration.md`.

This composite action fixes that with a **read-only SSH deploy key**: it
writes the key, pins github.com's host keys, rewrites *only* the
`https://github.com/kennguy3n/knowledge` remote to SSH (via `insteadOf`,
scoped so Tessera's own token-based https checkout is untouched), and sets
`CARGO_NET_GIT_FETCH_WITH_CLI=true` so cargo fetches through the system
`git` (which honours the rewrite + `GIT_SSH_COMMAND`).

It is wired into every cargo job: `rust` and `supply-chain` in
`.github/workflows/ci.yml`, and `build` in `.github/workflows/release.yml`.

## One-time setup

1. **Generate a dedicated keypair** (no passphrase) on any machine:

   ```bash
   ssh-keygen -t ed25519 -C "tessera-ci-knowledge-deploy" -f knowledge_deploy -N ""
   ```

   This produces `knowledge_deploy` (private) and `knowledge_deploy.pub`
   (public).

2. **Add the PUBLIC key as a read-only deploy key on the knowledge repo:**
   `kennguy3n/knowledge` → Settings → Deploy keys → *Add deploy key*.
   Paste the contents of `knowledge_deploy.pub`. **Leave "Allow write
   access" unchecked** (read-only is all CI needs).

3. **Add the PRIVATE key as an Actions secret on the Tessera repo:**
   `kennguy3n/Tessera` → Settings → Secrets and variables → Actions →
   *New repository secret*. Name it exactly **`KNOWLEDGE_DEPLOY_KEY`** and
   paste the full contents of `knowledge_deploy` (including the
   `-----BEGIN …-----` / `-----END …-----` lines).

4. **Delete the local key files** once both halves are uploaded.

After the secret exists, re-run CI on any open PR; the cargo jobs will
fetch the knowledge dependency over the deploy key and run to completion.

> Forked-PR note: GitHub does not expose secrets to workflows triggered by
> PRs from forks, so the cargo jobs can't authenticate there. This repo is
> single-owner with no external forks, so that path doesn't apply today; if
> that changes, gate the cargo jobs on `github.event.pull_request.head.repo.fork == false`.
