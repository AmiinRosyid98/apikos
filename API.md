# KosManager API — MVP-1 Reference

Base URL: `http://localhost:4000/api/v1`
All routes are prefixed with `/api/v1`. Source contract: `PLAN.md` §3.

## Conventions

- **Auth:** `Authorization: Bearer <accessToken>`. `tenantId`, `role`, `userId` come from the JWT — never the body.
- **Content-Type:** `application/json`.
- **Pagination:** `?page=1&limit=20` (default page=1, limit=20, max 100). Sorting: `?sort_order=asc|desc`.
- **Success envelope:** `{ "success": true, "data": <object|array>, "meta"?: { page, limit, total, totalPages } }`
- **Error envelope:** `{ "success": false, "code": "ERROR_CODE", "message": "...", "errors"?: [{ field, message }] }`
- **Path params (PLAN §2.1 "Zod on params"):** every id-style path param (`:id`, `:depId`, and any nested `:propId`/`:roomId`/`:userId`) is validated as a UUID **before** the handler runs. A **malformed** (non-UUID) id → **422 `VALIDATION_ERROR`** with `errors:[{ field:"id", message:"Invalid id (must be a UUID)" }]` (never a 500, never an internal/Prisma/source-path leak). A **well-formed but nonexistent** UUID still resolves to **404 `NOT_FOUND`** (existence not leaked). Non-UUID params such as `:type` on `GET /reports/:type/export.xlsx` are validated by their own route schema instead.

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
| PATCH | `/properties/:id/public` | Owner, Manager |
| DELETE | `/properties/:id` | Owner (soft-deactivate) |

Filters: `?type=&city=&is_active=`.
```http
POST /properties
{ "name":"Kos Melati", "type":"campur", "address":"Jl. Mawar 1", "city":"Bandung", "province":"Jawa Barat",
  "billingDay":1, "lateFeeType":"flat", "lateFeeValue":25000, "lateFeeGraceDays":3, "electricityPriceKwh":1500 }
→ 201 Property   // enforces max_properties

GET /properties/:id
→ 200 Property & { stats:{ totalRooms, occupied, empty, occupancyRate, monthlyRevenue, outstanding } }

PATCH /properties/:id/public      // Public landing/booking-link management (PRD §6.2, §6.13)
{ "publicSlug":"kos-melati", "publicEnabled":true }
// publicSlug: ^[a-z0-9-]{3,100}$ ; null clears it. publicEnabled toggles the public link.
// At least one of the two fields is required. Enabling with no slug → 422. Slug clash → 409 CONFLICT.
→ 200 Property   // audited: property.public_settings
```
`Property` = `{ id,name,type,address,city,province,lat,lng,facilities,billingDay,lateFeeType,lateFeeValue,lateFeeGraceDays,electricityPriceKwh,publicSlug,publicEnabled,isActive,createdAt }`.

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

---

## Booking Management — `/api/v1/bookings` (PRD §6.13)

INTERNAL (authenticated) booking. Booking fee is confirmed **manually** (no payment gateway). The
**public self-service booking link is now built** (see the PUBLIC section at the end of this doc) —
public submissions land here too, distinguished by `source="public"` (filter with `?source=`). No
plan gating — booking is available on all plans.

**State machine:** `pending → confirmed → converted`, or `pending|confirmed → cancelled`, or
`pending → expired` (auto-release). Room status integration: create reserves the room
(`empty → booking`); convert occupies it (`booking → occupied`); cancel/expire release it
(`booking → empty`).

**RBAC (PRD §11/§13):** create → Admin+ (owner/manager/admin) · confirm → Manager+ (owner/manager)
· convert → Admin+ · cancel → Manager+ · view (list/detail) → All. Property-scoped roles only see
bookings for properties in their `user_property_access` (out-of-scope → 404, no existence leak).

```jsonc
// `Booking` object (returned by every endpoint below)
{
  "id": "uuid",
  "propertyId": "uuid",
  "roomId": "uuid|null",                  // null = a room-less PUBLIC inquiry lead
  "prospectName": "string",
  "prospectPhone": "string",
  "prospectEmail": "string|null",
  "plannedCheckInDate": "YYYY-MM-DD",
  "bookingFeeAmount": 150000,
  "bookingFeeMethod": "cash|transfer|qris|other",
  "feeStatus": "unpaid|paid|waived",
  "feeDueAt": "ISO-8601",                 // deadline; auto-release acts after this passes
  "status": "pending|confirmed|converted|cancelled|expired",
  "source": "internal|public",            // public = submitted via the public booking link
  "message": "string|null",               // optional prospect message (public submissions)
  "convertedResidentId": "uuid|null",      // set on convert
  "notes": "string|null",
  "recordedByUserId": "uuid|null",         // null for public submissions
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

```jsonc
// ── List bookings (All; property-scoped) ──
GET /api/v1/bookings?status=&property_id=&room_id=&page=1&limit=20&sort_order=desc
→ { success:true, data: Booking[], meta:{ page, limit, total, totalPages } }

// ── Get one (All; property-scoped) ──
GET /api/v1/bookings/:id
→ { success:true, data: Booking }

// ── Create an INTERNAL booking (Admin+) ──
POST /api/v1/bookings
{
  "roomId": "uuid",                       // REQUIRED — must exist & be `empty`
  "prospectName": "string (2..150)",      // REQUIRED
  "prospectPhone": "string (5..30)",      // REQUIRED
  "prospectEmail": "email",               // optional
  "plannedCheckInDate": "YYYY-MM-DD",     // REQUIRED
  "bookingFeeAmount": 150000,             // optional, default 0
  "bookingFeeMethod": "cash",             // optional, default "cash" (cash|transfer|qris|other)
  "feeDueAt": "ISO-8601",                 // optional, default = now + 24h
  "notes": "string"                       // optional
}
→ 201 { success:true, data: Booking }    // status="pending", feeStatus="unpaid"; room → `booking`
// Errors: 404 room not found · 409 room not `empty` · 409 room already has an active
//         (pending|confirmed) booking · 422 validation.

// ── Confirm (manual fee confirmation) (Manager+) ──
PATCH /api/v1/bookings/:id/confirm          // no body
→ { success:true, data: Booking }           // only from `pending`; sets feeStatus="paid", status="confirmed"
// Error: 409 if not currently `pending`.

// ── Convert into a Resident + Occupancy (Admin+) ──
PATCH /api/v1/bookings/:id/convert
{
  "monthlyRent": 1000000,                 // optional, default = room.basePrice
  "nik": "16 digits",                     // optional (encrypted at rest)
  "gender": "male|female",                // optional
  "email": "email",                       // optional (default = booking.prospectEmail)
  "occupation": "string",                 // optional
  "checkInDate": "YYYY-MM-DD",            // optional, default = booking.plannedCheckInDate
  "contractEndDate": "YYYY-MM-DD",        // optional
  "emergencyContact": { "name": "", "phone": "", "relation": "" },  // optional
  "ktpKey": "string", "selfieKey": "string",                        // optional (R2 keys)
  "internalNotes": "string",              // optional
  "generateFirstInvoice": false           // optional, default false — generate first (pro-rata) invoice
}
→ { success:true, data: {
     "booking": Booking,                  // status="converted", convertedResidentId set
     "residentId": "uuid",
     "firstInvoice": { "created": 1, "skipped": 0 } | null   // present only if generateFirstInvoice
   } }
// only from `pending|confirmed`; creates Resident + active Occupancy; room → `occupied`.
// Errors: 409 if not `pending|confirmed` (e.g. already converted/cancelled/expired) · 422 validation.

