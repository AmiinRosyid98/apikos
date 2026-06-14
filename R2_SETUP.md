# Setup Cloudflare R2 (Penyimpanan File) — KosManager

Panduan mengaktifkan penyimpanan file nyata (KTP, selfie, foto kamar, bukti bayar, foto meteran,
foto check-in/out, tanda tangan, logo) memakai **Cloudflare R2** (object storage, S3-compatible).

> Tanpa konfigurasi ini aplikasi tetap jalan di **mode demo/stub**: upload tidak benar-benar
> tersimpan. Setelah keempat env utama (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
> `R2_ENDPOINT`) terisi, `r2Configured` otomatis `true` dan upload jadi nyata — tanpa ubah kode.

---

## Kenapa R2?

- Database tidak cocok untuk file binary besar; disk server lokal tidak skalabel.
- R2 murah, S3-compatible, dan **egress gratis selamanya**.
- **Free tier per bulan:** 10 GB penyimpanan · 1 juta operasi tulis · 10 juta operasi baca.
  Untuk kos 5–100 kamar realistis **Rp0** (10 GB ≈ ~2.000 penyewa worth of files).
- Catatan: daftar R2 butuh **verifikasi kartu kredit/debit** (tidak ditagih selama dalam batas
  gratis). Angka pricing bisa berubah — cek halaman pricing Cloudflare R2 untuk yang terbaru.

---

## 1. Daftar & aktifkan R2

1. Login ke <https://dash.cloudflare.com> (daftar dulu kalau belum punya akun — gratis).
2. Sidebar kiri → klik **R2 Object Storage**.
3. Klik **Enable R2** → diminta **verifikasi kartu kredit/debit** (wajib, tidak ditagih selama
   dalam batas gratis).

## 2. Buat bucket

1. Klik **Create bucket**.
2. Nama bucket, misal: `kosmanager-files`.
3. Location: **Automatic** (atau pilih APAC biar dekat Indonesia).
4. Klik **Create bucket**.

## 3. Ambil Account ID

- Di halaman R2 Overview, panel kanan ada **Account ID** → catat (dipakai untuk `R2_ACCOUNT_ID`
  dan untuk menyusun endpoint).

## 4. Buat API Token

1. Di halaman R2 → klik **Manage R2 API Tokens** (pojok kanan atas) → **Create API Token**.
2. Permission: pilih **Object Read & Write**.
3. Bucket: pilih **Apply to specific buckets only** → pilih `kosmanager-files` (lebih aman).
4. Klik **Create API Token**.
5. Muncul **sekali saja** — catat keduanya:
   - **Access Key ID**
   - **Secret Access Key** (tidak bisa dilihat lagi setelah halaman ini ditutup!)

## 5. Set CORS di bucket

1. Buka bucket `kosmanager-files` → tab **Settings**.
2. Scroll ke **CORS Policy** → klik **Edit** / **Add CORS policy**.
3. Paste isi dari [`r2-cors.json`](./r2-cors.json) → **Save**.

> CORS mengizinkan browser meng-upload langsung ke R2. Tanpa ini, upload dari frontend gagal
> (error CORS). Tambahkan origin domain produksi ke `r2-cors.json` saat sudah deploy.

## 6. Isi `.env` (apikos)

Buka [`.env`](./.env), isi:

```
R2_ACCOUNT_ID=<Account ID dari langkah 3>
R2_ACCESS_KEY_ID=<Access Key ID dari langkah 4>
R2_SECRET_ACCESS_KEY=<Secret Access Key dari langkah 4>
R2_BUCKET=kosmanager-files
R2_ENDPOINT=https://<Account ID>.r2.cloudflarestorage.com
R2_PUBLIC_BASE_URL=
```

- `R2_ENDPOINT` = `https://` + Account ID + `.r2.cloudflarestorage.com`.
- `R2_PUBLIC_BASE_URL` biarkan **kosong** dulu (opsional; untuk menyajikan file publik seperti foto
  kamar/logo lewat URL CDN permanen daripada presigned GET).

## 7. Restart & tes

1. Stop lalu jalankan ulang `npm run dev` di `apikos`.
2. Login ke aplikasi → coba **tambah penyewa + upload foto KTP**.
3. Bila berhasil, file muncul di bucket (Cloudflare dashboard → bucket → tab **Objects**).

---

## Cek cepat R2 sudah aktif

- Response `POST /files/presign-upload` **tidak lagi** mengandung field `_note` "STUB".
- `uploadUrl` berdomain `*.r2.cloudflarestorage.com` (bukan `PLACEHOLDER.r2.local`).

## Privat vs publik (cara kerja di kode)

- **Privat** (`ktp`, `selfie`): selalu disajikan lewat **presigned GET** berumur 15 menit.
- **Publik** (`room_photo`, `logo`, `payment_proof`): jika `R2_PUBLIC_BASE_URL` diisi → URL CDN
  permanen; jika kosong → presigned GET juga.
- Yang disimpan di database hanyalah **key** (mis. `tenants/<id>/ktp/<uuid>.jpg`), bukan filenya.
- Otorisasi download dibatasi per-tenant (key tenant lain → 404).

## Bagian kode terkait

- [`src/config/r2.ts`](./src/config/r2.ts) — S3 client untuk R2.
- [`src/config/env.ts`](./src/config/env.ts) — validasi env + flag `r2Configured`.
- [`src/modules/files/files.service.ts`](./src/modules/files/files.service.ts) — presign upload/download.
- Frontend: `kos/src/hooks/use-files.ts` — flow upload presigned + error handling.

## Troubleshooting

- **Upload gagal / error CORS** → CORS policy belum dipasang atau origin frontend belum terdaftar
  di `r2-cors.json` (default: `http://localhost:3100`, `http://localhost:3000`).
- **403 / SignatureDoesNotMatch** → kredensial salah, atau jam sistem server tidak akurat.
- **Masih "mode demo"** → salah satu dari empat env utama masih kosong, atau server belum di-restart.
- **NoSuchBucket** → `R2_BUCKET` tidak cocok dengan nama bucket di dashboard.
