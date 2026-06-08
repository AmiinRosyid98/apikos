# KosManager API — MVP-1 Reference

Base URL: `http://localhost:4000/api/v1`
All routes are prefixed with `/api/v1`. Source contract: `PLAN.md` §3.

## Conventions

- **Auth:** `Authorization: Bearer <accessToken>`. `tenantId`, `role`, `userId` come from the JWT — never the body.
- **Content-Type:** `application/json`.
- **Pagination:** `?page=1&limit=20` (default page=1, limit=20, max 100). Sorting: `?sort_order=asc|desc`.
- **Success envelope:** `{ "success": true, "data": <object|array>, "meta"?: { page, limit, total, totalPages } }`
- **Error envelope:** `{ "success": false, "code": "ERROR_CODE", "message": "...", "errors"?: [{ field, message }] }`

### Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 422 | Zod validation failed (`errors[]` present) |
| `UNAUTHENTICATED` | 401 | Missing/invalid access token |
| `TOKEN_EXPIRED` | 401 | Access token expired → refresh |
| `FORBIDDEN` | 403 | Role/property-scope denies the action |
| `NOT_FOUND` | 404 | Absent or not in caller's tenant (existence not leaked) |
| `CONFLICT` | 409 | Unique constraint (email taken, duplicate invoice period) |
| `PLAN_LIMIT_EXCEEDED` | 403 | Subscription cap reached |
| `RATE_LIMITED` | 429 | Rate limit (100 req/min/IP on public routes) |
| `INTERNAL_ERROR` | 500 | Unhandled |

### Roles (RBAC, PLAN §5)

`Admin+` = {owner,manager,admin} · `Manager+` = {owner,manager} · `Finance+` = {owner,manager,finance} · `All` = any authenticated. Property-scoped roles (manager/admin/finance) are limited to their `user_property_access`.

---

## Auth — `/auth`

| Method | Path | Role |
|---|---|---|
| POST | `/auth/register` | Public |
| POST | `/auth/login` | Public |
| POST | `/auth/refresh` | Public (valid refresh) |
| POST | `/auth/logout` | Auth |
| POST | `/auth/forgot-password` | Public |
| POST | `/auth/reset-password` | Public |
| GET | `/auth/me` | Auth |

```http
POST /auth/register
{ "businessName": "Kos Mawar", "fullName": "Andi", "email": "andi@kos.id", "password": "Secret123", "phone": "0812..." }
→ 201 { success, data: { tenant:{id,slug,name}, user:{id,email,role:"owner"}, accessToken, refreshToken } }

POST /auth/login
{ "email": "owner@demo.kos", "password": "Password123!" }
→ 200 { success, data: { user:{id,email,fullName,role}, accessToken, refreshToken } }

POST /auth/refresh
{ "refreshToken": "<token>" }
→ 200 { success, data: { accessToken, refreshToken } }   // old refresh revoked (rotation); reuse → 401

GET /auth/me  (Bearer)
→ 200 { success, data: { id,email,fullName,role,tenantId,propertyAccess[],subscription:{plan,status,expiresAt} } }
```
Errors: 409 (email exists), 401 (bad creds), 422 (password < 8). `forgot-password` always returns `{ sent:true }`.

---

## Users / Team — `/users`

| Method | Path | Role |
|---|---|---|
| GET | `/users` | All |
| POST | `/users/invite` | Owner |
| POST | `/users/accept-invite` | Public (token) |
| GET | `/users/:id` | All |
| PATCH | `/users/:id/role` | Owner |
| PATCH | `/users/:id/property-access` | Owner |
| PATCH | `/users/:id/deactivate` | Owner |