// ── Cancel (Manager+) ──
PATCH /api/v1/bookings/:id/cancel
{ "reason": "string" }                    // optional
→ { success:true, data: Booking }         // only from `pending|confirmed`; status="cancelled";
//                                           if room still `booking` → released to `empty`.
// Error: 409 if not `pending|confirmed`.
```

> **Auto-release (cron, PRD §6.13):** a repeatable BullMQ job (`booking-release` queue, default
> every 15 min via `BOOKING_RELEASE_CRON`, TZ `INVOICE_CRON_TZ`) expires `pending` bookings whose
> fee is still `unpaid` and whose `feeDueAt` has passed → `status="expired"` + room released
> (`booking → empty`). Confirmed (fee-paid) bookings are never auto-released. Runs in the **worker**
> process (`npm run worker`), not the API server. Idempotent + per-tenant scoped + failure-isolated.

> **Mutations audited:** `booking.create`, `booking.confirm`, `booking.convert`, `booking.cancel`
> (immutable `audit_logs`). Auto-release logs structured JSON (`booking.released`, `run.done`).

> **Public booking link (BUILT):** unauthenticated `POST /public/properties/:slug/bookings` (see the
> PUBLIC section below) creates bookings here with `source="public"`, `recordedByUserId=null`,
> `feeDueAt` = now+48h, fee amount 0. Same room-status integration, duplicate-active guard, and
> auto-release apply. A public booking with no `roomId` is a room-less inquiry lead (`roomId=null`);
> it cannot be `converted` until staff assign a room (→ 409).

---

## Reports & Excel Export — `/api/v1/reports` (PRD §6.16)

Aggregates EXISTING data (invoices, payments, residents, occupancies, rooms). **No schema change.**
All routes are under `authGuard → tenantContext → loadPropertyScope`. Standard envelope `{success,data}`.

**RBAC + plan gating:**
- **View (JSON report endpoints)** → ALL roles (owner/manager/admin/finance), consistent with dashboard "view-all".
- **Export (`.xlsx`)** → **owner/manager/finance only** (admin → `403 FORBIDDEN`; PRD "Export laporan" excludes admin).
- **Export is plan-gated Pro+** via `assertPlanFeature('reports')` → **Basic plan → `403 FORBIDDEN`**. Viewing JSON is NOT plan-gated.
- Property-scoped roles (manager/admin/finance with `user_property_access`) only aggregate their scoped properties; an explicit out-of-scope `property_id` → `404` (no existence leak). Every report accepts an optional `property_id` (omitted = all in-scope properties).
- Export writes an audit log `report.export`.

### JSON report data endpoints

| Method | Path | Role | Query | Response `data` |
|---|---|---|---|---|
| GET | `/reports/invoices` | All | `property_id?`, `month?` (1–12, default current), `year?` (default current) | InvoicesReport |
| GET | `/reports/residents` | All | `property_id?`, `month?`, `year?` | ResidentsReport |
| GET | `/reports/occupancy` | All | `property_id?`, `months?` (6 \| 12, default 6) | OccupancyTrendRow[] |
| GET | `/reports/revenue` | All | `property_id?`, `year?` | RevenueReport |
| GET | `/reports/room-types` | All | `property_id?` | RoomTypeRow[] |
| GET | `/reports/tax` | **owner/manager/finance** (admin → 403) | `property_id?`, `year?`, `rate?` (0–1, default `0.10`) | TaxReport |
| GET | `/reports/roi` | **owner/manager/finance** (admin → 403) | `property_id?`, `year?` | RoiReport |

> **Tax & ROI view RBAC:** unlike the other JSON reports (ALL roles), `/reports/tax` and `/reports/roi` are gated to **owner/manager/finance** (admin → `403 FORBIDDEN`), consistent with the P&L/financial reports. **Viewing is NOT plan-gated** (only the `.xlsx` export is Pro+).

**InvoicesReport** (filtered by billing period `periodMonth`/`periodYear`; money totals exclude cancelled):
```json
{
  "totalInvoiced": 800000,
  "totalPaid": 0,
  "totalOutstanding": 800000,
  "countByStatus": { "unpaid": 1, "partial": 0, "paid": 0, "overdue": 0, "cancelled": 0 },
  "rows": [
    { "invoiceNumber": "INV-2026-000001", "residentName": "Budi Santoso", "roomNumber": "A1",
      "period": "2026-06", "total": 800000, "paid": 0, "status": "unpaid", "dueDate": "2026-06-05" }
  ]
}
```

**ResidentsReport** — `movedIn`/`movedOut` counted within the period (check-in / check-out date falls inside the month); `active` = residents currently `active`; `rows` lists all residents in scope:
```json
{
  "movedIn": 1, "movedOut": 0, "active": 1,
  "rows": [ { "name": "Budi Santoso", "roomNumber": "A1", "status": "active",
              "checkInDate": "2026-06-01", "checkOutDate": null } ]
}
```

**OccupancyTrendRow[]** — last N (6|12) months. `occupied` = occupancies overlapping the month; `totalRooms` = CURRENT room count in scope (room history isn't snapshotted — same approach as the dashboard trend); `rate` = occupied/totalRooms % (2dp):
```json
[ { "month": "2026-06", "totalRooms": 6, "occupied": 1, "rate": 16.67 } ]
```

**RevenueReport** — 12 months for `year`. `realized` = SUM(payments.amount) with `paidAt` in that month (actual cash). **`target` = SUM(monthlyRent of occupancies ACTIVE during that month)** — the expected rent roll; an occupancy is "active during the month" when it overlaps the month window (`startDate < nextMonth AND (endDate is null OR endDate >= monthStart)`). Plus yearly totals:
```json
{
  "year": 2026,
  "rows": [ { "month": "2026-06", "realized": 0, "target": 800000 }, "... 12 entries ..." ],
  "totalRealized": 0, "totalTarget": 5600000
}
```

**RoomTypeRow[]** — performa per tipe kamar. `count` = rooms of that type; `occupied` = those currently `occupied`; `occupancyRate` = occupied/count % (2dp); `revenue` = SUM(payments on invoices for rooms of that type) for the CURRENT calendar year:
```json
[ { "roomType": "standard", "count": 4, "occupied": 1, "occupancyRate": 25, "revenue": 0 },
  { "roomType": "deluxe", "count": 2, "occupied": 0, "occupancyRate": 0, "revenue": 0 } ]
