# Keamanan OrderGuard

Dokumen ini menjelaskan kontrol autentikasi dan perlindungan API yang berlaku setelah hardening Gelombang 1.

## 1. Autentikasi dan Cookie Sesi

- Autentikasi memakai cookie `orderguard_session`.
- Cookie sesi memiliki atribut:
  - `HttpOnly`
  - `SameSite=Lax`
  - `Secure` saat `NODE_ENV=production`
  - `Path=/`
  - masa berlaku `ORDERGUARD_SESSION_HOURS` (default 8 jam)
- Token sesi dibuat acak dengan `crypto.randomBytes(32)` dan hanya hash SHA-256 yang disimpan di database.
- Setiap login membuat token sesi baru sehingga tidak ada session fixation dari token lama.
- Logout menghapus sesi aktif dan cookie sesi/CSRF.
- Perubahan password, role, tenant, atau penonaktifan akun mencabut sesi lain pengguna tersebut.
- Session kedaluwarsa dihapus saat diakses dan dicatat sebagai `SESSION_EXPIRED`.

## 2. CSRF Protection

Aplikasi memakai **session-bound CSRF token**:

1. Login atau `GET /api/session` mengembalikan `csrfToken`.
2. Client wajib mengirim token pada setiap request state-changing:
   ```http
   X-CSRF-Token: <csrfToken>
   ```
3. Server membandingkan token dengan hash/token sesi aktif; token dari sesi lain ditolak.
4. Request tanpa token, token salah, atau token sesi lain menghasilkan:
   ```json
   { "error": "CSRF token tidak valid atau tidak tersedia.", "code": "CSRF_INVALID" }
   ```
   dengan status `403`.

Endpoint yang dilindungi: `POST`, `PATCH`, dan `DELETE` pada `/api/tenants`, `/api/users`, `/api/tiktok/sync`, `/api/order-events`, `/api/state`, serta logout untuk sesi yang aktif.

`POST /api/login` tidak memakai CSRF token karena belum ada sesi, tetapi tetap dilindungi Origin/Referer dan rate limiting.

Frontend membaca `csrfToken` dari response login/session dan mengirimkannya otomatis melalui helper `apiFetch`.

## 3. Origin dan Referer

- Request state-changing dari browser divalidasi terhadap origin aplikasi.
- Same-origin selalu diizinkan.
- Origin tambahan dapat didaftarkan melalui environment:
  ```sh
  ORDERGUARD_ALLOWED_ORIGINS="https://app.domainanda.com"
  ```
  Pisahkan beberapa origin dengan koma. **Wildcard `*` tidak diizinkan** dan akan menggagalkan startup.
- Format harus origin saja, tanpa path/query, misalnya:
  ```text
  https://app.domainanda.com
  https://admin.domainanda.com
  ```
- Jika `ORDERGUARD_ALLOWED_ORIGINS` tidak diisi, hanya same-origin yang diterima.
- Origin/Referer yang tidak tepercaya menghasilkan status `403` dengan kode `ORIGIN_REJECTED`.
- Di belakang reverse proxy (Render), atur:
  ```sh
  ORDERGUARD_TRUST_PROXY=1
  ```
  agar `Origin` dan IP client dibaca dengan benar. Default di production adalah `1`.

## 4. Login Rate Limiting

Rate limit disimpan di PostgreSQL, bukan hanya memori proses.

Environment:

| Variable | Default | Keterangan |
|---|---:|---|
| `ORDERGUARD_LOGIN_WINDOW_MINUTES` | `15` | Jendela hitung percobaan |
| `ORDERGUARD_LOGIN_MAX_ATTEMPTS` | `5` | Maksimum gagal per username+IP dalam jendela |
| `ORDERGUARD_LOGIN_MAX_IP_ATTEMPTS` | `20` | Maksimum gagal per IP dalam jendela |

Perilaku:

- Percobaan gagal dicatat di `login_attempts`.
- Setelah batas terlampaui, login berikutnya menghasilkan `429`:
  ```json
  { "error": "Terlalu banyak percobaan login. Coba lagi nanti.", "code": "LOGIN_RATE_LIMITED" }
  ```
  dengan header `Retry-After: 60`.