```http
POST /users/invite   { "email":"fin@kos.id", "fullName":"Fina", "role":"finance", "propertyIds":["<uuid>"] }
→ 201 { data: { id, email, role, inviteStatus:"pending", _devToken:"<token>" } }
   // _devToken is returned only because email is console-stubbed in MVP-1 (see BACKEND_STATUS).

POST /users/accept-invite   { "token":"<token>", "password":"Secret123" }
→ 200 { data: { accessToken, refreshToken } }

PATCH /users/:id/property-access  { "propertyIds":["<uuid>", ...] }   // rewrites the pivot
PATCH /users/:id/role             { "role":"manager" }
PATCH /users/:id/deactivate       { "is_active": false }
```
`User` = `{ id, email, fullName, phone, role, isActive, propertyAccess:[{propertyId,propertyName}], lastLoginAt }`. Owner row cannot be re-roled/deactivated; enforces `max_users`.

---

## Properties — `/properties`

| Method | Path | Role |
|---|---|---|
| GET | `/properties` | All (scoped) |
| POST | `/properties` | Owner |
| GET | `/properties/:id` | All |
| PUT | `/properties/:id` | Owner, Manager |
| DELETE | `/properties/:id` | Owner (soft-deactivate) |

Filters: `?type=&city=&is_active=`.
```http
POST /properties
{ "name":"Kos Melati", "type":"campur", "address":"Jl. Mawar 1", "city":"Bandung", "province":"Jawa Barat",
  "billingDay":1, "lateFeeType":"flat", "lateFeeValue":25000, "lateFeeGraceDays":3, "electricityPriceKwh":1500 }
→ 201 Property   // enforces max_properties

GET /properties/:id
→ 200 Property & { stats:{ totalRooms, occupied, empty, occupancyRate, monthlyRevenue, outstanding } }
```
`Property` = `{ id,name,type,address,city,province,lat,lng,facilities,billingDay,lateFeeType,lateFeeValue,lateFeeGraceDays,electricityPriceKwh,isActive,createdAt }`.

---

## Rooms — `/rooms` & `/properties/:id/rooms`

| Method | Path | Role |
|---|---|---|
| GET | `/properties/:id/rooms` | All |
| POST | `/properties/:id/rooms` | Admin+ |
| POST | `/properties/:id/rooms/bulk-price` | Owner, Manager |
| GET | `/rooms/:id` | All |
| PUT | `/rooms/:id` | Admin+ |
| PATCH | `/rooms/:id/status` | Admin+ |
| POST | `/rooms/:id/clone` | Admin+ |
| POST | `/rooms/:id/photos` | Admin+ |

Filters: `?status=&room_type=`.
```http
POST /properties/:id/rooms
{ "roomNumber":"A1", "roomType":"standard", "floor":1, "areaM2":12, "basePrice":800000, "facilities":["kasur"], "notes":"" }
→ 201 Room   // enforces max_rooms

PATCH /rooms/:id/status   { "status":"maintenance" }   // empty|occupied|booking|maintenance|renovation
POST  /rooms/:id/clone    { "count":3, "roomNumberPrefix":"A" } → 201 Room[]
POST  /properties/:id/rooms/bulk-price { "filter":{"roomType":"standard"}, "adjustType":"percent", "value":10 } → { updated:n }
POST  /rooms/:id/photos   { "keys":["<r2ObjectKey>"] } → Room (photos appended)
GET   /rooms/:id          → Room & { occupancyHistory:Occupancy[] }
```
`Room` = `{ id,propertyId,roomNumber,roomType,floor,areaM2,basePrice,status,facilities,photos[],notes,createdAt }`.

---

## Meter / Utility Readings — `/rooms/:id/meter-readings` & `/meter-readings`

> **Pro+ feature** (PRD §12.2). Basic plan → **403 `FORBIDDEN`** on create. Feeds automatic
> electricity/water charges into generated invoices (PRD §6.17 / US-04).

| Method | Path | Role |
|---|---|---|
| GET | `/rooms/:id/meter-readings` | All |
| POST | `/rooms/:id/meter-readings` | Admin+ |
| PATCH | `/meter-readings/:id` | Admin+ |
| DELETE | `/meter-readings/:id` | Manager+ |