```

**TaxReport** — Laporan Pajak Sewa (PPh final pasal 4 ayat 2 atas penghasilan sewa). 12 monthly rows + yearly totals for `year`. `rate` is the PPh rate as a **fraction** (0–1); default **`0.10` (10%)**, overridable via `?rate=` (e.g. `0.05`). **`grossIncome` per month = COLLECTED rental revenue** = `SUM(payments.amount)` with `paidAt` in that month — i.e. actual cash received, **not invoiced** (documented choice: PPh final on rental income follows receipts). `pphEstimate = grossIncome × rate` (2dp). Per-property when `property_id` is given, else aggregate over the caller's property scope:
```json
{
  "year": 2026,
  "rate": 0.1,
  "rows": [ { "month": "2026-06", "grossIncome": 800000, "pphEstimate": 80000 }, "... 12 entries ..." ],
  "totalGross": 800000,
  "totalPph": 80000
}
```

**RoiReport** — Laporan ROI per properti for `year` (PRD §6.12 tambahan, §19). One row per property in scope (one row when `property_id` is given) + an aggregate `totals` block. Definitions:
- `investmentValue` = `property.investmentValue` (acquisition/investment cost; **null** if not set).
- `revenue` = COLLECTED payments (`paidAt` in the year) on the property's invoices.
- `expense` = expenses recorded (`date` in the year) against the property.
- `netIncome` = `revenue − expense`.
- `roiPercent` = `investmentValue > 0 ? netIncome / investmentValue × 100 : null` (2dp).
- `paybackYears` = `(netIncome > 0 && investmentValue > 0) ? investmentValue / netIncome : null` (2dp).
- **Null/zero investment → `roiPercent`/`paybackYears` are `null`** (the UI prompts "atur nilai investasi"). In `totals`, `investmentValue` is `null` only when NO property in scope has one.
```json
{
  "year": 2026,
  "rows": [
    { "propertyId": "…", "propertyName": "Kos Melati", "investmentValue": 500000000,
      "revenue": 800000, "expense": 350000, "netIncome": 450000,
      "roiPercent": 0.09, "paybackYears": 1111.11 }
  ],
  "totals": { "investmentValue": 500000000, "revenue": 800000, "expense": 350000,
              "netIncome": 450000, "roiPercent": 0.09, "paybackYears": 1111.11 }
}
```

> **`investmentValue` field** (new): a nullable `Decimal(14,2)` column on `properties` (acquisition/investment cost). Settable via the existing **`PUT /api/v1/properties/:id`** (Owner/Manager) — body field `investmentValue: number | null` (`null` clears it). Returned in the property serializer (`investmentValue: number | null`). ROI handles null gracefully (see above).

### Excel export

```
GET /api/v1/reports/:type/export.xlsx
    type ∈ { invoices | residents | occupancy | revenue | room-types | tax | roi }
    query: property_id?, month?, year?, months?, rate?   (the superset — each type reads only what it needs; rate is tax-only)
    Role: owner/manager/finance (admin → 403). Plan: Pro+ (basic → 403).
```
Streams the workbook with:
- `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `Content-Disposition: attachment; filename="laporan-<type>-<period>.xlsx"`
  (period = `YYYY-MM` for invoices/residents, `YYYY` for revenue/room-types/tax/roi, `<n>bln` for occupancy)
- `Content-Length` set; body is the raw `.xlsx` (ZIP, magic bytes `PK\x03\x04`).

Each sheet has: a title row (`KosManager — <Laporan ...>`), a property/period header line, **bold** column headers, data rows, a **totals row** where relevant (invoices, revenue, room-types, **tax**, **roi**), Rupiah number formatting (`#,##0`) on money columns, and sensible column widths. Built with `exceljs`. The **tax** sheet header also shows the PPh rate (e.g. `Tarif PPh: 10%`) and notes the cash basis; the **roi** sheet renders `—` for null `investmentValue`/`roiPercent`/`paybackYears`.

> **Format decision (product owner):** Excel `.xlsx` ONLY for this module — no PDF. (PDF streaming exists separately for the handover "berita acara" module.)

---

## WhatsApp + Reminder Otomatis (PRD §6.9, §6.10) — STUB MODE

> **Stub mode:** messages are **recorded but NOT actually sent**. Every send path goes through a
> `WhatsAppProvider` seam. The default `StubProvider` (active when no `FONNTE_TOKEN`) logs the send
> and records the `wa_messages` row with **status `stub`** so the UI can show "mode demo". Going live
> with Fonnte is a **config-only** change (set `FONNTE_TOKEN`) — no caller/API changes.

### RBAC (PRD §13)
| Action | Roles |
|---|---|
| View templates / logs / status / reminder-config | All (owner/manager/admin/finance) |
| Create / edit / delete template, **konfigurasi template** | Manager+ (owner/manager) |
| **Send invoice via WA** | Admin+ (owner/manager/admin) |
| **Broadcast** | Manager+ (owner/manager) |
| **Update reminder-config** | Manager+ (owner/manager) |

Property-scoped roles (manager/admin/finance with `user_property_access`) are limited to their
properties; template/log lists also include tenant-default (null-property) templates. Out-of-scope
explicit `property_id` → 404 (no existence leak).

### Endpoints

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/v1/wa/templates?property_id=&type=` | All | Paginated. |
| POST | `/api/v1/wa/templates` | Manager+ | Create. Non-custom types are unique per (tenant, property, type) → 409 on dup. |
| PUT | `/api/v1/wa/templates/:id` | Manager+ | Edit `name`/`body`/`isActive`. |
| DELETE | `/api/v1/wa/templates/:id` | Manager+ | Hard delete. |
| POST | `/api/v1/invoices/:id/send-wa` | Admin+ | Renders `invoice_new` (default) or `reminder_due` for the invoice's resident; enforces quota; returns the `wa_messages` row (status `stub`). |
| POST | `/api/v1/wa/broadcast` | Manager+ | Sends to each **active resident** of the property; one row each; quota = all-or-nothing (blocks if remaining < recipients). |
| GET | `/api/v1/wa/logs?property_id=&status=&date_from=&date_to=` | All | Paginated send log. |
| GET | `/api/v1/wa/status` | All | Provider + monthly quota. |
| GET | `/api/v1/properties/:id/reminder-config` | All | Returns config (defaults applied when null). |
| PUT | `/api/v1/properties/:id/reminder-config` | Manager+ | Partial merge over current config. |

### Request / response shapes

```jsonc
// POST /wa/templates  (body)
{ "propertyId": "<uuid>?",                 // null/omit = tenant-default template
  "type": "invoice_new|reminder_due|reminder_overdue|payment_received|contract_expiry|broadcast|custom",
  "name": "string", "body": "string with {nama_penyewa} {nomor_kamar} {jumlah_tagihan} {jatuh_tempo} {nama_kos}",
  "isActive": true }

// WaTemplate (response)
{ "id","propertyId","type","name","body","isActive","createdAt","updatedAt" }

// POST /invoices/:id/send-wa  (body, optional)
{ "templateType": "invoice_new" }          // or "reminder_due"; defaults to invoice_new

// POST /wa/broadcast  (body)
{ "propertyId": "<uuid>", "body": "Halo {nama_penyewa} ...", "audience": "active_residents" }
// → { "sent": N, "recipients": N, "messages": [WaMessage, ...] }

// WaMessage (send-log row)
{ "id","propertyId","residentId","invoiceId","toPhone","toName",
  "templateType","reminderKey","body","status":"queued|sent|failed|stub",
  "provider":"stub|fonnte","providerMessageId","error","sentByUserId","createdAt" }

// GET /wa/status  (response)
{ "provider": "stub|fonnte", "configured": false,
  "quota": { "used": 2, "limit": 500, "remaining": 498, "periodMonth": 6, "periodYear": 2026 } }
// limit: Basic 100 / Pro 500 / Premium null (unlimited)

// reminder-config (GET response / PUT body — PUT accepts any subset, merged over current)
{ "enabled": true,
  "offsets": { "h7": true, "h3": true, "h0": true, "h3plus": true, "h7plus": true },
  "contractExpiry": { "h30": true, "h14": true, "h7": true } }
