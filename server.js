// GuiltFree Plaid backend — single-user proxy that holds the Plaid secret (never in the app) and
// exposes the endpoints FinanceApp/Plaid/PlaidService.swift calls. Supports MULTIPLE linked banks
// and stores their tokens durably in Redis (Render Key Value) so you never have to re-link.
//
// Env vars:
//   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (=production)
//   REDIS_URL           — auto-wired by render.yaml from the Key Value service (durable token store)
//   PLAID_REDIRECT_URI  — optional; required for OAuth banks (Amex etc.)

import express from "express";
import fs from "fs";
import { createClient } from "redis";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

const app = express();
app.use(express.json());

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "production"],
  baseOptions: { headers: {
    "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
    "PLAID-SECRET": process.env.PLAID_SECRET,
  } },
}));

// ---- Durable state: { items: [ { access_token, item_id, cursor } ] } -----------------------------
const KEY = "guiltfree:state";
const FILE = process.env.STORE_PATH || "/tmp/guiltfree-plaid.json";
let redis = null;
if (process.env.REDIS_URL) {
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on("error", (e) => console.error("redis error:", e.message));
  try { await redis.connect(); console.log("Redis connected (durable token store)"); }
  catch (e) { console.error("Redis connect failed, falling back to file:", e.message); redis = null; }
}
async function loadState() {
  if (redis) { const s = await redis.get(KEY); return s ? JSON.parse(s) : { items: [] }; }
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { items: [] }; }
}
async function saveState(state) {
  if (redis) { await redis.set(KEY, JSON.stringify(state)); }
  else { try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch (e) { console.warn("save failed:", e.message); } }
}

const fail = (res, e) => {
  const detail = e?.response?.data || { error: e.message };
  console.error("plaid error:", detail);
  res.status(500).json(detail);
};

// 1) A link_token to open Plaid Link in the app.
app.post("/link/token/create", async (_req, res) => {
  try {
    const r = await plaid.linkTokenCreate({
      user: { client_user_id: "guiltfree-user" },
      client_name: "GuiltFree",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
      ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
    });
    res.json({ link_token: r.data.link_token });
  } catch (e) { fail(res, e); }
});

// 2) Exchange the public_token → append a NEW bank (never overwrites); return its accounts.
app.post("/item/public_token/exchange", async (req, res) => {
  try {
    const ex = await plaid.itemPublicTokenExchange({ public_token: req.body.public_token });
    const state = await loadState();
    if (!state.items.some((i) => i.item_id === ex.data.item_id)) {
      state.items.push({ access_token: ex.data.access_token, item_id: ex.data.item_id, cursor: null });
      await saveState(state);
    }
    const acc = await plaid.accountsGet({ access_token: ex.data.access_token });
    res.json({
      item_id: ex.data.item_id,
      accounts: acc.data.accounts.map((a) => ({
        account_id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
      })),
    });
  } catch (e) { fail(res, e); }
});

// 3) Sync EVERY linked bank (each with its own cursor), merged into one response. The app's cursor
//    is ignored — the backend owns per-bank cursors so all banks stay in sync automatically.
app.post("/transactions/sync", async (_req, res) => {
  try {
    const state = await loadState();
    if (!state.items.length) return res.status(400).json({ error: "No bank linked yet — connect one first." });
    const added = [], modified = [], removed = [];
    for (const item of state.items) {
      try {
        let cursor = item.cursor ?? undefined, more = true;
        while (more) {
          const r = await plaid.transactionsSync({
            access_token: item.access_token, cursor,
            options: { include_personal_finance_category: true },
          });
          added.push(...r.data.added);
          modified.push(...r.data.modified);
          removed.push(...r.data.removed.map((x) => x.transaction_id));
          cursor = r.data.next_cursor; item.cursor = cursor; more = r.data.has_more;
        }
      } catch (e) {
        console.error(`sync failed for item ${item.item_id}:`, e?.response?.data?.error_message || e.message);
      }
    }
    await saveState(state);
    res.json({ added, modified, removed, next_cursor: "", has_more: false });
  } catch (e) { fail(res, e); }
});

// List linked banks (item ids) — handy for a future "manage connections" screen.
app.get("/items", async (_req, res) => {
  const state = await loadState();
  res.json({ items: state.items.map((i) => i.item_id) });
});

// Unlink a bank and free its Plaid slot.
app.post("/item/remove", async (req, res) => {
  try {
    const state = await loadState();
    const item = state.items.find((i) => i.item_id === req.body.item_id);
    if (item) {
      await plaid.itemRemove({ access_token: item.access_token });
      state.items = state.items.filter((i) => i.item_id !== req.body.item_id);
      await saveState(state);
    }
    res.json({ ok: true, remaining: state.items.length });
  } catch (e) { fail(res, e); }
});

app.get("/", (_req, res) => res.send("GuiltFree Plaid backend is running."));
app.listen(process.env.PORT || 3000, () => console.log("GuiltFree Plaid backend listening"));