Filters (GET): `?type=electricity|water&period_month=&period_year=&page=&limit=&sort_order=`.

```http
POST /rooms/:id/meter-readings
{ "type":"electricity", "currentReading":175, "periodMonth":6, "periodYear":2026,
  "pricePerUnit":1500?, "photoKey":"<r2ObjectKey>", "notes":""? }
→ 201 MeterReading
   // type defaults to "electricity".
   // previousReading is AUTO-DERIVED from the most recent prior reading for this room+type (0 if first).
   // usage = currentReading − previousReading ; amount = usage × pricePerUnit.
   // pricePerUnit: omit for electricity → defaults to property.electricityPriceKwh.
   //               REQUIRED for water (no default) → omit ⇒ 422.
   // photoKey is REQUIRED (foto meteran wajib) → missing ⇒ 422.
   // currentReading < previousReading ⇒ 422.
   // duplicate (room,type,periodMonth,periodYear) ⇒ 409 CONFLICT.

GET   /rooms/:id/meter-readings?type=electricity&period_year=2026
→ 200 MeterReading[] (paginated, photoUrl presigned)   // newest period first

PATCH /meter-readings/:id { "currentReading":180?, "pricePerUnit":1600?, "photoKey":""?, "notes":""? }
→ 200 MeterReading   // recomputes usage + amount (previousReading unchanged); at least one field required

DELETE /meter-readings/:id → 200 { id, deleted:true }
```
`MeterReading` = `{ id,propertyId,roomId,type,periodMonth,periodYear,previousReading,currentReading,usage,pricePerUnit,amount,photoKey,photoUrl?,notes,recordedByUserId,createdAt }`.
All writes audited (`meter.create` / `meter.update` / `meter.delete`).

**Invoice integration:** when `POST /invoices/generate` (or the daily cron) generates a resident's
invoice for `(periodMonth, periodYear)`, it looks up that room's meter readings for the same
period. Each reading present (`electricity` / `water`) is added as an `invoice_item` of that type
(e.g. `"Listrik: 75 KWh × Rp1500"`) and folded into `subtotal`/`totalAmount`. No reading → rent-only
(generation is **not** blocked). Idempotency is unchanged (existing invoices are skipped on re-run).

---

## Residents — `/residents`

| Method | Path | Role |
|---|---|---|
| GET | `/residents` | All (PII masked in list) |
| POST | `/residents` | Admin+ |
| GET | `/residents/:id` | All (raw NIK to Admin+/Finance) |
| PUT | `/residents/:id` | Admin+ |
| POST | `/residents/:id/move` | Manager+ |
| POST | `/residents/:id/checkout` | Manager+ |
| PATCH | `/residents/:id/status` | Manager+ |

Filters: `?status=&property_id=&room_id=&q=`.
```http
POST /residents
{ "propertyId":"<uuid>", "roomId":"<uuid>", "fullName":"Budi", "nik":"3201234567890001", "phone":"0812...",
  "email":"budi@x.id", "gender":"male", "ktpKey":"<key>", "selfieKey":"<key>",
  "emergencyContact":{ "name":"Siti", "phone":"0813...", "relation":"Ibu" },
  "checkInDate":"2026-06-01", "contractEndDate":"2027-06-01", "monthlyRent":800000 }
→ 201 Resident   // creates active Occupancy, sets room→occupied. NIK encrypted (AES-256-GCM); nikLast4 kept.

GET  /residents/:id → Resident & { nik?(decrypted), emergencyContact, documents:{ktpUrl?,selfieUrl?}(presigned), occupancyHistory[] }
POST /residents/:id/move     { "newRoomId":"<uuid>", "effectiveDate":"2026-07-01" }  // closes old occupancy, opens new
POST /residents/:id/checkout { "checkOutDate":"2026-12-31", "notes":"" }             // status→alumni, room→empty
PATCH /residents/:id/status  { "status":"blacklisted" }                              // active|alumni|blacklisted
```
List `Resident` = `{ id,propertyId,roomId,fullName,nikMasked,phone,email,occupation,gender,status,monthlyRent,checkInDate,contractEndDate,checkOutDate,internalNotes,createdAt }`.

