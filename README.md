# GuiltFree Plaid backend

A tiny proxy that holds your Plaid secret and exposes the 3 endpoints the app calls. Your Plaid
`client_id`/`secret` live here as environment variables — **never in the app**.

## What you do (~15 min)

### 1. Get Plaid keys
- Sign up at **dashboard.plaid.com** (free).
- You chose **Production**, so request **Production access** (Team Settings ▸ "Request Production"). Plaid
  usually approves personal/production use within a day. *(If you want to test the flow today while that's
  pending, set `PLAID_ENV=sandbox` and Plaid gives you a working sandbox key instantly — fake banks.)*
- Copy your **`client_id`** and the **`secret`** for the environment you're using.

### 2. Deploy this folder (free, on Render)
- Push this repo to GitHub (the `plaid-backend/` folder + the `render.yaml`).
- Render.com ▸ **New ▸ Blueprint** ▸ pick the repo → it reads `render.yaml`.
- In the new service's **Environment** tab set:
  - `PLAID_CLIENT_ID` = your client id
  - `PLAID_SECRET` = your secret
  - `PLAID_ENV` = `production` (already defaulted)
- Deploy. You'll get a URL like `https://guiltfree-plaid.onrender.com`.
- Test it: opening that URL should say *"GuiltFree Plaid backend is running."*

*(Render's free tier sleeps when idle and its disk resets on redeploy — see "Persistence" below. Railway
or Fly.io work identically if you prefer.)*

### 3. Point the app at it
- In GuiltFree ▸ Accounts ▸ **Connect a bank**, paste the Render URL. That's it — tap Connect and Plaid Link
  opens.

## Production OAuth (important for real banks)
Most big US banks require **OAuth** in production. For that Plaid needs a **redirect URI**:
- In the Plaid dashboard ▸ **API ▸ Allowed redirect URIs**, add your app's universal link
  (e.g. `https://<your-domain>/plaid-oauth`), and set `PLAID_REDIRECT_URI` to the same value here.
- The iOS app also needs that universal link configured (Associated Domains). Tell me your domain and I'll
  wire the app side. Until then, banks that don't need OAuth will still link fine.

## Persistence
After you link a bank once, copy the `access_token` the backend stored (it's logged / in `/tmp/guiltfree-plaid.json`)
into the **`PLAID_ACCESS_TOKEN`** env var so the link survives restarts. The sync cursor is best-effort; if it
resets, the next sync just re-pulls everything (the app de-dupes).

## Endpoints (what the app calls)
- `POST /link/token/create` → `{ link_token }`
- `POST /item/public_token/exchange` `{ public_token }` → `{ item_id, accounts[] }`
- `POST /transactions/sync` `{ cursor? }` → `{ added[], modified[], removed[], next_cursor, has_more }`
