# Prosedur Deployment Staging

**Status: prosedur belum dijalankan.** Dokumen ini hanya rencana.

## Prasyarat

- [ ] Audit staging disetujui.
- [ ] Project/workspace Render staging terpisah dari produksi.
- [ ] Database PostgreSQL staging aktif, TLS, private network.
- [ ] Bucket object storage staging aktif (versioning, encryption, lifecycle).
- [ ] Secret staging lengkap dan tidak memakai kredensial produksi.
- [ ] Cloudflare Access/IP allowlist aktif.
- [ ] CI pada commit yang akan deploy berstatus hijau.
- [ ] Backup staging terbaru sudah diverifikasi.
- [ ] Deployment window dan penanggung jawab disepakati.

## Identitas rilis

Catat sebelum deploy:

| Field | Nilai |
|---|---|
| Branch | `fix/wave-2.3-staging-verification` |
| Commit SHA | `<sha-yang-di-deploy>` |
| CI run URL | `<url>` |
| Deploy ID | `<render-deploy-id>` |
| Waktu deploy | `<ISO-8601>` |
| Operator | `<nama>` |
| Perubahan utama | `<ringkasan>` |

## Langkah deploy

1. **Pastikan branch/commit bersih dan CI hijau.**
   ```sh
   git fetch origin
   git checkout fix/wave-2.3-staging-verification
   git rev-parse HEAD
   gh run list --commit "$(git rev-parse HEAD)" --limit 3
   ```
   Jangan deploy jika CI belum sukses pada SHA tersebut.

2. **Buat backup pra-deploy database staging.**
   ```sh
   DATABASE_URL="$STAGING_DATABASE_URL" \
   ORDERGUARD_BACKUP_ENCRYPTION_KEY="$ORDERGUARD_BACKUP_ENCRYPTION_KEY" \
   ORDERGUARD_BACKUP_DIR=/tmp/orderguard-pre-deploy \
   npm run db:backup
   ```
   Simpan path backup dan checksum di catatan rilis.

3. **Verifikasi backup preflight dan restore drill terakhir.**
   ```sh
   DATABASE_URL="$STAGING_DATABASE_URL" \
   ORDERGUARD_BACKUP_ENCRYPTION_KEY="$ORDERGUARD_BACKUP_ENCRYPTION_KEY" \
   ORDERGUARD_BACKUP_DIR=/tmp/orderguard-pre-deploy \
   npm run db:backup:check
   ```
   Restore drill dilakukan ke database staging terpisah, bukan ke database staging utama.

4. **Deploy manual dari Render.**
   - Buka service staging.
   - Pilih **Manual Deploy** pada commit yang sudah dicatat.
   - Jangan mengaktifkan auto-deploy.
   - Tunggu build selesai dan health check `/api/health` lulus.

5. **Periksa startup dan migrasi.**
   - Log harus menunjukkan koneksi PostgreSQL dan server berjalan.
   - Tidak boleh ada error migrasi, constraint, atau bootstrap.
   - Migrasi bersifat additive; jika startup gagal, jangan ulangi deploy secara buta. Ikuti rollback.

6. **Bootstrap hanya jika database kosong.**
   - Pastikan `ORDERGUARD_BOOTSTRAP_*` diisi sebelum deploy pertama.
   - Setelah admin pertama berhasil login, hapus `ORDERGUARD_BOOTSTRAP_PASSWORD` dari environment.
   - Jangan biarkan password bootstrap tersimpan permanen.

7. **Siapkan data sintetis.**
   - Buat tenant staging kedua (misalnya `maya-commerce`) melalui API tenant sebagai super-admin.
   - Buat user store-admin/handover-staff staging.
   - Jangan memakai user, tenant, atau data produksi.
   - Jangan mengaktifkan `ORDERGUARD_TEST_USERS` atau seed demo di staging.

8. **Jalankan smoke test.**
   ```sh
   curl -fsS "https://<staging-host>/api/health"
   curl -fsS "https://<staging-host>/api/config"
   ```
   Lalu jalankan checklist fungsional di `staging/VERIFICATION.md`.

9. **Verifikasi keamanan.**
   - Cookie sesi memiliki `Secure`, `HttpOnly`, `SameSite=Lax`.
   - Respons HTTPS memiliki HSTS.
   - Origin asing ditolak 403.
   - Request tanpa CSRF ditolak 403.
   - Login rate limit bekerja.
   - Header CSP dan `X-Frame-Options: DENY` ada.

10. **Verifikasi backup pasca-deploy.**
    - Jalankan backup terjadwal/manual.
    - Pastikan objek `.dump.enc`, `.meta.json`, dan `.sha256` ada di bucket staging.
    - Jalankan restore ke database staging terpisah dan bandingkan jumlah baris penting.

11. **Catat bukti.**
    - Simpan SHA, deploy ID, URL CI, hasil health, screenshot/log, checksum backup, dan hasil restore.
    - Tempelkan ke laporan Wave 2.3 pada commit yang diuji.

## Larangan

- Jangan deploy ke produksi.
- Jangan merge ke `main`.
- Jangan memakai database, bucket, key, atau kredensial produksi.
- Jangan menyalin data produksi ke staging.
- Jangan mengaktifkan auto-deploy tanpa persetujuan.
- Jangan mengklaim PASS tanpa bukti eksekusi.

## Setelah deploy

- Pantau log dan health minimal 30 menit.
- Periksa error rate, login, dan backup alert.
- Jika ada anomali, ikuti `staging/ROLLBACK.md`.
- Jangan menghapus backup pra-deploy sampai verifikasi selesai.