---

## Invoices & Payments — `/invoices`

| Method | Path | Role |
|---|---|---|
| GET | `/invoices` | All |
| POST | `/invoices/generate` | Admin+ |
| POST | `/invoices/generate-run` | Owner |
| POST | `/invoices` | Admin+ |
| GET | `/invoices/:id` | All |
| PUT | `/invoices/:id` | Owner, Manager |
| POST | `/invoices/:id/payment` | All (record payment) |
| POST | `/invoices/:id/mark-paid` | Finance+ |
| PATCH | `/invoices/:id/cancel` | Owner, Manager |

Filters: `?status=&property_id=&resident_id=&period_month=&period_year=&overdue=true`.
```http
POST /invoices/generate
{ "propertyId":"<uuid>", "periodMonth":6, "periodYear":2026, "residentIds":["<uuid>"]? }
→ 201 { created:n, skipped:n, invoices:Invoice[] }
   // idempotent: unique (tenantId,residentId,periodMonth,periodYear). Pro-rata rent for mid-month check-in.
   // Adds electricity/water line items automatically when a meter reading exists for the room+period (see Meter section).

POST /invoices/generate-run   (Owner only — enqueue scheduled-style run)
{ "asOf":"2026-06-08"? }   // optional; simulates a billing day. Omit = "now"
→ 202 { jobId:"<bullmq-id>", enqueued:true }
   // Enqueues the SAME run the daily cron performs, scoped to the caller's tenant.
   // Requires the worker process (`npm run worker`) to be running. The worker does the
   // generation; poll GET /invoices to see results. Audited as `invoice.generate_run`.

POST /invoices  (manual single)
{ "residentId":"<uuid>", "periodMonth":6, "periodYear":2026, "dueDate":"2026-06-05",
  "items":[{ "type":"rent","description":"Sewa","quantity":1,"unitPrice":800000,"amount":800000 }] }
→ 201 Invoice   // 409 if period already invoiced

GET  /invoices/:id → Invoice & { items:InvoiceItem[], payments:Payment[] (proofUrl presigned) }
PUT  /invoices/:id { "items":[...], "notes":"" }   // only when unpaid/partial; recomputes totals/status
POST /invoices/:id/payment { "amount":300000, "method":"cash", "paidAt":"2026-06-06", "reference":"", "proofKey":"" }
     → 201 Payment   // recomputes status (partial/paid); 422 if amount > remaining balance
POST /invoices/:id/mark-paid { "method":"cash"?, "paidAt":"..."? } → Invoice (paid; settles balance via a payment row)
PATCH /invoices/:id/cancel  { "reason":"..." } → Invoice (cancelled; 409 if any payments)
```
`Invoice` = `{ id,invoiceNumber,propertyId,roomId,residentId,periodMonth,periodYear,dueDate,subtotal,lateFee,totalAmount,paidAmount,status,notes,createdAt }`.
`InvoiceItem` = `{ id,type,description,quantity,unitPrice,amount }`. `Payment` = `{ id,invoiceId,amount,method,paidAt,reference,proofUrl?,recordedBy }`.
Invoice number = `INV-{YEAR}-{6-digit seq}`, per-tenant via `tenant_counters`.

---

## Files — `/files`

| Method | Path | Role |
|---|---|---|
| POST | `/files/presign-upload` | All |
| POST | `/files/presign-download` | All |

```http
POST /files/presign-upload
{ "purpose":"ktp", "contentType":"image/jpeg", "fileName":"ktp.jpg", "sizeBytes":204800 }
→ 200 { uploadUrl, key, expiresIn, _note? }   // whitelist: jpeg/png/webp/pdf, max 10MB; ktp/selfie private
POST /files/presign-download { "key":"<key>" } → 200 { downloadUrl, expiresIn, _note? }  // authorizes key ∈ tenant
```
> MVP-1: R2 not configured → `uploadUrl`/`downloadUrl` are documented **placeholders** (`_note` flags STUB). Wire real R2 presigners in MVP-2.

