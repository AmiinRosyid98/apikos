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
→ { plan, status, expiresAt, limits:{maxProperties,maxRooms,maxUsers}, usage:{properties,rooms,users}, features:{whatsapp,paymentGateway,reports} }
POST /subscription/change-plan { "plan":"pro" } → { plan, limits, status }   // MVP-1: updates caps only, no payment
```
Plan caps: basic (1/20/2), pro (5/150/10), premium (50/2000/100). `planGuard` returns 403 `PLAN_LIMIT_EXCEEDED` on create when usage ≥ cap.

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
