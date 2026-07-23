# stremio-artwork

Self-hosted artwork server for Stremio's **AIOMetadata** add-on. Serves:

- **Posters** (`/poster/...`) — picked from TMDB/TVDB using a language/vote-based
  fallback chain, then rendered with a dark info bar showing genre, a
  rating-progress strip, and an aggregated multi-source rating.
- **Backdrops** (`/backdrop/...`) — a deduplicated, slow-rotating pool of
  textless backdrops pulled from TMDB/TVDB, served via redirect so clients
  always get a fresh pick without you re-encoding bytes.

## URL format (set these in AIOMetadata)

```
Poster:   https://your-domain.example/poster/tvdb:{tvdb_id}&tmdb:{type}:{tmdb_id}.jpg
Backdrop: https://your-domain.example/backdrop/tvdb:{tvdb_id}&tmdb:{type}:{tmdb_id}.jpg
```

Either id segment can be missing (AIOMetadata drops the whole `key:value` when
it doesn't know that id) — the app parses whatever's present.

## How the poster selection works

1. Main provider (default TMDB), your `PRIMARY_LANGUAGE` - ranks candidates
   with a **Wilson score lower bound** (the standard technique for "don't
   let a couple of lucky votes outrank an item with lots of votes at a
   slightly lower average" - the same idea behind Reddit/HN comment
   ranking). A poster's score reflects how confident we can be in its
   rating given its sample size, not just the raw average, so a 6-vote 8.0
   properly loses to a 37-vote 5.8. Candidates within
   `VOTE_AVERAGE_TIE_THRESHOLD` of the top score are treated as tied, and
   the tie is broken by raw `vote_count`. Posters with zero votes are only
   picked if literally nothing else has any vote data.
2. If nothing in that language: backup provider (default TVDB), same
   language, best-scored result (TVDB artworks are explicitly sorted by
   `score` first, since the API doesn't return them in gallery order).
3. If still nothing: main provider, title's *original* language, same
   Wilson-score ranking.
4. If still nothing: backup provider, original language, best-scored
   result.

## Poster generation is cached server-side

The first request for a title runs the full pipeline (provider lookup,
image download, rating lookup, info bar rendering) and caches the
finished bytes in SQLite.
Every request after that - including every future app launch - is an
instant cache read, not a fresh pipeline run. Cached posters are
considered fresh for `POSTER_CACHE_REFRESH_DAYS` (default 30); once
stale, the cached image is still served immediately while a fresh one
regenerates in the background, so a request is never blocked waiting on
regeneration.

## Poster styling

Posters are resized to `POSTER_OUTPUT_WIDTH` x `POSTER_OUTPUT_HEIGHT`
(default 580x859, matching Stremio's own ~0.675 poster aspect ratio)
before any styling is applied - this keeps generation fast, file sizes
small, and guarantees the output is exactly the shape the client expects.

Styling is a dark, semi-opaque bar across the bottom showing the title's
primary genre and/or a single aggregated rating (year is available too,
off by default), plus a thin rating-progress strip directly above it
(filled left-to-right proportional to rating/100). Sizing, font weight,
and vertical centering were tuned by directly measuring a reference
app's screenshot rather than guessed - bar height is 7.2% of poster
height, and text uses Roboto at a manually-computed baseline offset
(SVG's `dominant-baseline="central"` isn't reliably supported by the
librsvg renderer sharp uses under the hood, so centering is done with a
plain baseline + a tuned offset instead). Controlled by
`POSTER_INFO_BAR_*` - see `.env.example` for every option (bar
height/opacity/colors, progress bar colors, etc).

The rating is a single weighted-average score (0-100 scale) pulled from
[MDBList](https://mdblist.com) (needs a free `MDBLIST_API_KEY`), which
aggregates per-source ratings (IMDb, TMDb, Trakt, Letterboxd, Metacritic,
Rotten Tomatoes, etc.) and normalizes each to 0-100 so they're directly
comparable. You configure how much weight each source gets via
`RATING_SOURCE_WEIGHTS` (e.g. `imdb:50,tmdb:30,trakt:20` - weights are
relative to each other, not required to sum to 100). If a source has no
data for a given title, its weight is dropped and the rest are
renormalized proportionally - e.g. `letterboxd:99,trakt:1` becomes 100%
trakt if letterboxd is missing for that title, rather than silently
under-weighting the result. Genre and year come from TMDB.

## How the backdrop pool works

- On first request for a title, the app fetches up to `BACKDROP_FETCH_LIMIT`
  textless backdrops per provider, drops any with resolution below
  `BACKDROP_MIN_RELATIVE_WIDTH` of the batch's best (and below
  `BACKDROP_MIN_ABSOLUTE_WIDTH` regardless), and seeds a pool - serving one
  back **immediately**. In `main-backup` mode, `BACKDROP_POOL_TARGET_SIZE`
  is one overall target and the backup provider is only consulted if the
  main provider falls short. In `both` mode, the target applies **per
  provider** (e.g. 6 = up to 6 from TMDB *and* up to 6 from TVDB).
- In the background, it computes two independent similarity signals for
  every pooled backdrop - a perceptual hash (`sharp-phash`, DCT-based,
  catches recompressed/recolored/slightly-cropped repeats) and a small
  spatial color signature (catches cases where two *different* shots
  happen to share strong edges/composition that could fool pHash alone).
  A pair only counts as a duplicate if **both** signals agree, which cuts
  down on false-positive removals. Duplicates are resolved by keeping the
  highest-resolution copy.
- Backfilling after dedup: in `both` mode, both providers seed the pool
  with up to `BACKDROP_POOL_TARGET_SIZE` each, but when candidates are
  lost to dedup, refilling always checks the MAIN provider's remaining
  ranked results first - regardless of which provider's candidate was
  actually removed - and only reaches into the backup provider if main
  is genuinely exhausted. Going deep into either provider's results
  risks lower-quality images the further down you go, so this leans on
  the trusted main provider before ever resorting to backup. In
  `main-backup` mode, backup is brought in per the configured trigger
  (`BACKDROP_MIN_UNIQUE_BEFORE_BACKUP`).
- Known-duplicate pairs and computed signatures are cached in SQLite
  forever, so re-fetching a provider's response later never re-hashes or
  re-diffs images it has already judged.
- A request picks a random pool member and sticks with it for
  `BACKDROP_TTL_SECONDS`, then rotates. If the background sweep hasn't
  finished by the time the TTL rotates, you just get whatever the pool
  looks like *right now* (already-removed duplicates gone, already-found
  replacements included) - never blocked waiting on it.
- Responses are sent with `Cache-Control: no-store` so clients always come
  back to you to check whether the TTL has rotated, instead of caching a
  stale pick.

## Local development

```bash
cp .env.example .env   # fill in TMDB_API_KEY / TVDB_API_KEY at minimum
npm install
npm run dev
```

## Deploying via Docker (pulling the pre-built image from GHCR)

You don't need Node or npm on your server at all — GitHub builds the image
for you, your server just pulls it.

### 1. Create the GitHub repository

1. Go to https://github.com/new
2. Repository name: `stremio-artwork` (or whatever you like)
3. Visibility: your choice (public or private both work with GHCR)
4. **Do not** initialize with a README/gitignore (we already have them) —
   or it doesn't matter, you can overwrite them
5. Click **Create repository**

### 2. Upload the project files

The easiest way from the GitHub website, no git CLI needed:

1. On your new repo's page, click **"uploading an existing file"** (shown on
   the empty-repo page), or **Add file → Upload files** from the toolbar.
2. On your computer, open the project folder you downloaded from this chat.
3. Select **all files and folders** inside it (including the hidden
   `.github` folder — make sure your file browser is set to show hidden
   files, e.g. `Cmd+Shift+.` on macOS Finder, or "Show hidden items" in
   Windows Explorer) and drag them into the GitHub upload area. GitHub's
   drag-and-drop upload preserves folder structure, so `.github/workflows/…`
   and `src/…` will land in the right place.
4. Scroll down, add a commit message like "Initial commit", and click
   **Commit changes** (commit directly to `main`).

   > If `.github` doesn't show up in the upload because your OS is hiding
   > it, you can instead click **Add file → Create new file**, type
   > `.github/workflows/docker-publish.yml` as the filename (GitHub
   > auto-creates the folders), paste in the workflow content, and commit.

### 3. Let GitHub Actions build and publish the image

1. Go to the **Actions** tab of your repo. Since the workflow file is
   already committed, it should already be listed as
   **"Build and publish Docker image"**.
2. If it didn't trigger automatically from the commit, click into it and use
   **Run workflow** to trigger it manually on `main`.
3. Wait for the run to go green (a couple minutes — it builds both
   `linux/amd64` and `linux/arm64`).
4. Once it succeeds, go to your repo's **main page → right sidebar →
   Packages**. You should see a new package named after your repo — that's
   your image at `ghcr.io/<your-username>/<repo-name>:latest`.

### 4. Make the package pullable from your server

By default, a new GHCR package inherits your repo's visibility. Easiest
path: make the package **public** so `docker compose pull` on your server
needs no login.

1. Click into the package (Packages tab, or the sidebar link from step 3).
2. Go to **Package settings** (bottom of the right sidebar on the package
   page).
3. Under **Danger Zone**, click **Change visibility → Public**, confirm.

If you'd rather keep it private, you'll instead need to `docker login
ghcr.io` on your server with a
[Personal Access Token](https://github.com/settings/tokens) that has
`read:packages` scope, before running `docker compose pull`.

### 5. Deploy on your Docker server

On your Linux server, in a new folder:

```bash
mkdir -p ~/stremio-artwork && cd ~/stremio-artwork
```

Create `docker-compose.yml` (copy from the repo, or from below) and edit the
`image:` line to match your GitHub username/repo:

```yaml
services:
  stremio-artwork:
    image: ghcr.io/YOUR_USERNAME/stremio-artwork:latest
    container_name: stremio-artwork
    restart: unless-stopped
    ports:
      - "7777:7777"
    env_file:
      - .env
    volumes:
      - artwork-data:/data

volumes:
  artwork-data:
```

Create your `.env` (copy `.env.example` from the repo and fill in your real
`TMDB_API_KEY` / `TVDB_API_KEY`, and adjust any of the tuning knobs).

Then:

```bash
docker compose pull
docker compose up -d
docker compose logs -f
```

Point AIOMetadata's poster/backdrop URL fields at
`http://your-server:7777/poster/...` and `http://your-server:7777/backdrop/...`
(or wherever you're reverse-proxying this from, e.g. behind Caddy/nginx/
Traefik with a real domain and HTTPS — recommended since Stremio clients will
hit these URLs constantly).

### 6. Updating later

Whenever you push new commits to `main` (e.g. editing files again via the
GitHub web UI), the Actions workflow rebuilds and republishes `:latest`
automatically. On your server, just:

```bash
docker compose pull && docker compose up -d
```

## Getting API keys

- **TMDB**: create a free account at https://www.themoviedb.org, then
  generate a "v3 auth" API key at
  https://www.themoviedb.org/settings/api — use that as `TMDB_API_KEY`.
- **TVDB**: create an account at https://thetvdb.com, then generate a
  "Project" API key at https://www.thetvdb.com/dashboard/account/apikeys —
  use that as `TVDB_API_KEY`. A subscriber PIN (`TVDB_PIN`) is only needed if
  you're on a legacy TVDB subscription tier.
- **MDBList** (optional, powers the info bar's rating): create a free
  account at https://mdblist.com, then find your API key at
  https://mdblist.com/preferences under "API Access" — use that as
  `MDBLIST_API_KEY`. Leave it blank if you don't want the rating (genre
  still works without it).

## Notes / things worth double-checking

- TVDB's v4 artwork "type" ids differ per record type (movie vs series) and
  are resolved dynamically via `/artwork/types` rather than hardcoded, but
  it's worth spot-checking a real response against
  [TVDB's v4 API docs](https://thetvdb.github.io/v4-api/) if backdrops/posters
  from TVDB ever look wrong — their schema has shifted before.
- Text rendering (genre/rating in the info bar) depends on the Roboto font
  being installed and discoverable by fontconfig - the Dockerfile handles
  this, but if you're running outside Docker, make sure `fonts-roboto` (or
  an equivalent) is installed, or text will silently fall back to whatever
  system font is available and may not match the intended look.
- Posters are cached aggressively (`POSTER_CACHE_SECONDS`, default 7 days)
  since the source rarely changes; backdrops are deliberately never cached so
  the TTL rotation actually works client-side.