---

## Subscription — `/subscription`

| Method | Path | Role |
|---|---|---|
| GET | `/subscription` | All |
| POST | `/subscription/change-plan` | Owner |

```http
GET /subscription
→ { plan, status, expiresAt, limits:{maxProperties,maxRooms,maxUsers}, usage:{properties,rooms,users}, features:{whatsapp,paymentGateway,reports,meterUtility} }
POST /subscription/change-plan { "plan":"pro" } → { plan, limits, status }   // MVP-1: updates caps only, no payment
```
Plan caps: basic (1/20/2), pro (5/150/10), premium (50/2000/100). `planGuard` returns 403 `PLAN_LIMIT_EXCEEDED` on create when usage ≥ cap.
Feature flags by plan: `meterUtility` & `reports` → Pro+; `whatsapp` → Pro+; `paymentGateway` → Premium only. A denied feature returns 403 `FORBIDDEN`.

---

## Dashboard — `/dashboard`

| Method | Path | Role |
|---|---|---|
| GET | `/dashboard/overview` | All (scoped) |
| GET | `/dashboard/properties/:id` | All |

```http
GET /dashboard/overview
→ { totalProperties, totalRooms, occupied, occupancyRate, monthRevenue, outstandingAmount, outstandingCount, activeResidents }
GET /dashboard/properties/:id
→ { property, occupancyRate, monthRevenue, outstanding, roomStatusBreakdown, occupancyTrend:[{month,rate}], revenueTrend:[{month,realized,target}] }
```

---

## Audit Log — `/audit-logs`

| Method | Path | Role |
|---|---|---|
| GET | `/audit-logs` | Owner (full), Manager (view) |

Filters: `?action=&entity_type=&user_id=&from=&to=` + pagination. Read-only / immutable (no create/update/delete).
`AuditLog` = `{ id,userId,userName,action,entityType,entityId,oldValue,newValue,ipAddress,userAgent,createdAt }`.

---

## Health — `/health`

`GET /health` (public) → `{ status:"ok", service, version, db:"up|down", timestamp }`.

## WhatsApp (MVP-2 — reserved)

Not implemented in MVP-1. Reserved routes (PLAN §3.11): `/wa/templates`, `/wa/broadcast`, `/wa/logs`, `/invoices/:id/send-wa`.

---

## Deposit Management — `/residents/:id/deposits` + `/deposits` (PRD §6.6)

Plan-gated: **Pro+** (`depositManagement`). Basic → 403 `FORBIDDEN`. All amounts are numbers (Rupiah). Property-scoped (cross-scope → 404). Every mutation is audited.

| Method | Path | Role |
|---|---|---|
| GET | `/residents/:id/deposits` | All |
| POST | `/residents/:id/deposits` | Admin+ (owner/manager/admin) |
| POST | `/residents/:id/deposits/:depId/refund` | Manager+ (owner/manager) |
| GET | `/deposits` | Manager+/Finance (owner/manager/finance) |

`DepositRecord` (response object):
```jsonc
{
  "id": "uuid",
  "residentId": "uuid",
  "propertyId": "uuid",
  "roomId": "uuid|null",
  "amount": 1000000,
  "method": "cash|transfer|qris|other",
  "receivedDate": "2026-01-05",          // YYYY-MM-DD
  "status": "held|partially_refunded|refunded|forfeited",
  "refundedAmount": 0,
  "refundedDate": null,                   // YYYY-MM-DD | null
  "deductionAmount": 0,
  "deductionNotes": null,
  "notes": null,
  "recordedByUserId": "uuid",
  "createdAt": "2026-06-08T..Z"
}
```

