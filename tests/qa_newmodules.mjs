// QA-authored live HTTP validation for WhatsApp (stub) + Payment Gateway (stub)
// + BUG-004 (malformed UUID → 422 no leak) regression. Backend must be UP on 4100 + freshly seeded.
// Run: node tests/qa_newmodules.mjs   (exits non-zero on any failure)
const BASE = "http://localhost:4100/api/v1";
let pass = 0, fail = 0;
function ok(c, msg, extra = "") { (c ? (pass++, console.log("PASS ", msg, extra)) : (fail++, console.log("FAIL ", msg, extra))); }

async function req(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return { res, text: await res.text() };
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { res, json };
}
async function login(email) {
  const { json } = await req("POST", "/auth/login", { body: { email, password: "Password123!" } });
  return json?.data?.accessToken;
}

(async () => {
  const owner = await login("owner@demo.kos");
  const manager = await login("manager@demo.kos");
  const admin = await login("admin@demo.kos");
  const finance = await login("finance@demo.kos");
  ok(owner && manager && admin && finance, "logged in all 4 demo roles");

  // resolve the seeded property + unpaid invoice
  const props = (await req("GET", "/properties", { token: owner })).json?.data ?? [];
  const propId = props[0]?.id;
  const invs = (await req("GET", "/invoices?status=unpaid", { token: owner })).json?.data ?? [];
  const invId = invs[0]?.id;
  ok(propId && invId, "resolved property + unpaid invoice", `prop=${propId?.slice(0,8)} inv=${invId?.slice(0,8)}`);

  // ===================== WHATSAPP (STUB) =====================
  console.log("\n--- WhatsApp (stub) ---");
  // status: provider stub + quota
  {
    const { json } = await req("GET", "/wa/status", { token: owner });
    const d = json?.data ?? {};
    ok(d.provider === "stub", "wa/status provider=stub", `provider=${d.provider} configured=${d.configured}`);
    ok(d.quota && typeof d.quota.remaining === "number", "wa/status returns quota", `used=${d.quota?.used} limit=${d.quota?.limit} remaining=${d.quota?.remaining}`);
  }
  // templates list + render substitution
  let quotaBefore;
  {
    const tpls = (await req("GET", "/wa/templates", { token: owner })).json?.data ?? [];
    ok(tpls.length >= 6, "wa/templates list (>=6 defaults)", `count=${tpls.length}`);
    quotaBefore = (await req("GET", "/wa/status", { token: owner })).json?.data?.quota?.remaining;
  }
  // send-wa creates a stub log + decrements quota (Admin+)
  {
    const { res, json } = await req("POST", `/invoices/${invId}/send-wa`, { token: admin, body: {} });
    const m = json?.data;
    ok(res.status === 200 || res.status === 201, "send-wa as admin -> success", `status=${res.status}`);
    ok(m?.status === "stub", "send-wa records status=stub", `msgStatus=${m?.status}`);
    ok(typeof m?.body === "string" && /Budi/i.test(m?.body || ""), "send-wa rendered body substitutes vars", `body="${(m?.body||"").slice(0,40)}..."`);
    const quotaAfter = (await req("GET", "/wa/status", { token: owner })).json?.data?.quota?.remaining;
    ok(quotaAfter === quotaBefore - 1, "send-wa decrements quota by 1", `before=${quotaBefore} after=${quotaAfter}`);
  }
  // send-wa RBAC: finance -> 403
  {
    const { res } = await req("POST", `/invoices/${invId}/send-wa`, { token: finance, body: {} });
    ok(res.status === 403, "send-wa as finance -> 403 (Admin+)", `status=${res.status}`);
  }
  // broadcast hits N residents (Manager+); admin -> 403
  {
    const bbody = { propertyId: propId, body: "Halo {nama_penyewa}, info dari {nama_kos}." };
    const { res, json } = await req("POST", "/wa/broadcast", { token: manager, body: bbody });
    ok(res.status === 200 || res.status === 201, "broadcast as manager -> success", `status=${res.status} sent=${json?.data?.sent} recipients=${json?.data?.recipients}`);
    const { res: r2 } = await req("POST", "/wa/broadcast", { token: admin, body: bbody });
    ok(r2.status === 403, "broadcast as admin -> 403 (Manager+)", `status=${r2.status}`);
  }
  // template create RBAC: finance -> 403, manager allowed
  {
    const { res } = await req("POST", "/wa/templates", { token: finance, body: { type: "custom", name: "qa", body: "hi {nama_penyewa}" } });
    ok(res.status === 403, "template create as finance -> 403 (Manager+)", `status=${res.status}`);
  }
  // reminder config GET/PUT
  {
    const g = await req("GET", `/properties/${propId}/reminder-config`, { token: owner });
    ok(g.res.status === 200 && g.json?.data, "reminder-config GET -> 200", `enabled=${g.json?.data?.enabled}`);
    const p = await req("PUT", `/properties/${propId}/reminder-config`, { token: owner, body: { enabled: true } });
    ok(p.res.status === 200, "reminder-config PUT as owner -> 200", `status=${p.res.status}`);
    const padmin = await req("PUT", `/properties/${propId}/reminder-config`, { token: admin, body: { enabled: true } });
    ok(padmin.res.status === 403, "reminder-config PUT as admin -> 403 (Manager+)", `status=${padmin.res.status}`);
  }
  // quota-exceeded -> 403 on a Basic tenant (register + exhaust would be heavy; assert quota gate code path via Basic register)
  {
    const ts = Date.now();
    const reg = await req("POST", "/auth/register", { body: { businessName: "QA WA Basic " + ts, fullName: "QA", email: `qa-wa-${ts}@x.test`, password: "Password123!" } });
    const btok = reg.json?.data?.accessToken;
    const st = (await req("GET", "/wa/status", { token: btok })).json?.data;
    ok(st?.quota?.limit === 100, "Basic tenant wa quota limit = 100", `limit=${st?.quota?.limit}`);
  }

  // ===================== PAYMENT GATEWAY (STUB) =====================
  console.log("\n--- Payment Gateway (stub) ---");
  // methods plan-correct (Pro = qris + va)
  {
    const { res, json } = await req("GET", "/payments/methods", { token: owner });
    const d = json?.data ?? {};
    const methods = d.methods ?? d.paymentMethods ?? [];
    ok(res.status === 200, "payments/methods -> 200", `provider=${d.provider} configured=${d.providerConfigured}`);
    ok(methods.includes("qris") && methods.some(m => m.startsWith("va")), "Pro methods include qris + va_*", `methods=${JSON.stringify(methods)}`);
    ok(!methods.some(m => ["gopay", "ovo", "dana", "shopeepay", "linkaja"].includes(m)), "Pro methods exclude e-wallets (Premium-only)", `methods=${JSON.stringify(methods)}`);
    ok(d.provider === "stub", "payment provider = stub", `provider=${d.provider}`);
  }
  // charge RBAC: finance -> 403
  {
    const { res } = await req("POST", `/invoices/${invId}/charge`, { token: finance, body: { method: "va_bca" } });
    ok(res.status === 403, "charge as finance -> 403 (Admin+)", `status=${res.status}`);
  }
  // method-not-in-plan -> 403 (pro asking gopay)
  {
    const { res, json } = await req("POST", `/invoices/${invId}/charge`, { token: admin, body: { method: "gopay" } });
    ok(res.status === 403 && json?.code === "PLAN_LIMIT_EXCEEDED", "charge gopay (Pro) -> 403 PLAN_LIMIT_EXCEEDED", `status=${res.status} code=${json?.code}`);
  }
  // charge va_bca -> pending txn + instructions
  let providerRef, chargeAmount;
  {
    const { res, json } = await req("POST", `/invoices/${invId}/charge`, { token: admin, body: { method: "va_bca" } });
    const t = json?.data ?? {};
    ok(res.status === 200 || res.status === 201, "charge va_bca as admin -> success", `status=${res.status}`);
    ok(t.status === "pending", "charge -> pending txn", `txnStatus=${t.status}`);
    const instr = t.instructions ?? {};
    ok(instr.vaNumber || instr.va_number, "charge returns VA instructions", `vaNumber=${instr.vaNumber || instr.va_number} bank=${instr.bank}`);
    providerRef = t.providerRef || t.provider_ref;
    chargeAmount = t.amount;
    ok(!!providerRef, "charge returns providerRef", `ref=${providerRef}`);
  }
  // public webhook -> records Payment + invoice paid + txn paid
  {
    const { res, json } = await req("POST", "/webhooks/payment", { body: { providerRef, status: "paid", amount: chargeAmount } });
    ok(res.status === 200, "public webhook (no auth) -> 200", `status=${res.status} handled=${json?.data?.handled ?? json?.handled}`);
    const inv = (await req("GET", `/invoices/${invId}`, { token: owner })).json?.data;
    ok(inv?.status === "paid", "webhook flips invoice -> paid", `invStatus=${inv?.status} paid=${inv?.paidAmount}`);
    ok((inv?.payments?.length ?? 0) === 1, "webhook records exactly 1 Payment", `payments=${inv?.payments?.length}`);
  }
  // idempotent replay -> no double payment
  {
    const { res, json } = await req("POST", "/webhooks/payment", { body: { providerRef, status: "paid", amount: chargeAmount } });
    const handled = json?.data?.handled ?? json?.handled;
    const idem = json?.data?.idempotent ?? json?.idempotent;
    ok(res.status === 200 && handled === false, "webhook replay -> handled:false (idempotent)", `handled=${handled} idempotent=${idem}`);
    const inv = (await req("GET", `/invoices/${invId}`, { token: owner })).json?.data;
    ok((inv?.payments?.length ?? 0) === 1, "webhook replay does NOT double-pay (still 1 payment)", `payments=${inv?.payments?.length} paid=${inv?.paidAmount}`);
  }
  // reconciliation matches; admin excluded
  {
    const now = new Date();
    const q = `?month=${now.getUTCMonth() + 1}&year=${now.getUTCFullYear()}`;
    const { res, json } = await req("GET", `/payments/reconciliation${q}`, { token: owner });
    const d = json?.data ?? {};
    ok(res.status === 200, "reconciliation as owner -> 200", `paidTxn=${d.paidTxn ?? d.matched} unmatched=${d.unmatched} reconciled=${d.reconciled}`);
    const { res: ra } = await req("GET", `/payments/reconciliation${q}`, { token: admin });
    ok(ra.status === 403, "reconciliation as admin -> 403 (excludes admin)", `status=${ra.status}`);
  }
  // ===================== BUG-004 REGRESSION =====================
  console.log("\n--- BUG-004 malformed UUID regression ---");
  for (const path of ["/properties/not-a-uuid", "/invoices/not-a-uuid", "/bookings/not-a-uuid", "/payment-txns/not-a-uuid/simulate"]) {
    const method = path.endsWith("simulate") ? "POST" : "GET";
    const { res, text } = await req(method, path, { token: owner, raw: true, body: method === "POST" ? { outcome: "paid" } : undefined });
    const leak = /prisma\.|\.service\.ts|"detail"/.test(text);
    ok(res.status === 422, `malformed UUID ${method} ${path} -> 422`, `status=${res.status}`);
    ok(!leak, `malformed UUID ${path} -> no Prisma/source leak`, leak ? "LEAK!" : "clean");
  }
  // valid-but-missing UUID -> 404
  {
    const { res } = await req("GET", "/properties/00000000-0000-4000-8000-000000000000", { token: owner });
    ok(res.status === 404, "valid-but-missing UUID -> 404 (not 422/500)", `status=${res.status}`);
  }

  console.log(`\n==== NEWMODULES RESULT: ${pass} pass / ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR", e); process.exit(2); });