- Tidak ada status akun terkunci permanen; batas berlaku per jendela waktu dan per kombinasi username+IP/IP.
- Login berhasil menghapus kegagalan untuk kombinasi username+IP tersebut.
- Rate limit tidak membocorkan apakah username ada atau tidak.

Rate limit hanya melindungi endpoint login. Untuk endpoint API lain, gunakan rate limit di reverse proxy/WAF bila tersedia.

## 5. Authentication Audit Log

Tabel `auth_audit` mencatat:

- `LOGIN_SUCCESS`
- `LOGIN_FAILED`
- `LOGIN_BLOCKED`
- `LOGOUT`
- `SESSION_EXPIRED`
- `SESSION_INVALID`
- `CREDENTIAL_CHANGED`
- `ACCOUNT_UPDATED`
- `ACCOUNT_DEACTIVATED`
- `SESSIONS_REVOKED`

Kolom: `user_id`, `username`, `tenant_id`, `action`, `ip_hash`, `metadata`, `created_at`.

Aturan:

- Password, session token, CSRF token, dan secret **tidak pernah** disimpan di audit.
- IP disimpan sebagai hash SHA-256, bukan alamat mentah.
- `metadata` saat ini berisi objek kosong; jangan menambahkan data rahasia ke kolom ini.
- Audit autentikasi terpisah dari `tenant_state` dan `tenant_audit`.

Contoh query operasional:

```sql
SELECT created_at, action, username, tenant_id, ip_hash
FROM auth_audit
ORDER BY created_at DESC
LIMIT 100;
```

## 6. Password Policy

- User baru dan perubahan password minimal **10 karakter**, maksimal 200.
- Bootstrap Platform Admin tetap minimal **12 karakter**.
- Hashing memakai `scrypt` dengan salt acak per user.
- Password tidak pernah dicatat di log, audit, response API, atau pesan error.

## 7. API Client

API client non-browser harus:

1. `POST /api/login` atau `GET /api/session` untuk memperoleh `csrfToken`.
2. Menyimpan cookie sesi.
3. Mengirim `X-CSRF-Token` pada setiap request `POST`/`PATCH`/`DELETE`.
4. Mengirim `Origin`/`Referer` yang sesuai bila client berjalan di browser.

Contoh:

```http
POST /api/state
Cookie: orderguard_session=...
Content-Type: application/json
X-CSRF-Token: ...
If-Match: "state-12"
```

## 8. Deployment Checklist

- [ ] Set `NODE_ENV=production`.
- [ ] Set `DATABASE_URL` sebagai secret.
- [ ] Set `ORDERGUARD_BOOTSTRAP_*` hanya saat database kosong.
- [ ] Set `ORDERGUARD_ALLOWED_ORIGINS` ke origin HTTPS produksi (tanpa wildcard).
- [ ] Set `ORDERGUARD_TRUST_PROXY=1` di Render/reverse proxy.
- [ ] Pastikan HTTPS aktif; cookie sesi memakai `Secure`.
- [ ] Jangan nonaktifkan CSRF/Origin check di production.
- [ ] Monitor `/api/ready` (readiness) dan `/api/health` (liveness); jangan memakai `/api/health` sebagai satu-satunya indikator database.
- [ ] Set `ORDERGUARD_METRICS_TOKEN` bila metrik Prometheus akan di-scrape; biarkan kosong untuk menonaktifkan endpoint.
- [ ] Set `ORDERGUARD_ALERT_WEBHOOK_URL` agar kegagalan backup/restore/healthcheck terkirim.
- [ ] Pastikan log JSON tidak memuat cookie, token, password, atau body request sensitif.
- [ ] Uji graceful shutdown: `SIGTERM` harus menyelesaikan request in-flight dan keluar `0`.
- [ ] Backup dan restore diuji sebelum operasional.
- [ ] Monitor `auth_audit` untuk lonjakan `LOGIN_FAILED`/`LOGIN_BLOCKED`.

## 9. Batas yang Belum Ditangani

- Belum ada MFA.
- Belum ada password reset mandiri.
- Belum ada session management UI untuk mencabut semua perangkat.
- Rate limit login belum menggunakan shared cache di luar PostgreSQL; PostgreSQL sudah shared antar-instance.
- Audit autentikasi belum memiliki retensi/arsip otomatis.