```

### Template variables (rendered in `body`)
`{nama_penyewa}` resident name · `{nomor_kamar}` room number · `{jumlah_tagihan}` invoice total
(e.g. `Rp800.000`) · `{jatuh_tempo}` due date (e.g. `5 Juni 2026`) · `{nama_kos}` property name.
Unknown/missing placeholders are left literal (so misconfig is visible).

### Quota (PRD §12.2)
Monthly count of `wa_messages` with status in (`sent`|`stub`) vs plan limit (Basic 100 / Pro 500 /
Premium unlimited). Exceeding → **403 `PLAN_LIMIT_EXCEEDED`** (the `whatsapp` feature is in all
plans — plans differ by quota only, so sending is **not** hard-blocked by feature, only by quota).

### Reminder Otomatis (PRD §6.10) — daily cron (stub send)
`src/jobs/reminderSender.ts` `runReminderSweep()` runs daily (`REMINDER_CRON`, default `0 8 * * *`
WIB). Per tenant/property with `reminderConfig.enabled`, it scans unpaid/overdue invoices, computes
days-to-`dueDate`, and for each enabled offset matching today sends the appropriate template:
- **H-7 / H-3 / H-0** → `reminder_due`; **H+3 / H+7** → `reminder_overdue`.
- **Contract expiry H-30 / H-14 / H-7** from `resident.contractEndDate`.
**Idempotent:** each `(invoice|resident, offset)` is guarded by a `wa_messages.reminderKey` lookup
(e.g. `reminder_due:H-7`) — a second run the same day sends 0. Quota-aware, per-tenant scoped,
failure-isolated, structured JSON logs.

---

## Payment Gateway (PRD §6.8) — STUB MODE

Online payment via a provider seam (default **Stub** = no real money; **Midtrans** when
`MIDTRANS_SERVER_KEY` is set — config-only swap). Charge → instructions → webhook → Payment, fully
idempotent. Plan gates the available methods (PRD §12.2): **Basic = QRIS only, Pro = QRIS + VA,
Premium = all**. The standard `{ success, data }` / `{ success, code, message }` envelope applies.

### RBAC (PRD §13)

| Action | owner | manager | admin | finance |
|---|---|---|---|---|
| Create charge (`POST /invoices/:id/charge`) | ✅ | ✅ | ✅ | ❌ |
| View invoice charges (`GET /invoices/:id/charges`) | ✅ | ✅ | ✅ | ✅ |
| List txns (`GET /payment-txns`) | ✅ | ✅ | ❌ | ✅ |
| Reconciliation (`GET /payments/reconciliation`) | ✅ | ✅ | ❌ (excluded) | ✅ |
| Simulate (`POST /payment-txns/:id/simulate`) | ✅ | ❌ | ✅ | ❌ |
| Method availability (`GET /payments/methods`) | ✅ | ✅ | ✅ | ✅ |
| Webhook (`POST /webhooks/payment`) | PUBLIC (no auth — verified) |

### Endpoints

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/v1/invoices/:id/charge` | Admin+ | body `{ method }`. Method must be allowed for the plan (else **403 PLAN_LIMIT_EXCEEDED** with the allowed list). Rejects a `paid`/`cancelled` invoice (409). Creates a `pending` txn for the remaining balance. |
| GET | `/api/v1/invoices/:id/charges` | All | this invoice's gateway txns (property-scoped). |
| GET | `/api/v1/payment-txns?status&method&date_from&date_to` | owner/manager/finance | paginated; property-scoped. |
| POST | `/api/v1/payment-txns/:id/simulate` | owner/admin | **stub-only** — drives a `paid`/`failed`/`expired` webhook for a `pending` txn. **400** if a real provider is active. body `{ outcome? }` (default `paid`). |
| GET | `/api/v1/payments/reconciliation?property_id&month&year` | owner/manager/finance | matched vs unmatched + invoiced/collected + flags. |
| GET | `/api/v1/payments/methods` | All | `{ plan, methods[], provider, providerConfigured }` — the per-plan allowed methods (source of truth; `GET /subscription` also returns `paymentMethods`). |
| POST | `/api/v1/webhooks/payment` | **PUBLIC** | provider-shaped body; verified via `provider.verifyWebhook`. On `paid`: idempotently records a Payment + recomputes invoice status + links the txn + fires the `payment_received` WA stub. Always 200. |

### Request / response shapes (for the frontend agent)

```
POST /invoices/:id/charge   (body)
{ method: "qris"|"va_bca"|"va_bni"|"va_bri"|"va_mandiri"|"va_permata"|"gopay"|"ovo"|"dana"|"shopeepay"|"linkaja" }

PaymentGatewayTxn (response)
{ id, invoiceId, paymentId|null, provider:"stub"|"midtrans", method, providerRef,
  amount:number, status:"pending"|"paid"|"expired"|"failed",
  instructions: { type:"qris"|"va"|"ewallet", qrString?, vaNumber?, bank?, deeplink?, expiresAt? },
  paidAt|null, createdAt, updatedAt }

POST /payment-txns/:id/simulate  (body, stub-only)
{ outcome?: "paid"|"failed"|"expired" }   // default "paid"
→ { handled, status, paymentId?, idempotent? }

POST /webhooks/payment  (PUBLIC; stub body shape)
{ providerRef:string, status:"paid"|"failed"|"expired", amount?:number, paidAt?:string }
// Midtrans body shape: { order_id, status_code, gross_amount, signature_key, transaction_status, ... }
→ { handled:boolean, providerRef?, status?, paymentId?|null, idempotent?, reason? }

GET /payments/methods  (response)
{ plan:"basic"|"pro"|"premium", methods:string[], provider:"stub"|"midtrans", providerConfigured:boolean }

GET /payments/reconciliation?month=&year=&property_id=  (response)
{ period:{month,year},
  gateway:{ paidTxnCount, paidTxnTotal, matchedCount, unmatchedCount, unmatchedRefs[] },
  payments:{ gatewayPaymentCount, gatewayPaymentTotal },
  invoices:{ count, invoicedTotal, collectedTotal, outstandingTotal },
  reconciled:boolean, flags:[{code,message}] }
```

**Instruction types per method:** `qris` → `{ type:"qris", qrString }`; `va_*` → `{ type:"va", vaNumber, bank }`; e-wallets → `{ type:"ewallet", deeplink }`. In stub mode these are fabricated but real-looking so the UI renders genuine instructions.

**Idempotency:** the webhook (and simulate) only transition a `pending` txn. A replayed `paid` webhook is a no-op (`handled:false, idempotent:true`) — no second Payment, the invoice stays paid once. Guard is on `providerRef` (unique) + the txn's current status, re-checked inside the transaction.

**Going live (Midtrans):** set `MIDTRANS_SERVER_KEY` (+ `MIDTRANS_CLIENT_KEY`, optional `MIDTRANS_IS_PRODUCTION=true`) and restart — the factory returns the Midtrans provider, txns record `provider:"midtrans"`, the real signed webhook replaces the simulate path, and `/payments/methods` reports `providerConfigured:true`. No code edits, no migration, no caller changes. The stub-only `simulate` endpoint returns 400 once a real provider is active.

**Reconciliation cron:** a daily BullMQ job (`payment-reconcile` queue, env `RECON_CRON`, default 01:00 WIB) logs a per-tenant reconciliation summary for the current period (idempotent/read-only, per-tenant scoped, failure-isolated). Runs in the standalone worker (`npm run worker`).

---

## Maintenance Module (PRD §6.14) — tickets + vendor DB + per-room history

Internal maintenance management: tickets, a vendor (tukang) database with per-vendor work history, ticket cost, and per-room history (for check-out reference). **No plan gate** (maintenance is not in the §12.2 plan matrix → available on all plans). The public tenant-submitted-report link is **DEFERRED** — this build is INTERNAL only (auth required).

### RBAC (PRD §13)
| Action | Roles |
|---|---|
| Ticket add / edit (PUT) / assign vendor / set cost / close (status) | **Admin+** (owner/manager/admin) — finance ❌ |
| Ticket view (list/detail) + per-room history | **All** (incl. finance) |
| Vendor manage (create/edit) | **Admin+** |
| Vendor delete | **Manager+** (owner/manager) — admin ❌ |
| Vendor view (list/detail) | **All** |