```http
GET /api/v1/residents/:id/deposits?status=held&page=1&limit=20&sort_order=desc
→ { success:true, data:[DepositRecord], meta:{page,limit,total,totalPages} }

POST /api/v1/residents/:id/deposits           # Admin+ — record receipt, status set to "held"
body: { "amount": 1000000, "method": "transfer", "receivedDate": "2026-01-05", "notes": "DP masuk" }
→ 201 { success:true, data: DepositRecord }   # status:"held", refundedAmount:0, deductionAmount:0

POST /api/v1/residents/:id/deposits/:depId/refund     # Manager+ — refund/forfeit at check-out
body: {
  "refundedAmount": 700000,
  "deductionAmount": 300000,                 # default 0; justify via the check-out berita acara
  "deductionNotes": "Pintu lemari rusak (lihat handover check-out)",
  "refundedDate": "2026-06-01"
}
→ { success:true, data: DepositRecord }
# Validation: refundedAmount + deductionAmount MUST be <= amount, else 422 VALIDATION_ERROR.
# Resulting status: refundedAmount===amount → "refunded"; refundedAmount===0 → "forfeited";
#                   otherwise → "partially_refunded".
# Re-refunding an already refunded/forfeited deposit → 409 CONFLICT.

GET /api/v1/deposits?status=held&property_id=<uuid>&page=1&limit=20    # outstanding report (Manager+/Finance)
→ {
    success:true,
    data: { "deposits": [DepositRecord], "totalAmount": 5000000, "status": "held" },
    meta:{page,limit,total,totalPages}
  }
# `status` defaults to "held" (the canonical "outstanding / not yet refunded"). totalAmount is the
# sum of `amount` across the filtered set. property_id optional; restricted users are auto-scoped.
```

---

## Check-in/Check-out Digital — `/residents/:id/handovers` + `/handovers` (PRD §6.5, berita acara)

Plan-gated: **Pro+** (`checkinOut`). Basic → 403 `FORBIDDEN`. Property-scoped. Single table for both directions (`type` enum). Mutations audited.

| Method | Path | Role |
|---|---|---|
| GET | `/residents/:id/handovers` | All |
| POST | `/residents/:id/handovers` | Admin+ for `type:"checkin"`, Manager+ for `type:"checkout"` |
| GET | `/handovers/:id` | All (returns presigned URLs) |
| GET | `/handovers/:id/pdf` | All (streams the berita acara PDF) |

`HandoverRecord` (base object):
```jsonc
{
  "id": "uuid",
  "residentId": "uuid",
  "propertyId": "uuid",
  "roomId": "uuid|null",
  "type": "checkin|checkout",
  "date": "2026-05-01",                       // YYYY-MM-DD
  "photoKeys": ["handover/room.jpg", "..."],  // file keys
  "inventory": [ { "item": "Kasur", "condition": "good|damaged|missing", "notes": "opt" } ],
  "initialMeterElectricity": 1234.5,          // checkin only; null otherwise
  "signatureKey": "handover/sign.png|null",
  "notes": "string|null",
  "recordedByUserId": "uuid",
  "createdAt": "2026-06-08T..Z"
}
```

