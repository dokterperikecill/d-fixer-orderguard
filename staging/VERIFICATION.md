# Checklist Verifikasi Staging

**Status: rehearsal staging dieksekusi 2026-11-11 di VPS (nginx TLS + PostgreSQL terpisah); deployment staging Render BELUM dijalankan.**
Hasil lengkap: [`staging/EXECUTION-2026-11-11.md`](EXECUTION-2026-11-11.md).

Checklist ini tetap menjadi sumber kebenaran. Item yang sudah diverifikasi pada rehearsal ditandai di laporan eksekusi; item fungsional penuh (impor, scan, handover, evidence, quarantine, laporan), TikTok Shop, Cloudflare Access, dan deployment Render masih harus dijalankan pada staging sungguhan.

Baseline yang sudah ada (bukan verifikasi staging):

- CI commit `4a0a030a176c5dbd3dd1672bbea0a4b21affa625`: backend 55 test, E2E 8/8, load 650 transaksi/0 error.
- Baseline ini dijalankan pada database test lokal/CI, bukan staging.

## 1. Pra-provisioning

- [ ] Project staging terpisah dibuat.
- [ ] PostgreSQL staging dibuat dan versinya dicatat.
- [ ] Bucket backup staging dibuat (versioning, encryption, lifecycle).
- [ ] IAM staging least privilege dibuat.
- [ ] Domain staging dan TLS siap.
- [ ] Cloudflare Access/IP allowlist aktif.
- [ ] Secret staging lengkap dan tidak berasal dari produksi.
- [ ] Rencana biaya disetujui.

## 2. Deploy pertama

- [ ] CI hijau pada SHA yang akan di-deploy.
- [ ] Deploy manual dari SHA dicatat.
- [ ] Health check `/api/ready` mengembalikan `status: ready` dan `database: ok`.
- [ ] Log startup tidak menunjukkan error migrasi.
- [ ] `/api/config` merespons.
- [ ] Bootstrap admin berhasil.
- [ ] `ORDERGUARD_BOOTSTRAP_PASSWORD` dihapus setelah bootstrap.
- [ ] Tidak ada akun demo aktif.
- [ ] Tenant staging kedua dan user staging dibuat.

## 3. Fungsional

- [ ] Login benar berhasil; login salah gagal.
- [ ] Logout menghapus session.
- [ ] Store-admin hanya melihat tenant sendiri.
- [ ] Super-admin dapat melihat tenant yang diizinkan.
- [ ] Import CSV/XLSX menghasilkan manifest tervalidasi.
- [ ] Scan resi valid menghasilkan `MATCH`.
- [ ] Scan duplikat menghasilkan `DUPLICATE_SCAN`.
- [ ] Scan di luar manifest menghasilkan `NOT_IN_MANIFEST`.
- [ ] Handover menyimpan penerima, item, waktu, dan evidence.
- [ ] Evidence foto dapat ditampilkan.
- [ ] Penutupan manifest bekerja.
- [ ] Laporan rekonsiliasi tampil.
- [ ] Quarantine list/detail/recovery bekerja.
- [ ] Quarantine tenant lain tidak terlihat oleh store-admin.
- [ ] PWA service worker aktif dan cache v10 digunakan.
- [ ] Upgrade cache v9 → v10 menghapus cache lama.

## 4. Keamanan

- [ ] Cookie sesi `Secure`, `HttpOnly`, `SameSite=Lax`.
- [ ] HSTS ada pada respons HTTPS.
- [ ] CSP dan `X-Frame-Options: DENY` ada.
- [ ] Origin asing ditolak 403.
- [ ] Request POST tanpa CSRF ditolak 403.
- [ ] Login rate limit menghasilkan 429 setelah batas.
- [ ] Tidak ada wildcard pada `ORDERGUARD_ALLOWED_ORIGINS`.
- [ ] `ORDERGUARD_TEST_USERS`/`ORDERGUARD_TEST_SEED_DEMO` tidak ada.
- [ ] Secret tidak terlihat di log.
- [ ] `npm audit` ditinjau; tidak ada critical/high yang tidak diterima.

## 5. Backup dan restore

- [ ] `npm run db:backup:check` lulus di runner staging.
- [ ] Backup terenkripsi dibuat.
- [ ] Objek `.dump.enc`, `.meta.json`, `.sha256` ada di bucket staging.
- [ ] Checksum dapat diverifikasi.
- [ ] Restore ke database staging terpisah berhasil.
- [ ] Jumlah baris penting cocok dengan metadata.
- [ ] Konsistensi user/tenant/TikTok/quarantine lulus.
- [ ] Restore dengan key salah ditolak.
- [ ] Ciphertext termodifikasi ditolak.
- [ ] Backup gagal memicu alert.
- [ ] Retensi backup berjalan.

## 6. Rollback drill

- [ ] Deploy versi N.
- [ ] Deploy versi N+1.
- [ ] Rollback aplikasi ke N.
- [ ] Health dan smoke test setelah rollback lulus.
- [ ] Restore backup pra-deploy ke DB terpisah lulus.
- [ ] Waktu rollback dicatat.
- [ ] Tidak ada data produksi tersentuh.

## 7. Observability

- [ ] Health check uptime monitor aktif.
- [ ] Log error terlihat di dashboard.
- [ ] Alert error rate/health gagal aktif.
- [ ] Alert backup gagal aktif.
- [ ] Dashboard/runbook tersedia untuk operator.

## 8. Kesenjangan yang harus diselesaikan sebelum eksekusi staging

- [x] **Staging browser E2E harness.** `playwright.staging.config.js` menargetkan `STAGING_BASE_URL` tanpa `webServer` dan tanpa seeding demo (`npm run e2e:staging`).
- [x] **Staging load harness.** `scripts/load-test.js --external` menjalankan load read-only ke `LOAD_TEST_BASE_URL` (`npm run load:staging`).
- [ ] **Backup runner image.** Render native cron belum tentu memiliki `pg_dump`, `aws`, atau `rclone`; gunakan Docker cron (`ops/backup/Dockerfile`) atau GitHub Actions scheduled. Konfigurasi sudah disediakan, build/deploy belum diverifikasi.
- [ ] **PostgreSQL major version.** Konfirmasi versi produksi dan pin staging ke major yang sama.
- [ ] **Cloudflare Access policy.** Definisikan siapa yang boleh mengakses staging.
- [ ] **Alert channel.** Tentukan tujuan alert (email/Slack/WhatsApp) dan penanggung jawab.

## Perintah verifikasi awal

```sh
curl -fsS "https://<staging-host>/api/health"
curl -fsS "https://<staging-host>/api/config"
curl -sSI "https://<staging-host>/" | grep -iE "strict-transport|content-security|x-frame"
```

Periksa cookie setelah login:

```sh
curl -sS -D - -o /dev/null \
  -H "Content-Type: application/json" \
  -d '{"username":"<staging-user>","password":"<staging-password>"}' \
  "https://<staging-host>/api/login"
```

Cari `Set-Cookie` dengan `HttpOnly`, `Secure`, `SameSite=Lax`.

## Kriteria keluar

Staging dinyatakan siap untuk verifikasi lanjutan hanya jika:

- Semua item fungsional, keamanan, backup, dan rollback di atas lulus dengan bukti.
- Tidak ada critical/high security finding yang terbuka.
- Backup dan restore drill berhasil.
- Rollback drill berhasil.
- Hasil tercatat pada SHA/deploy yang benar.
- Tidak ada pelanggaran batasan (main, merge, deploy produksi, data produksi, kredensial produksi).