All mutations write immutable audit logs: `maintenance.create`, `maintenance.update`, `maintenance.status`, `vendor.create`, `vendor.update`, `vendor.delete`. Property-scoped roles (manager/admin/finance with a `user_property_access` list) only see tickets for their properties; out-of-scope/out-of-tenant → 404 (no existence leak). Malformed UUID path params → 422.

### Tickets — `/api/v1/maintenance`

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/maintenance` | All | filters `status, priority, property_id, room_id, vendor_id`; pagination |
| GET | `/maintenance/:id` | All | detail with presigned `photos[]` + assigned `vendor` |
| POST | `/maintenance` | Admin+ | create → status `open`, sequential `ticketNumber` |
| PUT | `/maintenance/:id` | Admin+ | edit fields incl. assign `vendorId` + set `cost` (+ optional cost→expense) |
| PATCH | `/maintenance/:id/status` | Admin+ | valid transitions; `done` sets `resolvedAt`; `cancelled` allowed |

**Ticket numbering:** per-tenant sequential `TKT-{YEAR}-{4-digit seq}` (e.g. `TKT-2026-0001`) via `tenant_counters.maintenanceSeq`/`maintenanceSeqYear`, allocated atomically inside the create transaction (same pattern as invoice numbering). The sequence resets each year.

**Status state machine** (PRD §6.14) — invalid transition → **409 CONFLICT**:
```
open          → in_progress | waiting_parts | done | cancelled
in_progress   → waiting_parts | done | cancelled
waiting_parts → in_progress  | done | cancelled
done          → (terminal — any change → 409)
cancelled     → (terminal — any change → 409)
```
On `done`, `resolvedAt` is set (server clock). `cancelled` is reachable from any non-terminal state.

```
POST /maintenance   (body)
{ propertyId:uuid(REQUIRED), roomId?:uuid|null (null/omitted = area umum/common),
  title:string(2..200), description:string(1..5000), category?:string, priority:"low"|"medium"|"high"|"critical"=medium,
  photoKeys?:string[] (R2 keys from presign-upload, default []) }

PUT /maintenance/:id   (body — all optional, partial update)
{ title?, description?, category?:string|null, priority?, vendorId?:uuid|null (null un-assigns),
  cost?:number>=0, photoKeys?:string[], notes?:string|null, logAsExpense?:boolean=false }

PATCH /maintenance/:id/status   (body)
{ status:"open"|"in_progress"|"waiting_parts"|"done"|"cancelled" (REQUIRED),
  cost?:number>=0, logAsExpense?:boolean=false, notes?:string }

MaintenanceTicket (response)
{ id, propertyId, roomId, ticketNumber, title, description, category, priority, status,
  vendorId, photoKeys:[], cost:number, reportedByUserId, resolvedAt, expenseId, notes,
  createdAt, updatedAt }

GET /maintenance/:id  → MaintenanceTicket & {
  photos:[{ key, url }] (url presigned; STUB placeholder until R2),
  vendor: Vendor | null }
```

### Cost → Expense seam (optional, default OFF)

On `PUT /maintenance/:id` or `PATCH /maintenance/:id/status` (typically when closing → `done`), if the effective `cost > 0` **and** `logAsExpense:true`, a Finance `expenses` row is created in the seeded **"Maintenance"** category (created lazily if the tenant lacks it), scoped to the ticket's `propertyId`, dated today, described `"{ticketNumber}: {title}"`, via the existing `finance` expense service. The ticket records the new `expenseId` and **will not double-log** on subsequent calls. Default is off (`logAsExpense:false`) — the cost is stored on the ticket regardless; logging the expense is an explicit opt-in.

### Vendors — `/api/v1/vendors`

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/vendors` | All | filters `skill` (case-insensitive contains), `is_active`; pagination |
| GET | `/vendors/:id` | All | detail INCLUDING `workHistory` (assigned tickets + total cost + count) |
| POST | `/vendors` | Admin+ | create |
| PUT | `/vendors/:id` | Admin+ | edit |
| DELETE | `/vendors/:id` | Manager+ | soft-deactivate if referenced by tickets, else hard-delete |

**Delete behavior:** if the vendor is the assignee on ≥1 ticket → **soft-deactivate** (`isActive=false`, returns `{ id, mode:"deactivated" }`) to preserve work history (the ticket FK is `ON DELETE SET NULL`). If unreferenced → **hard-delete** (`{ id, mode:"deleted" }`).

```
POST /vendors   (body)
{ name:string(2..150), skill?:string (keahlian — listrik/ledeng/AC/…), phone?:string,
  rating?:number(1..5), notes?:string, isActive?:boolean=true }

PUT /vendors/:id   (body — all optional)
{ name?, skill?:string|null, phone?:string|null, rating?:number(1..5)|null, notes?:string|null, isActive? }

Vendor (response)
{ id, name, skill, phone, rating:number|null, notes, isActive, createdAt, updatedAt }

GET /vendors/:id  → Vendor & {
  workHistory: { ticketCount:number, totalCost:number, tickets:[MaintenanceTicket] } }
```

### Per-room history — `GET /api/v1/rooms/:id/maintenance` (All)

Tickets for one room (check-out reference, PRD §6.14). Same data as `GET /maintenance?room_id=<id>` but room-nested; adds `totalCost` to the pagination meta.
```
GET /rooms/:id/maintenance?status=&page=&limit=&sort_order=
→ { success:true, data:[MaintenanceTicket], meta:{ page, limit, total, totalPages, totalCost } }
```

### Deferred: public tenant-submitted-report link
Built INTERNAL only. A future unauthenticated `POST /public/properties/:publicSlug/maintenance-reports` would resolve the tenant from `Property.publicSlug` and call a thin wrapper over the ticket-create path (forcing `open`, omitting `reportedByUserId`). Seam marked in `maintenance.service.ts` (PUBLIC REPORT SEAM).

---

## Dokumen & Kontrak Module (PRD §6.15)

Customizable contract templates per property, contract generation for a resident (with a rendered body snapshot + sequential numbering), digital signature, contract PDF export, and a lightweight document registry with expiry. Standard envelope, pagination, property-scope, and audit. **No plan gate** (Dokumen & Kontrak is not in the §12.2 plan matrix → available on all plans).

**RBAC (PRD §13 — no explicit Dokumen row; mapped sensibly):**
- Templates config (create/edit/delete) → **Manager+** (like WA template config); view → **All**.
- Contracts: generate/edit → **Admin+**; sign / change status → **Manager+**; view + PDF → **All**.
- Documents: add → **Admin+**; delete → **Manager+**; view + expiring → **All**.

| Method | Path | Role |
|---|---|---|
| GET | `/api/v1/contract-templates?property_id&is_active` | All |
| POST | `/api/v1/contract-templates` | Manager+ |
| PUT | `/api/v1/contract-templates/:id` | Manager+ |
| DELETE | `/api/v1/contract-templates/:id` | Manager+ |
| GET | `/api/v1/contracts?resident_id&property_id&status` | All (paginated) |
| POST | `/api/v1/contracts` | Admin+ |
| POST | `/api/v1/residents/:id/contract` | Admin+ (convenience generate) |
| GET | `/api/v1/contracts/:id` | All (+ presigned signature URLs) |
| GET | `/api/v1/contracts/:id/pdf` | All (streams `application/pdf`) |
| PATCH | `/api/v1/contracts/:id/sign` | Manager+ |
| PATCH | `/api/v1/contracts/:id/status` | Manager+ |
| GET | `/api/v1/residents/:id/documents?type` | All |
| POST | `/api/v1/residents/:id/documents` | Admin+ |
| DELETE | `/api/v1/documents/:id` | Manager+ |
| GET | `/api/v1/documents/expiring?days=30&property_id` | All |

