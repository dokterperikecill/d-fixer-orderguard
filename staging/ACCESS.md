# Akses Staging OrderGuard

**Status default: privat.** Nginx hanya mengizinkan `127.0.0.1`/`::1`; publik mendapat `403`.
Port aplikasi `4181` hanya listen di `127.0.0.1` dan UFW tidak membukanya.

- Host: `staging-orderguard.202-10-34-141.nip.io`
- Service: `orderguard-staging.service` (user `orderguard`, Node 24, memory 384 MB, CPU 50%)
- Release: `/opt/orderguard-staging/current` → `releases/<sha>`

---

## 1. SSH tunnel (default, paling aman)

Di laptop/PC operator:

1. Tambahkan hostname ke hosts file **lokal**:
   - Linux/macOS: `/etc/hosts`
   - Windows: `C:\Windows\System32\drivers\etc\hosts`

   ```text
   127.0.0.1 staging-orderguard.202-10-34-141.nip.io
   ```

2. Buat tunnel (butuh akses admin lokal karena memakai port 443):

   ```sh
   sudo ssh -N -L 443:127.0.0.1:443 dfixer-admin@202.10.34.141
   ```

3. Buka `https://staging-orderguard.202-10-34-141.nip.io` di browser.

> Alternatif tanpa port 443 lokal: `ssh -N -L 8443:127.0.0.1:443 ...` lalu buka
> `https://staging-orderguard.202-10-34-141.nip.io:8443`. Ini cukup untuk UI, tetapi
> **tidak** cocok untuk OAuth TikTok karena redirect URI tidak memuat port.

Verifikasi dari dalam VPS:

```sh
curl -fsS https://staging-orderguard.202-10-34-141.nip.io/api/ready
curl -s -o /dev/null -w '%{http_code}\n' \
  --resolve staging-orderguard.202-10-34-141.nip.io:443:202.10.34.141 \
  https://staging-orderguard.202-10-34-141.nip.io/   # harus 403
```

---

## 2. IP allowlist (akses tim tanpa tunnel)

Edit `/etc/nginx/sites-available/orderguard-staging.conf` pada blok 443:

```nginx
location / {
    allow 127.0.0.1;
    allow ::1;
    allow 203.0.113.10;   # IP publik kantor/rumah
    deny all;
    ...
}
```

Lalu:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

Batasan: IP dinamis harus diperbarui; jangan pernah memakai `allow all` untuk UI admin.

---

## 3. TikTok OAuth (jika diaktifkan)

Redirect URI wajib persis:

```text
https://staging-orderguard.202-10-34-141.nip.io/api/tiktok/callback
```

Pilihan akses:

- **Paling aman:** Cloudflare Tunnel + Access, bypass hanya path callback.
- **Tanpa migrasi DNS:** buka hanya `location = /api/tiktok/callback` (GET, rate limit),
  UI tetap private. Setelah callback, kode melakukan `res.redirect('/?view=imports...')`;
  pastikan operator yang menyelesaikan OAuth juga bisa mengakses UI (tunnel/allowlist),
  atau ubah callback menjadi halaman "kembali ke aplikasi".
- Gunakan **app TikTok staging terpisah** dan toko uji; revoke token setelah pengujian.

---

## 4. Aturan keamanan

- Jangan membuka UI admin ke publik tanpa Access/Basic Auth.
- Jangan memakai data, toko, atau kredensial TikTok produksi.
- Jangan menonaktifkan CSRF/origin check di staging.
- Setelah window pengujian TikTok, tutup akses publik dan revoke token.
- Kredensial staging: `/root/orderguard-staging-credentials.txt` (root, `600`).
- Backup key: `/root/orderguard-staging-backup-key` (root, `600`).
