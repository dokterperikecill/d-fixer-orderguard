# Checklist Keamanan Staging

**Status: belum dijalankan.** Isi kolom bukti saat verifikasi staging.

## 1. Isolasi dan akses

- [ ] Project/workspace staging terpisah dari produksi. Bukti: `<...>`
- [ ] Database staging terpisah; tidak ada koneksi ke database produksi. Bukti: `<...>`
- [ ] Bucket backup staging terpisah. Bukti: `<...>`
- [ ] Domain staging terpisah dan tidak diindeks mesin pencari. Bukti: `<...>`
- [ ] Cloudflare Access/Zero Trust atau IP allowlist aktif. Bukti: `<...>`
- [ ] Tidak ada akses publik tanpa autentikasi tambahan. Bukti: `<...>`
- [ ] Akses operator menggunakan akun individual, bukan akun bersama. Bukti: `<...>`

## 2. Kredensial dan secret

- [ ] Tidak ada kredensial produksi di environment staging. Bukti: `<...>`
- [ ] `ORDERGUARD_BOOTSTRAP_PASSWORD` dihapus setelah bootstrap. Bukti: `<...>`
- [ ] `ORDERGUARD_BACKUP_ENCRYPTION_KEY` staging berbeda dari produksi. Bukti: `<...>`
- [ ] `ORDERGUARD_TOKEN_ENCRYPTION_KEY` staging berbeda dari produksi. Bukti: `<...>`
- [ ] AWS IAM staging hanya memiliki izin bucket staging (least privilege). Bukti: `<...>`
- [ ] Secret tidak ada di repository, screenshot, atau log. Bukti: `<...>`
- [ ] Secret manager/platform masking aktif. Bukti: `<...>`
- [ ] Rotasi secret terdokumentasi dan diuji. Bukti: `<...>`

## 3. Jaringan dan TLS

- [ ] HTTPS aktif dengan sertifikat valid. Bukti: `<...>`
- [ ] HTTP dialihkan ke HTTPS. Bukti: `<...>`
- [ ] HSTS aktif (`NODE_ENV=production`). Bukti: `<...>`
- [ ] Database menggunakan TLS (`sslmode=require`). Bukti: `<...>`
- [ ] Database tidak terbuka publik kecuali melalui private network/allowlist. Bukti: `<...>`
- [ ] `ORDERGUARD_TRUST_PROXY=1` hanya di belakang proxy tepercaya. Bukti: `<...>`
- [ ] `ORDERGUARD_ALLOWED_ORIGINS` berisi origin staging eksak, tanpa wildcard. Bukti: `<...>`

## 4. Aplikasi

- [ ] Cookie sesi: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. Bukti: `<...>`
- [ ] CSRF token wajib pada POST/PATCH/DELETE. Bukti: `<...>`
- [ ] Origin/Referer asing ditolak 403. Bukti: `<...>`
- [ ] Login rate limit bekerja (429 setelah batas). Bukti: `<...>`
- [ ] Akun demo tidak aktif. Bukti: `<...>`
- [ ] Bootstrap admin menggunakan password acak 20+ karakter. Bukti: `<...>`
- [ ] Security headers: CSP, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`. Bukti: `<...>`
- [ ] Error 500 tidak membocorkan stack trace/secret. Bukti: `<...>`
- [ ] `ORDERGUARD_TEST_USERS` dan `ORDERGUARD_TEST_SEED_DEMO` tidak diatur. Bukti: `<...>`

## 5. Data dan privasi

- [ ] Hanya data sintetis; tidak ada data pelanggan produksi. Bukti: `<...>`
- [ ] Bukti foto tidak berisi data pribadi nyata. Bukti: `<...>`
- [ ] Akses tenant diverifikasi: store-admin tidak bisa melihat tenant lain. Bukti: `<...>`
- [ ] Super-admin lintas tenant disengaja dan terbatas. Bukti: `<...>`
- [ ] Audit login dan perubahan tersedia. Bukti: `<...>`
- [ ] Retensi quarantine dan backup sesuai kebijakan. Bukti: `<...>`

## 6. Backup dan recovery

- [ ] Backup terenkripsi AES-256-GCM. Bukti: `<...>`
- [ ] `ORDERGUARD_BACKUP_ALLOW_PLAINTEXT` tidak diatur. Bukti: `<...>`
- [ ] Bucket versioning aktif. Bukti: `<...>`
- [ ] Bucket encryption default aktif. Bukti: `<...>`
- [ ] Block Public Access aktif. Bukti: `<...>`
- [ ] Lifecycle retention sesuai kebijakan (mis. 90 hari). Bukti: `<...>`
- [ ] Checksum ciphertext/plaintext tersimpan. Bukti: `<...>`
- [ ] Restore drill ke database terpisah lulus. Bukti: `<...>`
- [ ] Jumlah baris penting cocok dengan metadata. Bukti: `<...>`
- [ ] Backup gagal memicu alert. Bukti: `<...>`

## 7. Database

- [ ] PostgreSQL version sesuai produksi. Bukti: `<...>`
- [ ] Tidak ada extension tidak dikenal. Bukti: `<...>`
- [ ] App user memiliki izin minimum yang diperlukan. Bukti: `<...>`
- [ ] Connection pool (max 10) sesuai batas koneksi database. Bukti: `<...>`
- [ ] Automated backup/PITR aktif bila tersedia. Bukti: `<...>`
- [ ] Audit integritas dan validasi constraint dijalankan. Bukti: `<...>`
- [ ] Tidak ada referensi lintas tenant. Bukti: `<...>`

## 8. Monitoring dan insiden

- [ ] Health check `/api/health` dipantau. Bukti: `<...>`
- [ ] Log aplikasi tersedia dan tidak memuat secret. Bukti: `<...>`
- [ ] Alert backup/off-site gagal. Bukti: `<...>`
- [ ] Alert error rate/health gagal. Bukti: `<...>`
- [ ] Prosedur insiden dan kontak darurat tersedia. Bukti: `<...>`
- [ ] Rollback drill berhasil. Bukti: `<...>`

## 9. Larangan staging

- [ ] Tidak ada deploy produksi dari pipeline staging. Bukti: `<...>`
- [ ] Tidak ada merge ke `main`. Bukti: `<...>`
- [ ] Tidak ada data produksi disalin ke staging. Bukti: `<...>`
- [ ] Tidak ada kredensial produksi digunakan. Bukti: `<...>`
- [ ] Tidak ada penghapusan data di luar database staging. Bukti: `<...>`