### Template render variables
The template `body` holds `{variabel}` placeholders, rendered against resident/room/property context at generation time (same `{var}` approach as WhatsApp templates). Unknown placeholders are left literal so misconfiguration is visible. Supported variables:
`{nama_penyewa}` `{nik}` `{nomor_kamar}` `{nama_kos}` `{alamat}` `{harga_sewa}` `{tanggal_masuk}` `{tanggal_keluar}` `{tanggal_hari_ini}`.
- `{nik}` is the resident's decrypted NIK; `{harga_sewa}` is formatted `Rp1.200.000`; dates are formatted Indonesian e.g. `1 Januari 2026`.

### Contract templates
```
POST /contract-templates   (body)        // Manager+
{ propertyId?:uuid|null (null/omitted = tenant default), name:string(2..200),
  body:string(1..50000) with {variabel} placeholders, isActive?:boolean=true }

PUT /contract-templates/:id   (body — all optional)
{ propertyId?:uuid|null, name?, body?, isActive? }

ContractTemplate (response)
{ id, propertyId:uuid|null, name, body, isActive, createdAt, updatedAt }

GET /contract-templates?property_id=&is_active=&page=&limit=&sort_order=
// A property filter returns that property's templates PLUS all tenant-default (propertyId null)
// templates. Property-scoped users see tenant defaults + their in-scope properties' templates.
→ { success:true, data:[ContractTemplate], meta:{ page, limit, total, totalPages } }
```

### Contracts
```
POST /contracts   (body)                  // Admin+
{ residentId:uuid, templateId?:uuid|null, startDate:"YYYY-MM-DD", endDate:"YYYY-MM-DD" (> start),
  notes?:string }
// Resolves the body: explicit templateId → that template; else the resident's property active
// template; else the tenant-default active template; else a built-in default. Renders it into a
// STABLE `body` snapshot, allocates contractNumber (KTR-{YEAR}-{4-digit}), status `draft`.

POST /residents/:id/contract   (body)     // Admin+ (convenience)
{ templateId?:uuid|null, startDate?:"YYYY-MM-DD", endDate?:"YYYY-MM-DD", notes?:string }
// Dates default to: startDate = resident.checkInDate; endDate = resident.contractEndDate
// (or startDate + 1 year if none).

Contract (response)
{ id, residentId, propertyId, roomId, templateId:uuid|null, contractNumber:"KTR-2026-0001",
  body (rendered snapshot), status:"draft|active|signed|expired|terminated",
  startDate:"YYYY-MM-DD", endDate:"YYYY-MM-DD", signedAt:ISO|null,
  residentSignatureKey:string|null, ownerSignatureKey:string|null, notes, createdByUserId, createdAt, updatedAt }

GET /contracts?resident_id=&property_id=&status=&page=&limit=&sort_order=
→ { success:true, data:[Contract], meta:{ page, limit, total, totalPages } }

GET /contracts/:id   → Contract & { residentSignatureUrl:string|null, ownerSignatureUrl:string|null }
// Signature URLs are presigned only for keys tracked in the files table (presign stub → null otherwise).

PATCH /contracts/:id/sign   (body)        // Manager+
{ residentSignatureKey:string(REQUIRED), ownerSignatureKey?:string }
// → status `signed`, signedAt set, signature keys stored. Signing an expired/terminated contract → 409.

PATCH /contracts/:id/status   (body)      // Manager+
{ status:"draft|active|signed|expired|terminated", notes?:string }
// Valid transitions: draft→{active,terminated}; active→{signed,expired,terminated};
// signed→{active,expired,terminated}; expired/terminated = terminal. Invalid (incl. a no-op
// same-status change, or any change on a terminal contract) → 409 CONFLICT.

GET /contracts/:id/pdf                     // All
// Streams application/pdf (pdfkit): header (title + contract number + status), parties
// (kos/owner ↔ resident) + period meta, the rendered body, and two signature lines (resident +
// owner) with the signature key reference (image bytes not embedded — presign stub, same as the
// berita-acara PDF). Content-Disposition inline filename "kontrak-<contractNumber>.pdf".
```

### Documents (registry with expiry)
```
POST /residents/:id/documents   (body)    // Admin+
{ type:"ktp|sim|kk|contract|other"=other, name:string(1..200), fileKey:string(1..500),
  propertyId?:uuid|null (defaults to the resident's property), expiresAt?:"YYYY-MM-DD"|null, notes?:string }

DocumentRecord (response)
{ id, residentId:uuid|null, propertyId:uuid|null, type, name, fileKey, expiresAt:"YYYY-MM-DD"|null,
  notes, uploadedByUserId, createdAt }

GET /residents/:id/documents?type=&page=&limit=&sort_order=
→ { success:true, data:[DocumentRecord & { fileUrl:string|null (presigned) }], meta:{…} }

DELETE /documents/:id   → { success:true, data:{ id } }   // Manager+

GET /documents/expiring?days=30&property_id=&page=&limit=    // All
// Documents whose expiresAt falls between today and today+days (inclusive), oldest-expiry first.
// This is the RENEWAL-NOTIFICATION SEAM: the WhatsApp `contract_expiry`/reminder sweep would source
// rows from here (or from Contract.endDate) to notify. Property-scoped; tenant-wide docs (propertyId
// null) are included.
→ { success:true, data:[DocumentRecord], meta:{ page, limit, total, totalPages, windowDays } }
```

### Numbering & seams
- **Contract numbering** `KTR-{YEAR}-{4-digit}`: per-tenant sequential via `tenant_counters.contractSeq`/`contractSeqYear`, allocated atomically inside the create transaction (same pattern as `INV-`/`TKT-`). Resets each year.
- **Body snapshot**: the contract's `body` is rendered once at generation and stored, so the document is stable even if the source template later changes (the contract keeps `templateId` for provenance).
- **Renewal-notification seam**: `GET /documents/expiring` + `Contract.endDate` are the hook points where the existing WhatsApp `contract_expiry` template / reminder sweep would source expiring contracts/documents to notify (not wired into the cron in this build — documented seam).
- **Signature images**: signature keys reference uploaded files; URLs are presigned only when the key is a tracked `files` row (presign stub → null), and the PDF draws a signature line + key reference rather than embedding bytes (same as the handover PDF).

---

## In-App Notification Module (PRD §6.18)

Per-user notification center + unread badge + per-type preferences. Notifications are emitted from
EXISTING business events (no client-create endpoint). Everything is **PER-USER**: every endpoint
operates on the current user (`req.auth.userId`) within their tenant. **ALL roles** are allowed
(a notification center is personal). **No plan gate.** Browser push (VAPID/web-push) is **DEFERRED**
— in-app only in this build (clean seam in `src/services/notification.service.ts`).

### Endpoints

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/notifications?unread=true&type=&page=&limit=` | All | Current user's notifications, newest first, paginated |
| GET | `/api/v1/notifications/unread-count` | All | Unread badge → `{ count }` |
| PATCH | `/api/v1/notifications/:id/read` | All | Mark one OWN notification read (another user's → 404) |
| POST | `/api/v1/notifications/read-all` | All | Mark all of the current user's unread read → `{ updated }` |
| GET | `/api/v1/notification-preferences` | All | Current user's effective per-type prefs + role mapping |
| PUT | `/api/v1/notification-preferences` | All | Merge per-type on/off toggles (partial) |

### Shapes

```jsonc
// GET /notifications → data: Notification[]  (+ meta pagination)
Notification = {
  id, type,                       // type ∈ payment_received | booking_new | maintenance_critical
                                  //        | contract_expiring | invoice_overdue | general
  title, body,
  link,                           // in-app deep link, e.g. "/invoices/:id" (nullable)
  entityType, entityId,           // source business entity (nullable)
  isRead, readAt,                 // readAt ISO timestamp (null until read)
  createdAt
}

