// GuiltFree Plaid backend — single-user proxy that holds the Plaid secret (which can never live in
// the app) and exposes exactly the three endpoints FinanceApp/Plaid/PlaidService.swift calls.
//
// Env vars (set these in your host's dashboard):
//   PLAID_CLIENT_ID     — from dashboard.plaid.com
//   PLAID_SECRET        — the *production* secret
//   PLAID_ENV           — "production" (or "sandbox" to test)
//   PLAID_REDIRECT_URI  — optional; required for OAuth banks (see README)
//   PLAID_ACCESS_TOKEN  — optional; pin the linked item so it survives restarts (see README)
//
// It persists { access_token, item_id, cursor } to a JSON file so re-syncs are incremental.

import express from "express";
import fs from "fs";
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

const STORE = process.env.STORE_PATH || "/tmp/guiltfree-plaid.json";
const load = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; } };
const save = (s) => { try { fs.writeFileSync(STORE, JSON.stringify(s)); } catch (e) { console.warn("save failed", e.message); } };
const accessToken = () => process.env.PLAID_ACCESS_TOKEN || load().access_token;

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

// 2) Swap the public_token from Link for a stored access_token; return the linked accounts.
app.post("/item/public_token/exchange", async (req, res) => {
  try {
    const ex = await plaid.itemPublicTokenExchange({ public_token: req.body.public_token });
    save({ ...load(), access_token: ex.data.access_token, item_id: ex.data.item_id, cursor: null });
    const acc = await plaid.accountsGet({ access_token: ex.data.access_token });
    res.json({
      item_id: ex.data.item_id,
      accounts: acc.data.accounts.map((a) => ({
        account_id: a.account_id, name: a.name, mask: a.mask,
        type: a.type, subtype: a.subtype,
      })),
    });
  } catch (e) { fail(res, e); }
});

// 3) Incremental transaction pull (cursor-based).
app.post("/transactions/sync", async (req, res) => {
  try {
    const token = accessToken();
    if (!token) return res.status(400).json({ error: "No bank linked yet — connect one first." });
    const cursor = req.body.cursor ?? load().cursor ?? undefined;
    const r = await plaid.transactionsSync({
      access_token: token, cursor,
      options: { include_personal_finance_category: true },
    });
    save({ ...load(), cursor: r.data.next_cursor });
    res.json({
      added: r.data.added,
      modified: r.data.modified,
      removed: r.data.removed.map((x) => x.transaction_id),
      next_cursor: r.data.next_cursor,
      has_more: r.data.has_more,
    });
  } catch (e) { fail(res, e); }
});

app.get("/", (_req, res) => res.send("GuiltFree Plaid backend is running."));
app.listen(process.env.PORT || 3000, () => console.log("GuiltFree Plaid backend listening"));
