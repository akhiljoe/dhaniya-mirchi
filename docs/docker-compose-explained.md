# What `docker compose up -d --build` does

One command starts the whole site on your machine: database, backend, headless
browser worker, and web server. This page walks through what happens, in order,
and why each piece exists. The same file (`docker-compose.yml`) runs in
production, so what you see locally is what the VM will run.

## The flags

| Part | Meaning |
|---|---|
| `docker compose` | Read `docker-compose.yml` in this folder and manage the services it lists as one project (named `dhaniya`, so containers are `dhaniya-api-1`, etc.). |
| `up` | Create and start every service. Containers already running with the same image and settings are left alone. |
| `--build` | Rebuild the images from source first. Without it, Docker reuses the last image and you run old code. Needed after any change in `server/` or `src/`. |
| `-d` | Detached: start everything in the background and give the terminal back. Logs are still kept (`docker compose logs -f`). |

## Step 1: read `.env` and fill in the compose file

Compose reads `.env` from the repo root and substitutes `${VARIABLE}` values into
`docker-compose.yml`. It does **not** pass `.env` to the containers as a whole:
each service lists the exact variables it receives. A variable that sits in
`.env` but is not forwarded in `docker-compose.yml` never reaches the code.

Some values are required. `POSTGRES_PASSWORD` uses `${...:?message}`, so Compose
stops right here with "set POSTGRES_PASSWORD in .env" if it is missing.

## Step 2: build three images

There are three images, built from two Dockerfiles. The build context is the
whole repo, minus everything in `.dockerignore` (`.env`, `spike/`, `docs/`,
`.git/`, `node_modules/`). This keeps real order data, vendor sessions and
secrets out of every image.

### Server images (`server/Dockerfile`): api and worker

One codebase, built in stages:

1. **deps**: `npm ci` installs the server's packages from `server/package-lock.json`.
2. **build**: copies `server/src` and compiles TypeScript to `dist/`.
3. **runtime**: a clean Node 22 image with only production packages, the
   compiled `dist/`, and the SQL migrations in `server/db/`.
4. Two final targets branch off `runtime`:
   - **api**: runs `node dist/api/main.js`.
   - **worker**: also installs Debian's Chromium and fonts (this is the slow,
     large step the first time), then runs `node dist/worker/main.js`.

The `migrate` service uses the api image, so it is built once and reused.

Docker caches each step. If only `server/src` changed, the `npm ci` step is
reused and the build takes seconds. If `package-lock.json` changed, packages
are reinstalled.

### Web image (`web/Dockerfile`)

1. **build**: installs the frontend's packages and runs `vite build`, turning
   the React app in `src/` into plain HTML, JS and CSS in `dist/`.
2. **final**: an nginx image holding those files and `web/nginx.conf`. Node is
   not in the final image; it was only needed to build.

## Step 3: start the services, in dependency order

Compose starts services in the order their `depends_on` rules allow. Each one
waits for the one before to be healthy or finished.

```
postgres ──healthy──▶ migrate ──exits 0──▶ api ──healthy──▶ web
                                    └──────▶ worker
```

### 1. `postgres`: the database

- Official `postgres:16-alpine` image.
- Data lives in the Docker volume `pgdata`, so it survives restarts and
  rebuilds. Only `docker compose down -v` deletes it.
- Reachable from your machine at `127.0.0.1:5435` (for `psql` and the
  integration tests). Loopback only.
- Health check: `pg_isready` every 2 seconds. Nothing else starts until it
  passes.

### 2. `migrate`: update the database schema, then exit