// GET /notifications query
{ unread?: boolean,               // unread=true → only unread
  type?: NotificationType,
  page=1, limit=20 (max 100),
  sort_order: "asc"|"desc" = "desc" }

// GET /notifications/unread-count → data
{ count: number }

// PATCH /notifications/:id/read → data: Notification (isRead:true)
// POST  /notifications/read-all  → data: { updated: number }

// GET /notification-preferences → data
{
  preferences: {                  // EVERY type as a boolean (NULL stored prefs → all true)
    payment_received: true, booking_new: true, maintenance_critical: true,
    contract_expiring: true, invoice_overdue: true, general: true
  },
  defaultRolesByType: {           // documented "who gets what" recipient mapping
    payment_received: ["owner","manager","finance"],
    booking_new:      ["owner","manager","admin"],
    maintenance_critical: ["owner","manager","admin"],
    contract_expiring: ["owner","manager"],
    invoice_overdue:  ["owner","manager"],
    general:          ["owner","manager","admin","finance"]
  }
}

// PUT /notification-preferences body (all optional; omitted keys unchanged; strict — unknown keys → 422)
{ payment_received?: boolean, booking_new?: boolean, maintenance_critical?: boolean,
  contract_expiring?: boolean, invoice_overdue?: boolean, general?: boolean }