```http
GET /api/v1/residents/:id/handovers?type=checkin&page=1&limit=20&sort_order=desc
→ { success:true, data:[HandoverRecord], meta:{...} }

POST /api/v1/residents/:id/handovers
body: {
  "type": "checkin",                          # "checkin" → Admin+, "checkout" → Manager+ (else 403)
  "date": "2026-05-01",
  "photoKeys": ["handover/room.jpg","handover/bath.jpg"],
  "inventory": [
    { "item": "Kasur", "condition": "good" },
    { "item": "Lemari", "condition": "damaged", "notes": "Engsel longgar" }
  ],
  "initialMeterElectricity": 1234.5,          # checkin only (ignored on checkout)
  "signatureKey": "handover/sign.png",
  "notes": "Serah terima awal"
}
→ 201 { success:true, data: { "handover": HandoverRecord, "meterSeeded": true|false, "meterSeedNote": "..."? } }
# meterSeeded: on a check-in with initialMeterElectricity + a photoKey + room, a baseline
#   electricity meter reading (usage 0) is seeded for the date's period. If it can't be seeded
#   cleanly (no photoKey / duplicate period), the number is still stored and meterSeedNote explains.

GET /api/v1/handovers/:id
→ { success:true, data: {
     ...HandoverRecord,
     "photos": [ { "key": "handover/room.jpg", "url": "<presigned-or-null>" } ],
     "signatureUrl": "<presigned-or-null>"
   } }
# Presigned URLs are STUB placeholders until R2 is wired (see BACKEND_STATUS files note); they are
# returned only for keys tracked as FileObject rows (null otherwise).

GET /api/v1/handovers/:id/pdf
→ 200, Content-Type: application/pdf, Content-Disposition: inline; filename="berita-acara-<type>-<id>.pdf"
# Streams the generated "Berita Acara Serah Terima" PDF (pdfkit, pure-JS): header
# (property/room/resident/date/type), inventory table (item/kondisi/catatan), photo reference
# list, signature line + key reference, notes, auto-generated footer timestamp.
```

> Check-out orchestration (frontend): checkout handover → existing `POST /residents/:id/checkout` →
> deposit refund (`POST /residents/:id/deposits/:depId/refund`). These are intentionally decoupled
> (not transactionally chained) — the frontend sequences them.

---

## Finance / Keuangan — `/api/v1/finance` (PRD §6.12)

Records expenses and derives cash flow, P&L, and reconciliation by combining the EXISTING
payments/invoices ledger. **Income is derived from the `payments` table** (actual cash received),
**not** invoice totals — except reconciliation, which compares invoiced (`invoice.totalAmount`) vs
collected (`invoice.paidAmount`). All money is `number` (Decimal serialized via the shared helper).
All routes are property-scope aware (restricted manager/admin/finance only see their
`user_property_access` properties; out-of-scope `property_id` → masked / NOT_FOUND, no existence leak).
All mutations write an immutable audit log.

### RBAC (PRD §13)
| Action | Owner | Manager | Admin | Finance |
|---|---|---|---|---|
| Catat pengeluaran (create expense) | ✅ | ✅ | ✅ | ✅ |
| Edit pengeluaran (PUT expense) | ✅ | ✅ | ✅ | ❌ |
| Hapus pengeluaran (DELETE expense) | ✅ | ✅ | ❌ (403) | ❌ (403) |
| Lihat cash flow / summary | ✅ | ✅ | ✅ | ✅ |
| Lihat P&L | ✅ | ✅ | ❌ (403) | ✅ |
| Reconciliation | ✅ | ✅ | ❌ (403) | ✅ |
| Category list | ✅ | ✅ | ✅ | ✅ |
| Category create | ✅ | ✅ | ❌ (403) | ❌ (403) |
| Category delete | ✅ | ✅ | ❌ (403) | ❌ (403) |

> **P&L is plan-gated Pro+** via the existing `reports` feature (`assertPlanFeature('reports')`):
> Basic plan → `403 FORBIDDEN`. (Cash flow / summary / reconciliation are NOT plan-gated.)

### Types
```jsonc
ExpenseCategory = { "id", "name", "isDefault": bool, "createdAt": iso }
Expense = {
  "id", "propertyId": uuid|null, "propertyName": string|null,   // null propertyId = tenant-wide overhead
  "categoryId": uuid, "categoryName": string,
  "amount": number, "date": "YYYY-MM-DD",
  "description": string|null, "vendorName": string|null, "receiptKey": string|null,
  "recordedByUserId": uuid|null, "createdAt": iso
}
```
Default categories (seeded per tenant — lazily on first category fetch, and in the seed script for
the demo tenant): **Listrik PLN, Internet, Kebersihan, Maintenance, Gaji/Upah, Lainnya**.

