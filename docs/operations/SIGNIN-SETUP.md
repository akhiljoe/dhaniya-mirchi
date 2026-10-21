# Sign-in: how it is wired, how to check it, what goes wrong

Sign-in is Google, through the shared Cognito user pool, run server-side by
the `api` (design §14.3). This file is the setup, the commands that prove it
works, and the failures already paid for. Modelled on an earlier project's
`docs/operations/SIGNIN-SETUP.md`, which is the reference for anything not here.

**Everything marked verified was checked on 2026-09-19** against the local stack
through the dev tunnel, https://app.dev.example.com. Re-run the checks rather
than trusting the ticks.

---

## Before sending anyone the link

Tests passing is not enough; a friend's first sign-in failed three different
ways the day the tests were green. In this order:

1. The stack and the tunnel are running: `docker compose ps` (api `healthy`) and
   `npm run tunnel`.
2. Their Google email is on `AUTH_ALLOWED_EMAILS` (below).
3. The one-command check passes (below).
4. **You** sign in on a phone, through https://app.dev.example.com, in the
   phone's browser. A desktop pass says nothing about a phone.
5. While they try, watch the log: `docker compose logs -f api | grep -i sign`.

## The one-command check

Follows our `/auth/start` through Cognito to wherever it lands:

```bash
for ORIGIN in https://app.dev.example.com http://localhost:8100; do
  AUTH=$(curl -s -o /dev/null -D - "$ORIGIN/auth/start" | grep -i '^location:' | sed 's/^[Ll]ocation: //' | tr -d '\r')
  echo "$ORIGIN -> $(curl -s -o /dev/null -D - "$AUTH" | grep -i '^location:' | cut -c1-80)"
done
```

| What comes back | What it means |
|---|---|
| `accounts.google.com/o/oauth2/...` | wired; the healthy answer |
| an `error=redirect_mismatch` page | that address's callback is not on the Cognito app client |
| `.../login?...errorMessage=Login+option+is+not+available` | Google is not ticked on the app client |
| nothing, or the page HTML | nginx is not proxying `/auth/` (it answers with the SPA and a 200) |

Verified: both addresses land on Google, with `prompt=select_account` reaching
Google (the account chooser shows every time).

## Who can sign in: `AUTH_ALLOWED_EMAILS`

The site is public while the tunnel runs, and any Google account can reach
Cognito. Only emails on this list get in.

```bash
# .env
AUTH_ALLOWED_EMAILS=owner@example.com,friend@gmail.com
```

Then `docker compose up -d` (no rebuild; it recreates the api only).

- Required when `AUTH_ENABLED=true`: without it the api refuses to start. It is
  never read as "everyone".
- Anyone else is turned away at the callback, before a user row exists, and sees
  "This Google account can't use DhaniyaMirchi yet."
- Removing an email ends that person's sessions on their next request.
- Check what the api holds: `docker compose exec -T api printenv AUTH_ALLOWED_EMAILS`.

Verified: an account not on the list was refused with that message and left no
user row.

## Configuration

Every variable is forwarded explicitly in `docker-compose.yml` (there is no
`env_file`). `.env.example` documents each one.

| Variable | Value here | Notes |
|---|---|---|
| `AUTH_ISSUER`, `AUTH_JWKS_URL` | `cognito-idp.ap-south-1.amazonaws.com/<pool>` | the **pool**; must be https |
| `AUTH_AUTHORIZE_URL`, `AUTH_TOKEN_URL` | `auth.example.com/oauth2/...` | the hosted domain, a different host |
| `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` | DhaniyaMirchi's own confidential app client | |
| `AUTH_REDIRECT_URI` | `http://localhost:8100/auth/callback,https://app.dev.example.com/auth/callback` | one per address; a sign-in returns to the one it started on |
| `AUTH_ALLOWED_EMAILS` | see above | required |
| `AUTH_IDENTITY_PROVIDER` | `Google` | empty shows Cognito's email form |
| `AUTH_SECURE_COOKIES` | `false` locally | refused in production |
| `AUTH_PROFILE_PICTURE` | `true` | needs Profile on the app client, `picture` mapped on the Google IdP (done in the shared pool) |

**Cognito app client** (AWS console, `ap-south-1`, pool `ap-south-1_2Krgq0JfS`,
App clients → DhaniyaMirchi's client → Login pages):

- Allowed callback URLs: every entry of `AUTH_REDIRECT_URI`. **Add, don't
  replace**, or localhost stops working.
- Allowed sign-out URLs: the same origins with `/` (our sign-out does not
  redirect through Cognito today, so these are for consistency).
- Identity providers: **Google** ticked.
- Scopes: openid, email, profile.

Edit it in the console. The CLI's `update-user-pool-client` wipes every field
you leave out.

## Reading a failure

The api logs the outcome of every sign-in that did not complete, never the
email or a token:

```bash
docker compose logs api --since 30m | grep -iE 'sign-in|token'
docker compose logs web --since 30m | grep /auth/callback   # one line per callback, with the browser
```

| Log | Screen | Cause |
|---|---|---|
| `outcome: not_allowed` | "can't use DhaniyaMirchi yet" | email not on `AUTH_ALLOWED_EMAILS`, or no verified email |
| `token endpoint unreachable` + `token_error` | "didn't go through" | Cognito did not answer within `TOKEN_TIMEOUT_MS` (30 s) |
| `token exchange refused` (400) + `token_error` | "didn't go through" | the code was already used or expired |
| `outcome: flow_mismatch` | "didn't go through" | the flow cookie was missing or from another tab; start again |
| `outcome: cancelled` | "was cancelled" | the user backed out at Google |
| no `/auth/callback` in the web log | Google or Cognito error page | failed before reaching us: callback URL not registered, or Google blocked the account |

If Google itself says "Access blocked", the shared Google OAuth app is in
Testing mode: add the email as a test user in Google Cloud Console (OAuth
consent screen).

## Failures already paid for (2026-09-19)

- **Cognito was slow.** A cold call from the home line took up to 10.7 s; the
  old 10 s limit failed a friend's sign-in. Now 30 s. The token call is never
  retried: the code is single-use, and a slow first attempt may have used it.
- **Android Chrome sent the callback twice** (the site was installed as an
  app). The first request signed in; the second reused the code, was refused,
  and its failure page is what the browser showed. A repeat of the same
  callback (same flow cookie and code) within 60 s now gets the first result
  (`CALLBACK_REPEAT_WINDOW_MS`).
- **The site is not installable until launch.** No manifest link in
  `index.html`. At launch: link `/manifest.webmanifest` again, restore
  `apple-mobile-web-app-capable`, and test a phone sign-in with the app
  installed (iPhone push needs the install, design §13.1).
- **A cached photo crossed accounts.** The photo is served by `/api/me/picture`
  for whoever is signed in and cached for an hour; the page now loads it as
  `?u=<user id>`.
- **A stale failure message** stayed on the sign-in screen after sign-out. It is
  cleared on sign-out.
- **Google's screen says "continue to example.com"**: the Google OAuth client
  is shared with an earlier project. Tell invited friends to expect it.
- **Signing out does not sign out of Google.** The chooser still shows every
  time (`prompt=select_account`), so picking another account works.

## Going to the real domain

1. Add `https://<domain>/auth/callback` to `AUTH_REDIRECT_URI` in the VM's
   `.env`, and to the Cognito app client (callback and sign-out URLs).
2. On the VM: `AUTH_SECURE_COOKIES=true`, `NODE_ENV=production`, and
   `AUTH_ALLOWED_EMAILS` (the api refuses to start without it).
3. Run the one-command check against the domain, then a phone sign-in.