// → returns the same shape as GET (effective preferences + defaultRolesByType)
```

Error envelope is the standard `{ success:false, code, message, errors?[] }`. Codes used:
`VALIDATION_ERROR`(422 — incl. malformed UUID `:id`), `NOT_FOUND`(404 — another user's notification),
`UNAUTHENTICATED`(401).

### How notifications are produced (emit hooks)

Notifications are created server-side by the `notify()` service, called from existing events
(best-effort / failure-isolated — a notify failure NEVER breaks the business action):

| Event | Type | Recipients (default roles) | Link |
|---|---|---|---|
| Payment success (gateway webhook/simulate records a Payment + flips invoice paid) | `payment_received` | owner/manager/finance | `/invoices/:id` |
| Booking created | `booking_new` | owner/manager/admin | `/bookings` |
| Maintenance ticket created with priority `critical` | `maintenance_critical` | owner/manager/admin | `/maintenance` |
| Contract/document expiring within 30 days (daily reminder sweep) | `contract_expiring` | owner/manager | `/residents/:id` (or `/documents`) |

- A recipient with `notificationPrefs[type] === false` is skipped. NULL prefs / missing key = enabled.
- The `contract_expiring` sweep is **idempotent**: it does not re-create a notification for an entity
  that already has an UNREAD `contract_expiring` notification (dedupe by `type`+`entityType`+`entityId`).
- `invoice_overdue` + `general` types exist for forward use (and manual/general emits); no event wires
  them in this build.

---

## PUBLIC — Landing Page + Public Booking Link — `/api/v1/public/*` (PRD §6.2, §6.13)

> ⚠️ **PUBLIC / NO AUTH.** These two endpoints are **unauthenticated** — NO `Authorization` header,
> NO JWT, NO tenant header. They are mounted **OUTSIDE** the protected router (exactly like
> `POST /webhooks/payment`). The tenant + property are resolved **strictly from the URL `:slug`**
> (the property's `publicSlug`, which is globally unique); everything after resolution runs inside the
> tenant guard, so a public caller can never reach another tenant's data.
>
> **CORS:** this router is **permissive (any origin, no credentials)** because it is meant to be
> called from the public marketing site (a different origin than the dashboard). It exposes only
> marketing-safe data. The rest of the API keeps the strict CORS allowlist.
>
> **A property is only reachable when `publicEnabled=true` AND a `publicSlug` is set.** A disabled,
> slug-less, inactive, or unknown property all return the **same 404** (no existence/state leak).
> Set this up via `PATCH /properties/:id/public` (Owner/Manager). Demo: `kos-melati` is seeded enabled.

### `GET /public/properties/:slug` — marketing info + available rooms

Rate-limited (default **60 / 5 min / IP**, env `PUBLIC_READ_RATE_LIMIT_MAX` / `PUBLIC_RATE_LIMIT_WINDOW_MS`).
Returns ONLY public-safe fields — **no** tenant/owner/financial/resident data. `availableRooms` are
**only `empty` rooms** (occupied/booked/maintenance rooms are hidden).

```jsonc
GET /api/v1/public/properties/kos-melati
→ 200 {
  "success": true,
  "data": {
    "property": {
      "name": "Kos Melati", "type": "campur",
      "address": "Jl. Mawar No. 1", "city": "Bandung", "province": "Jawa Barat",
      "facilities": ["wifi","parkir","dapur"], "publicSlug": "kos-melati"
    },
    "availableRooms": [
      { "id":"uuid", "roomNumber":"A3", "roomType":"deluxe", "basePrice":1200000,
        "facilities":["kasur","lemari"], "photos":[] }
    ],
    "availableRoomCount": 1,
    "priceRange": { "min":1200000, "max":1250000 }   // null when no rooms available
  }
}
// Unknown / disabled / inactive slug → 404 NOT_FOUND (identical shape — no existence leak).
```

### `POST /public/properties/:slug/bookings` — public booking submission

**Strict** per-IP rate limit (default **5 / hour / IP**, env `PUBLIC_BOOKING_RATE_LIMIT_MAX` /
`PUBLIC_BOOKING_RATE_LIMIT_WINDOW_MS`). Creates a `pending` booking in the slug's tenant with
`source="public"`, `feeStatus="unpaid"`, `bookingFeeAmount=0`, `feeDueAt = now + 48h`,
`recordedByUserId=null`. Emits a `booking_new` in-app notification (owner/manager/admin).

```jsonc
POST /api/v1/public/properties/kos-melati/bookings
{
  "prospectName": "Citra",                 // required, 2-150 chars
  "prospectPhone": "0812-3456-7890",       // required, 8-20 digits (+, space, - allowed)
  "prospectEmail": "citra@example.com",    // optional
  "roomId": "uuid",                        // OPTIONAL — must belong to this property + be empty
  "plannedCheckInDate": "2026-07-01",      // required, YYYY-MM-DD, not in the past
  "message": "Kapan bisa lihat kamar?",    // optional, <=1000 chars
  "_hp": ""                                // HONEYPOT — must be empty/absent (anti-spam)
}
→ 201 {
  "success": true,
  "data": {
    "reference": "E4ECC155",               // short reference (NOT a full id); no other internal ids
    "status": "pending",
    "propertyName": "Kos Melati",
    "message": "Permintaan booking Anda telah diterima. Pengelola akan segera menghubungi Anda."
  }
}
```

Behaviour & hardening:
- **`roomId` given** → must belong to THIS property and be `empty`; on success the room is reserved
  (`empty → booking`), guarded against double-booking. A non-empty room → **409 CONFLICT**; a room
  from another property/tenant → **404 NOT_FOUND** (cannot touch cross-tenant data).
- **No `roomId`** → a **room-less inquiry lead** is created (no room reserved). Documented behaviour.
- **Honeypot:** if `_hp` is **filled (non-empty)** the request is rejected as spam — a non-empty value
  fails Zod validation (**422**) so **no booking is created**. (An empty string / absent `_hp` is the
  legitimate path.) The controller also returns a **fake 200** for any honeypot-style submission it
  short-circuits, never revealing detection.
- **No `tenantId`/`propertyId`/`source` accepted in the body** — the schema is `.strict()`, so any
  forged ownership field → **422 VALIDATION_ERROR**. The tenant/property come from the slug only.
- Rate-limit exceeded → **429 RATE_LIMITED** (standard `{ success:false, code:"RATE_LIMITED" }`).
- Slug unknown/disabled → **404** (resolved before any write).

---

# Public API + API Keys (PRD Modul 22 — Premium-only)

Third-party programmatic access to a tenant's data, authenticated by **per-tenant API keys** (not
JWT). Two surfaces:

1. **Management** — `/api/v1/api-keys/*` (dashboard, JWT-authed, **Owner-only**, **Premium-gated**):
   create / list / revoke / delete keys.
2. **External API** — `/api/ext/v1/*` (**key-authed**, mounted OUTSIDE the JWT router): read-focused,
   scope-enforced, tenant-scoped. Same serialized shapes as the dashboard API.

> **Premium-only.** `apiAccess` is a **Premium** plan feature (Basic ❌ / Pro ❌ / Premium ✅). It is
> surfaced in `GET /api/v1/subscription` → `features.apiAccess`. The demo tenant is **Pro**, so it
> sees the upgrade gate (correct). Both surfaces enforce the plan: management → **403 `FORBIDDEN`**,
> external API → **403 `PLAN_LIMIT_EXCEEDED`** (so downgrading off Premium instantly disables keys).

## Key format & security

- Full key: **`kos_live_<40 base62 chars>`** (e.g. `kos_live_Ab12Cd34…`).
- Stored: **only `sha256(fullKey)`** (`keyHash`, unique) + a short visible **`keyPrefix`** (e.g.
  `kos_live_Ab12`) for display. **The plaintext is NEVER persisted.**
- The **full plaintext key is returned exactly ONCE** in the create response and can never be
  retrieved again (hash-once / show-once). Store it securely on receipt.

## Scopes

`properties:read`, `rooms:read`, `residents:read`, `invoices:read`, `bookings:read`, `bookings:write`.
A request whose key lacks the required scope → **403 `FORBIDDEN`**.

---

## Management endpoints (JWT, Owner-only, Premium)

### `GET /api/v1/api-keys`
List the tenant's keys. **Never** returns the secret/hash.
```json
{ "success": true, "data": [
  { "id": "uuid", "name": "CI key", "keyPrefix": "kos_live_Ab12",
    "scopes": ["properties:read","rooms:read"], "status": "active",
    "isActive": true, "lastUsedAt": "2026-06-14T04:00:00.000Z",
    "expiresAt": null, "revokedAt": null, "createdByUserId": "uuid",
    "createdAt": "2026-06-14T03:00:00.000Z" } ] }
```
`status` ∈ `active | revoked | expired` (computed).

### `POST /api/v1/api-keys`  → returns the full key ONCE
Premium-only (→ **403 FORBIDDEN** on Basic/Pro). Owner-only (→ **403** for manager/admin/finance).
Request:
```json
{ "name": "CI key", "scopes": ["properties:read","rooms:read","bookings:write"],
  "expiresAt": "2027-01-01T00:00:00.000Z" }
```
- `name` 2–100 chars. `scopes` non-empty subset of the scope list (de-duped). `expiresAt` optional
  future ISO timestamp.
Response **201** (note the one-time `key`):
```json
{ "success": true, "data": {
  "id": "uuid", "name": "CI key", "keyPrefix": "kos_live_Ab12",
  "scopes": ["properties:read","rooms:read","bookings:write"], "status": "active",
  "isActive": true, "lastUsedAt": null, "expiresAt": "2027-01-01T00:00:00.000Z",
  "revokedAt": null, "createdAt": "2026-06-14T03:00:00.000Z",
  "key": "kos_live_Ab12Cd34Ef56…"        // ← shown ONCE, never returned again
} }
```

### `POST /api/v1/api-keys/:id/revoke`
Revoke a key (idempotent). Sets `isActive=false`, `revokedAt=now`. The key then fails the external
API with **401**. Returns the updated (secret-free) key with `status:"revoked"`.

### `DELETE /api/v1/api-keys/:id`
Hard-delete a key. `{ "success": true, "data": { "id": "uuid", "deleted": true } }`.

All mutations are audited (`api_key.create` / `api_key.revoke` / `api_key.delete`).

---

## External API (`/api/ext/v1`, API-key auth)

**Auth:** send the key as `Authorization: Bearer kos_live_…` **or** `X-API-Key: kos_live_…`.
Invalid / revoked / expired / malformed → **401 `UNAUTHENTICATED`**. Non-Premium tenant → **403
`PLAN_LIMIT_EXCEEDED`**. Every request runs inside the key's tenant context (auto tenant-scoped).

**Rate limit:** a **per-key** limit (default **120 req/min/key**, env `API_KEY_RATE_LIMIT_MAX` /
`API_KEY_RATE_LIMIT_WINDOW_MS`), separate from the global per-IP limiter → **429 `RATE_LIMITED`**.

**CORS:** permissive (any origin, credential-less) — keys travel in a header, not a cookie.

| Method & path | Scope | Notes |
|---|---|---|
| `GET /api/ext/v1/me` | — (any valid key) | `{ apiKeyId, tenantId, scopes }` — connectivity test |
| `GET /api/ext/v1/properties` | `properties:read` | paginated list |
| `GET /api/ext/v1/properties/:id` | `properties:read` | detail + stats |
| `GET /api/ext/v1/rooms` | `rooms:read` | filters: `property_id`, `status`, `room_type` |
| `GET /api/ext/v1/rooms/:id` | `rooms:read` | detail + occupancy history |
| `GET /api/ext/v1/residents` | `residents:read` | **NIK masked** (`nikMasked` only) |
| `GET /api/ext/v1/residents/:id` | `residents:read` | **NIK NEVER decrypted** (no `nik` field) |
| `GET /api/ext/v1/invoices` | `invoices:read` | filters: status/property/resident/period/overdue |
| `GET /api/ext/v1/invoices/:id` | `invoices:read` | detail + items + payments |
| `GET /api/ext/v1/bookings` | `bookings:read` | paginated list |
| `GET /api/ext/v1/bookings/:id` | `bookings:read` | detail |
| `POST /api/ext/v1/bookings` | `bookings:write` | reuses the internal booking-create service |

All list endpoints use the standard paginated envelope `{ success, data, meta:{page,limit,total,totalPages} }`.

### `GET /api/ext/v1/me`
```
curl -H "Authorization: Bearer kos_live_Ab12…" http://localhost:4000/api/ext/v1/me
```
```json
{ "success": true, "data": { "apiKeyId": "uuid", "tenantId": "uuid",
  "scopes": ["properties:read","rooms:read","bookings:write"] } }
```

### `GET /api/ext/v1/residents` (NIK masking)
```json
{ "success": true, "data": [
  { "id": "uuid", "fullName": "Penghuni A", "nikMasked": "************0001",
    "phone": "0812…", "status": "active", "monthlyRent": 1000000 } ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 } }
```
The raw 16-digit NIK is **never** present in any external response (list or detail).

### `POST /api/ext/v1/bookings` (`bookings:write`)
Request (same schema as the dashboard `POST /bookings`):
```json
{ "roomId": "uuid", "prospectName": "Calon API", "prospectPhone": "0812…",
  "plannedCheckInDate": "2026-06-21", "bookingFeeAmount": 0, "bookingFeeMethod": "cash" }
```
Room must exist & be `empty` (else **409 CONFLICT**); a room from another tenant → **404**. Response
**201** with the created booking (`status:"pending"`, `recordedByUserId:null` for API-created bookings).