### Endpoints
```jsonc
// ── Expense categories ──
GET /api/v1/finance/expense-categories            (All)  ?page&limit&sort_order(asc|desc)
→ { success:true, data: ExpenseCategory[], meta:{page,limit,total,totalPages} }
// Defaults are seeded on first access. Ordered defaults-first, then by name.

POST /api/v1/finance/expense-categories           (Manager+ : owner/manager)
body: { "name": "Pajak" }                          // unique per tenant → 409 CONFLICT on dup
→ 201 { success:true, data: ExpenseCategory }

DELETE /api/v1/finance/expense-categories/:id      (owner/manager)
→ 200 { success:true, data: { "id" } }
// Blocked 422 if isDefault (defaults cannot be deleted). Blocked 409 if in use by any expense
// (reassign those expenses to another category first).

// ── Expenses ──
GET /api/v1/finance/expenses                       (All)
  ?property_id&category_id&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&page&limit&sort_order
→ { success:true, data:{ "expenses": Expense[], "totalAmount": number }, meta:{...} }

POST /api/v1/finance/expenses                      (All roles)
body: {
  "categoryId": uuid (required),
  "propertyId": uuid | null (optional; null/omitted = tenant-wide overhead),
  "amount": number > 0, "date": "YYYY-MM-DD",
  "description"?, "vendorName"?, "receiptKey"?
}
→ 201 { success:true, data: Expense }

PUT /api/v1/finance/expenses/:id                   (Admin+ : owner/manager/admin — finance 403)
body: any subset of { propertyId(null to clear), categoryId, amount, date, description, vendorName, receiptKey }
→ 200 { success:true, data: Expense }

DELETE /api/v1/finance/expenses/:id                (owner/manager only — admin/finance → 403)
→ 200 { success:true, data: { "id" } }

// ── Cash flow (All) ──
GET /api/v1/finance/cashflow?property_id&year      (default year = current)
→ { success:true, data: [ { "month":1..12, "income":number, "expense":number, "net":number }, ... ] }   // always 12 entries
// income  = SUM(payments.amount) where paidAt in that month  (actual cash received)
// expense = SUM(expenses.amount) where date in that month
// net     = income − expense

// ── Summary (All) ──
GET /api/v1/finance/summary?property_id&month&year (defaults month/year = current)
→ { success:true, data: {
     "income": number, "expense": number, "net": number,         // income from payments, net = income − expense
     "invoiced": number, "collected": number, "outstanding": number   // invoice ledger for the period
   } }
// invoiced  = SUM(invoice.totalAmount) for (month,year), excluding cancelled
// collected = SUM(invoice.paidAmount)  for (month,year)
// outstanding = invoiced − collected

// ── Profit & Loss (owner/manager/finance — admin 403; PLAN-GATED Pro+ via `reports`) ──
GET /api/v1/finance/pl?property_id&year
→ { success:true, data: {
     "revenue": number,                                          // SUM(payments) in the year — actual cash
     "expensesByCategory": [ { "category": string, "amount": number }, ... ],   // sorted desc
     "totalExpense": number,
     "netProfit": number                                         // revenue − totalExpense
   } }
// No property_id → aggregate across the caller's accessible properties.
// Basic plan → 403 FORBIDDEN (reports feature gate).

// ── Reconciliation (owner/manager/finance — admin 403): total tagihan vs total penerimaan ──
GET /api/v1/finance/reconciliation?property_id&month&year
→ { success:true, data: {
     "totalInvoiced": number, "totalCollected": number,
     "totalOutstanding": number, "diff": number                 // diff = invoiced − collected (positive = under-collected)
   } }
```

> **Defaults documented:** category DELETE blocks (not reassign) when in use → caller reassigns
> first; default categories are undeletable. Expenses with `propertyId: null` are tenant-wide
> overhead and are included in unscoped/aggregate totals but excluded when a specific `property_id`
> filter is applied. Cash flow / summary / P&L derive income from **payments**; reconciliation is
> the only endpoint comparing invoiced vs collected.