- Runs `node dist/migrate.js` once.
- Takes a lock (so two runs can't collide), creates a `schema_migrations`
  table if needed, and applies each file in `server/db/migrations/` that has
  not been applied yet, in filename order (`001_...` to `010_...`), each in
  its own transaction. A failed file is rolled back and stops everything.
- Exits with code 0. That exit is the signal for the api and worker to start.
- In `docker compose ps -a` it shows as "Exited (0)". That is correct, not a
  crash.

### 3. `api`: the backend

- Node server on port 8080 **inside** the Docker network only. It publishes no
  port; the browser reaches it through `web`.
- Handles Google sign-in (`/auth/start`, `/auth/callback` with Cognito) and
  every `/api/...` route the app calls.
- Holds only the vault **public** key: it can encrypt what you type (phone,
  OTP) but cannot decrypt stored grocery sessions.
- Health check: calls its own `/api/health` every 5 seconds.

### 4. `worker`: the headless browser

- Starts after `migrate`, alongside the api.
- On start it launches Chromium once to prove it works, logs `worker ready`
  with the Chrome version, then writes a heartbeat to the database every 30
  seconds (the api uses it to tell whether the worker is alive).
- If the vault keys are set, it runs two job loops:
  - **connect loop**: logs in to a grocery app with the phone and OTP you typed.
  - **import loop**: reads your order history in the background and sends the
    "your history is in" push notice.
- The api and worker never call each other. The api writes a job row and sends
  a Postgres `NOTIFY`; the worker, listening, wakes up and claims it. A timer
  sweep also picks up anything missed while the worker was down.
- Holds the vault **private** keys and the push signing key. It is the only
  service that can open a stored session.
- Memory capped at 1 GB (`WORKER_MEM_LIMIT`), so a runaway browser can't take
  the rest of the site down.

### 5. `web`: nginx, the only thing a browser talks to

- Waits for the api to be healthy.
- Published at `127.0.0.1:8100` (or `0.0.0.0:8100` if `WEB_BIND=0.0.0.0`, for a
  phone on the home Wi-Fi).
- Serves the built React app. Any unknown path returns `index.html`, so page
  links like `/inventory` work on refresh.
- Proxies `/api/` and `/auth/` to the api. Without this, sign-in would silently
  get the app's HTML back.
- Adds security headers (Content-Security-Policy and others) and caching
  rules: hashed bundles in `/assets/` are cached for a year; `index.html` is
  never cached, so a rebuild shows up right away.

## Step 4: stay running

Every service except `migrate` has `restart: unless-stopped`: if it crashes, or
Docker Desktop restarts, it comes back on its own. It stays stopped only if you
stop it yourself.

## What each port means

| Address | What | Who can reach it |
|---|---|---|
| `http://localhost:8100` | the site (web) | this machine; the home network only with `WEB_BIND=0.0.0.0` |
| `127.0.0.1:5435` | Postgres | this machine only |
| `api:8080` | the api | other containers only |

Every host port binds to `127.0.0.1` on purpose. Docker's firewall rules bypass
`ufw`, so a plain `"8100:80"` would be public on the VM even with the firewall
closed. The Cloudflare tunnel (`npm run tunnel`) connects to `localhost:8100`
from the outside in, so no port needs to be open.

## Running it again

When you run the command again:

- Images are rebuilt, using the cache for unchanged steps.
- Only containers whose image or settings changed are recreated. Unchanged ones
  keep running.
- `migrate` runs again and applies only new migration files. With none, it
  exits straight away.
- Database data is kept.

Rebuild after changing `server/`: the api and worker share one codebase, and
restarting one without rebuilding runs old code against a newer database.

## Useful commands

```sh
docker compose ps -a                 # what is running (migrate shows Exited (0))
docker compose logs -f api worker    # follow logs from the api and worker
docker compose logs migrate          # which migrations were applied
docker compose restart web           # restart one service, no rebuild
docker compose up -d --build api worker   # rebuild just the server services
docker compose stop                  # stop everything, keep containers and data
docker compose down                  # remove containers, keep the database
docker compose down -v               # remove containers AND the database volume
docker compose run --rm worker node dist/worker/main.js probe   # can this machine's IP load the vendor sites?
```
