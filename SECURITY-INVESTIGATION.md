# SECURITY INVESTIGATION — PHASE 1
## VPS Security Hardening — D'Fixer OrderGuard

**Status:** READ-ONLY investigation complete. **No remediation applied.**
**Server:** `vps.ayra.id` — Ubuntu 24.04.5 LTS, KVM, 1 vCPU, 2.2 GiB RAM, 40 GB disk.
**Date:** 2026-11-09 (Asia/Jakarta).
**Scope:** SSH, firewall, system security, application exposure, intrusion indicators.

> Tidak ada password, token, secret, private key, atau isi environment variable yang dibaca/ditampilkan. Tidak ada proses dihentikan, paket diubah, database dibuat, DNS/firewall diubah, atau deployment dilakukan.

---

# 1. Executive Summary

Investigasi Phase 1 selesai. VPS saat ini **tidak siap diekspos** untuk staging OrderGuard karena tiga masalah utama:

1. **SSH bergantung pada password root.** Tidak ada user administrator non-root, tidak ada sudo user, dan `authorized_keys` root kosong. Key authentication belum pernah berhasil digunakan.
2. **Tidak ada firewall host.** UFW tidak terpasang, nftables kosong, dan iptables default `ACCEPT`. Port `22, 80, 443, 3101, 4100, 4173, 4610` terbuka ke publik. Port aplikasi dapat diakses langsung tanpa Nginx.
3. **Brute-force masif dan berlangsung.** Tercatat sekitar **112.000 failed password** dan **35.000 invalid user** pada log yang tersedia. Saat investigasi, terdapat koneksi SSH pre-auth aktif dari `109.160.32.44` (862 percobaan gagal) dan sebelumnya `193.47.62.69` (1.161 percobaan gagal). Tidak ada login sukses dari IP tersebut.

Tambahan:

- Reboot tertunda; kernel berjalan `6.8.0-31`, kernel terpasang `6.8.0-147`.
- Enam paket security update tertunda.
- Dua proses OrderGuard preview berjalan sebagai root, tidak dikelola systemd/PM2, gagal koneksi PostgreSQL, dan menampilkan stack trace ke publik.
- Belum ada backup OrderGuard, dan `aws`/`rclone` belum tersedia.
- Tidak ada auditd, rkhunter, chkrootkit, atau debsums untuk assurance rootkit/audit.

**Kesimpulan Phase 1:** investigasi **PASS**, tetapi kesiapan remediasi **BLOCKED** sampai checkpoint SSH/firewall/reboot disetujui. Belum ada bukti konklusif server ditembus, tetapi assurance belum cukup untuk menyatakan server bersih sepenuhnya.

---

# 2. SSH Security

## 2.1 Konfigurasi efektif

| Parameter | Nilai | Status |
|---|---|---|
| `Port` | 22 | WARNING |
| `PermitRootLogin` | **yes** | BLOCKED |
| `PasswordAuthentication` | **yes** | BLOCKED |
| `PubkeyAuthentication` | yes | PASS (tetapi belum ada key) |
| `AuthenticationMethods` | any | WARNING |
| `MaxAuthTries` | 6 | WARNING |
| `LoginGraceTime` | 120 | WARNING |
| `X11Forwarding` | yes | WARNING |
| `AllowAgentForwarding` | yes | WARNING |
| `AllowTcpForwarding` | yes | WARNING |
| `AllowUsers` / `AllowGroups` | tidak diatur | WARNING |
| `AuthorizedKeysFile` | `.ssh/authorized_keys .ssh/authorized_keys2` | PASS |
| `UsePAM` | yes | PASS |
| `PermitEmptyPasswords` | no | PASS |

Sumber konfigurasi:

- `/etc/ssh/sshd_config`
  - `PermitRootLogin yes`
  - `Include /etc/ssh/sshd_config.d/*.conf`
- `/etc/ssh/sshd_config.d/50-cloud-init.conf`
  - `PasswordAuthentication yes`

**Status:** **BLOCKED** untuk hardening. Perubahan tidak boleh dilakukan sebelum user non-root + public key dibuat dan diuji melalui sesi SSH baru.

## 2.2 Authorized keys dan akun

| Item | Temuan |
|---|---|
| `/root/.ssh` | `700 root:root` |
| `/root/.ssh/authorized_keys` | **0 byte**, `600 root:root` |
| Authorized keys user lain | Tidak ditemukan |
| Akun dengan shell interaktif | `root`, `postgres` (system), `sync` |
| Akun non-root administrator | **Tidak ada** |
| Group `sudo` | kosong |
| Group `admin` / `wheel` | kosong |
| Akun UID 0 selain root | Tidak ada |
| Private key SSH ditemukan | Tidak ada |
| `sudo` group membership | Tidak ada user non-root |

**Implikasi:** key authentication belum siap. Menonaktifkan password authentication sekarang akan mengunci akses administrator. Phase 2 wajib membuat akun admin non-root + key, lalu menguji login baru sebelum mengubah konfigurasi.

**Status:** **BLOCKED**.

## 2.3 Riwayat login sukses

- Total login sukses sebenarnya: **63**, semuanya `Accepted password for root`.
- Login publickey: **0**.
- Login non-root: **0**.
- Sumber IP login sukses: 24 IP, semuanya berada pada rentang `182.1.x.x` dan `114.125.x.x`.
- Tidak ada login sukses dari IP brute-force utama.

Dua IP login sukses juga muncul pada log gagal:

| IP | Sukses | Gagal | Pola |
|---|---:|---:|---|
| `182.1.192.80` | 15 | 2 | 2 failed root, lalu sukses; konsisten dengan salah password |
| `182.1.208.112` | 9 | 25 | 14 `invalid user ayra`, lalu root sukses; kemungkinan admin salah username |

**Assessment:** tidak ada bukti brute-force berhasil. Namun geolokasi IP tidak diverifikasi dan identitas operator tidak dapat dipastikan hanya dari log. **WARNING — no conclusive compromise, assurance incomplete.**

## 2.4 Riwayat login gagal

| Metrik | Nilai |
|---|---:|
| Failed password (log tersedia) | ±112.440 |
| Invalid user | ±35.678 |
| Failed password 7 hari (journal) | ±98.351 |
| MaxAuth/MaxStartups events | 367 |
| Unique failed source IP | 1.189 |
| Top source IP | `176.53.159.198` (3.436), `109.160.32.x` (hingga ±1.986/IP), `77.239.124.x` (±1.995/IP), `8.137.63.239` (657), `144.31.87.53` (657) |
| Username paling sering dicoba | `root` (8.499), `admin` (353), `ubuntu` (294), `acs` (294), `user` (188), `deploy` (158), `test` (116), `postgres` (64) |

Distribusi harian (log tersedia):

```text
2026-11-01  17.578
2026-11-02  19.837
2026-11-03  18.292
2026-11-04  19.193
2026-11-05  15.624
2026-11-06  14.819
2026-11-07  22.095
2026-11-08  18.715
2026-11-09   1.971
```

### Koneksi pre-auth aktif

Saat investigasi:

```text
202.10.34.141:22  ->  109.160.32.44:39564   sshd: unknown [priv] / [net]
202.10.34.141:22  ->  182.1.168.154:35122   sshd: root@pts/0 (sesi admin)
```

- `109.160.32.44`: **862 failed**, **0 accepted**. Proses `sshd: unknown [priv]` = belum terautentikasi.
- `193.47.62.69`: **1.161 failed**, **0 accepted**; koneksi sudah tidak aktif saat pemeriksaan terakhir.
- Tidak ada sesi `root@pts/...` selain admin `182.1.168.154`.

**Status:** **WARNING** — serangan brute-force aktif, tetapi tidak ada bukti login berhasil.

---

# 3. Firewall

| Pemeriksaan | Hasil | Status |
|---|---|---|
| UFW | tidak terpasang | BLOCKED |
| nftables ruleset | kosong | BLOCKED |
| iptables filter | `INPUT ACCEPT`, `FORWARD ACCEPT`, `OUTPUT ACCEPT` | BLOCKED |
| Firewall provider Rumahweb | tidak dapat diverifikasi dari dalam VPS | NOT VERIFIED |

## 3.1 Port publik

```text
22    SSH
80    HTTP
443   HTTPS
3101  Parkline langsung
4100  Clockin API langsung
4173  OrderGuard preview
4610  OrderGuard preview
5432  PostgreSQL (localhost saja)
```

## 3.2 Bukti eksposur langsung

Uji read-only dari IP publik `202.10.34.141`:

| Port | Hasil |
|---:|---|
| 3101 | HTTP 200 |
| 4100 | HTTP 404 |
| 4173 | `/api/config` HTTP 200; `/api/health` HTTP 500 |
| 4610 | `/api/config` HTTP 200; `/api/health` HTTP 500 |

Artinya aplikasi dapat diakses **tanpa Nginx**, dan OrderGuard mengekspos stack trace/error database. PostgreSQL aman karena hanya listen `127.0.0.1:5432`.

**Status:** **BLOCKED**.

---

# 4. System Security

## 4.1 Update dan kernel

| Item | Nilai | Status |
|---|---|---|
| Paket upgradable | 6, termasuk bind9, dnsutils, libmspack, libpcre2 | WARNING |
| Kernel berjalan | `6.8.0-31-generic` | WARNING |
| Kernel terpasang | `6.8.0-147-generic` | WARNING |
| Reboot required | **ya**, sejak 26 Oktober 2026 | BLOCKED |
| Pemicu reboot | `libc6`, `apparmor`, `dbus`, `linux-image-6.8.0-147-generic`, `linux-base` | — |
| Unattended upgrades | aktif/enabled | PASS |
| `needrestart` | melaporkan dbus, getty, systemd-logind, unattended-upgrades perlu restart | WARNING |
| Failed systemd unit | 0 | PASS |
| OOM killer | 25 Oktober 2026 membunuh Java (RSS ±1,36 GB) | WARNING |

## 4.2 Layanan berjalan

22 service running, termasuk:

```text
clockin-api-staging.service
nginx.service
postgresql@16-main.service
ssh.service
cron.service
rsyslog.service
systemd-journald.service
systemd-networkd.service
systemd-timesyncd.service
unattended-upgrades.service
...
```

Custom unit:

- `/etc/systemd/system/clockin-api-staging.service` — active, enabled, user `clockin`.
- `/etc/systemd/system/pm2-root.service` — **enabled tetapi inactive**; PM2 daemon Parkline berjalan dari user session, bukan service.

`psimon` muncul sebagai proses, tetapi merupakan **kernel thread** (`PPID 2`, cgroup `0::/`, tanpa executable/fd), bukan aplikasi userspace.

**Status:** WARNING untuk PM2 persistence; PASS untuk tidak ada service tak dikenal.

## 4.3 Akun dan sudo

- Hanya root yang memiliki shell interaktif penuh; `postgres` dan `sync` adalah akun sistem.
- `clockin` memakai `/usr/sbin/nologin`.
- Group `sudo` kosong.
- Tidak ada akun UID 0 tambahan.
- `/etc/passwd`, `/etc/shadow`, `/etc/group` berubah 3 November 2026, konsisten dengan pembuatan user Clockin.

**Status:** PASS untuk tidak ada akun mencurigakan; **BLOCKED** untuk persiapan admin non-root.

## 4.4 SUID dan integritas file

- 13 SUID binary.
- Semua terdaftar pada paket, kecuali `fusermount3`.
- `fusermount3` adalah **false positive**: paket `fuse3` memiliki `/bin/fusermount3`; di Ubuntu 24.04 `/bin` adalah symlink ke `/usr/bin`. `dpkg -V fuse3` bersih.
- `dpkg -V` seluruh sistem:
  - `??5?????? c /etc/nginx/sites-available/default` — konfigurasi Nginx diubah manual (diketahui).
  - `missing c /etc/apparmor.d/nautilus` — profil AppArmor hilang (perlu review, bukan bukti kompromi).
  - Tidak ada perubahan pada binary sistem utama.

**Status:** PASS dengan dua catatan konfigurasi.

## 4.5 Cron, systemd, dan persistence

| Item | Temuan | Status |
|---|---|---|
| Root crontab | Parkline backup harian 18:00 | PASS (diketahui) |
| `/etc/cron.d` | certbot, e2scrub_all, sysstat | PASS |
| `/etc/cron.daily` | apport, apt-compat, dpkg, logrotate, man-db, sysstat | PASS |
| Custom systemd | Clockin, PM2 | PASS |
| `/etc/rc.local` | ada, menjalankan `sh /virt/swfix.sh`, tetapi **file target tidak ada** | WARNING (broken, tidak aktif) |
| `rc-local.service` | static, inactive | PASS (tidak berjalan) |
| `/etc/ld.so.preload` | tidak ada | PASS |
| systemd timers | certbot, apt, logrotate, sysstat, fstrim, dll. | PASS |

**Status:** WARNING untuk PM2/rc.local; tidak ada persistence mencurigakan yang aktif.

---

# 5. Application Security

| Aplikasi | Proses | Port | Manajemen | User | Exposure | Status |
|---|---|---:|---|---|---|---|
| Clockin staging | `clockin-api-staging.service` | 4100 | systemd | clockin | Nginx + direct | WARNING (direct port) |
| Parkline | PM2 `parkline` | 3101 | PM2 session | root | Nginx + direct | WARNING (direct port, PM2 inactive service) |
| OrderGuard preview 1 | PID 699729 | 4610 | manual | root | direct | BLOCKED |
| OrderGuard preview 2 | PID 699929 | 4173 | manual | root | direct | BLOCKED |
| PostgreSQL | `postgresql@16-main` | 5432 | systemd | postgres | localhost | PASS |
| Nginx | master 461634 | 80/443 | systemd | www-data | publik | PASS (tetapi belum ada OrderGuard) |
| OpenCode | PID 690582 / 852795 | 49374 localhost | manual | root | localhost | WARNING (root, memory) |
| Codex | PID 5500 / 663007 | unix socket | manual | root | unix | WARNING (root, memory) |

## 5.1 OrderGuard preview

| PID | Port | Start | Log | Database |
|---:|---:|---|---|---|
| 699729 | 4610 | 6 Nov 2026 22:19:44 | `/tmp/opencode/visual/server.log` | gagal auth |
| 699929 | 4173 | 6 Nov 2026 22:20:40 | `/tmp/opencode/trial/server.log` | gagal auth |

- Working directory: `/root/d-fixer-orderguard`
- User: root
- Parent: PID 1; cgroup `session-2179.scope`
- Bukan systemd/PM2.
- `/api/config` → `sandbox`
- `/api/health` → HTTP 500, `password authentication failed for user "orderguard"`
- Menampilkan stack trace dan path `/root/d-fixer-orderguard`.
- Berjalan lebih lama dari commit repo saat ini; menjalankan kode lama di memori.

**Status:** **BLOCKED** untuk eksposur publik. Jangan dihentikan sebelum disetujui.

## 5.2 Nginx

- Aktif, `nginx -t` OK.
- Server names:
  - `staging-clockin.202-10-34-141.nip.io` → `127.0.0.1:4100`
  - `staging-clockin-admin.202-10-34-141.nip.io` → `127.0.0.1:4100`
  - `202-10-34-141.nip.io` → `127.0.0.1:3101`
  - default `_` → redirect Parkline
- Tidak ada server block OrderGuard.
- `staging-orderguard.202-10-34-141.nip.io` saat ini mengarah ke Clockin dan memakai sertifikat Clockin.
- Tidak ada `default_server` 443 eksplisit; server 443 pertama adalah Clockin.

**Status:** PASS untuk service; **BLOCKED** untuk routing OrderGuard/konflik hostname.

## 5.3 PostgreSQL

- PostgreSQL 16.15, cluster `16/main` online.
- Listen `localhost` saja; SSL `on`; `max_connections=100`; `shared_buffers=128MB`; `work_mem=4MB`.
- `pg_hba`: local peer; host localhost scram-sha-256. Tidak ada akses remote.
- Database: `orderguard_test` (14 MB), `clockin_staging` (8.5 MB), `orderguard_visual` (8 MB), `orderguard_trial` (8 MB), `orderguard_dev` (7.4 MB).
- Tidak ada `orderguard_staging`.
- Role `orderguard` login tanpa createdb/superuser; `postgres` superuser.
- Data directory 133 MB; WAL 65 MB; disk 15 GB free.

**Status:** PASS untuk keamanan koneksi; PASS (feasible) untuk database staging terisolasi; belum dibuat.

---

# 6. Intrusion Indicators

## 6.1 Tidak ada bukti konklusif kompromi

Bukti yang mendukung:

- Tidak ada user UID 0 tambahan.
- Tidak ada user non-root dengan shell penuh.
- Tidak ada authorized key tak dikenal; root `authorized_keys` kosong.
- Tidak ada private key SSH ditemukan.
- Tidak ada login sukses dari IP brute-force utama.
- Tidak ada login publickey atau non-root.
- Tidak ada cron/systemd unit mencurigakan yang aktif.
- `/etc/ld.so.preload` tidak ada.
- `dpkg -V` tidak menemukan perubahan binary sistem utama.
- Tidak ada proses userspace mencurigakan; `psimon` adalah kernel thread.
- Tidak ada listener tidak dikenal.

## 6.2 Mengapa assurance belum cukup

- Root password authentication terbuka ke internet.
- ±112.000 failed password dan ±35.000 invalid user.
- Tidak ada auditd, rkhunter, chkrootkit, atau debsums.
- Ada koneksi pre-auth aktif dari bot brute-force.
- Dua proses OrderGuard preview berjalan sebagai root dari direktori development.
- `/tmp/opencode` berisi file cookie/token-like dengan permission world-readable (`644`), termasuk `admin.cookies`, `final.cookies`, `parkline.cookies`, `w2-enc-cookie`, `trial/cookies.txt`, dan log login. **Isi file tidak dibaca/ditampilkan.**
- Proses dengan executable `(deleted)` ditemukan (agetty, dbus, systemd-logind, unattended-upgrades, python3.12); ini konsisten dengan update paket yang menunggu reboot, bukan bukti kompromi, tetapi mengurangi baseline assurance.

## 6.3 Aktivitas yang perlu ditinjau

| Temuan | Interpretasi | Status |
|---|---|---|
| `182.1.208.112`: 14 invalid user `ayra`, lalu root sukses | Kemungkinan admin salah username; bukan bukti kompromi | WARNING |
| `182.1.192.80`: 2 failed root, lalu sukses | Kemungkinan salah password | WARNING |
| `109.160.32.44`, `193.47.62.69` | Pre-auth brute force; 0 accepted | WARNING |
| `/tmp/opencode` cookie/token files 644 | Secret hygiene risk | WARNING |
| `rc.local` menunjuk file hilang | Broken/unused | WARNING |
| `fusermount3` tidak terdaftar dpkg | False positive usrmerge; paket fuse3 bersih | PASS |

**Status keseluruhan indikasi kompromi:** **WARNING — tidak ada bukti konklusif, tetapi assurance belum memadai.**

---

# 7. Backup Konfigurasi Sebelum Perubahan (BELUM DILAKUKAN)

Karena Phase 1 hanya investigasi, belum ada backup yang dibuat. Sebelum perubahan Phase 2+:

- Buat direktori `/root/security-backups/<timestamp>/` dengan `chmod 700`.
- Backup:
  - `/etc/ssh/sshd_config` dan `/etc/ssh/sshd_config.d/`
  - `/etc/nginx/nginx.conf`, `/etc/nginx/sites-available/`, daftar symlink `sites-enabled`
  - `/etc/systemd/system/clockin-api-staging.service`, `pm2-root.service`
  - `/etc/cron.d/`, root crontab
  - `/etc/passwd`, `/etc/group`, `/etc/sudoers`, `/etc/sudoers.d/`
  - `/etc/ufw/` dan `/etc/fail2ban/` setelah paket dipasang
- Simpan output audit: `sshd -T`, `ss -ltnp`, `systemctl list-units`, `ufw status`, `nginx -T`.
- Set permission file backup `600`, direktori `700`.
- Simpan minimal satu salinan di luar VPS atau di provider snapshot.

---

# 8. Proposed Changes — Checkpoint Terpisah

Semua perubahan berikut **belum dilakukan**.

## Checkpoint A — Admin non-root + SSH key

1. Buat user admin non-root dengan sudo.
2. Tambahkan public key administrator.
3. Uji login key melalui sesi SSH **baru**.
4. Jangan menonaktifkan password/root login sebelum login key berhasil.
5. Backup konfigurasi SSH.

## Checkpoint B — SSH hardening

Setelah login key baru terverifikasi:

```text
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
MaxAuthTries 3
LoginGraceTime 30
```

- Validasi `sshd -t`.
- Reload SSH hanya setelah validasi berhasil.
- Pertahankan sesi SSH root yang aktif sebagai jalur pemulihan.
- Siapkan akses console provider.

## Checkpoint C — Firewall

Target:

```text
Default incoming: DENY
Default outgoing: ALLOW
Allow 22/tcp (atau batasi ke IP admin)
Allow 80/tcp
Allow 443/tcp
Deny public 3101, 4100, 4173, 4610, 5432
```

- Periksa firewall provider Rumahweb lebih dulu.
- Pastikan localhost dan Nginx → upstream tetap bekerja.
- Pastikan PostgreSQL tetap hanya localhost.
- Siapkan console provider dan rollback.
- Jangan aktifkan jika berpotensi mengunci SSH.

## Checkpoint D — Fail2ban

- Install paket fail2ban (belum terpasang).
- Backend systemd.
- `maxretry=5`, `findtime=10m`, `bantime=1h`.
- `ignoreip` untuk localhost dan IP administrator.
- Integrasi banaction dengan UFW/nftables agar tidak konflik.
- Uji `fail2ban-client status sshd`.

## Checkpoint E — Security updates + reboot

- Backup konfigurasi.
- Apply 6 security update.
- Reboot ke kernel 6.8.0-147.
- Maintenance window dan persetujuan administrator wajib.
- Jangan `do-release-upgrade`.

## Checkpoint F — Application exposure

- Hentikan dua OrderGuard preview setelah disetujui.
- Bind OrderGuard staging ke `127.0.0.1`, bukan `0.0.0.0`.
- Tambah Nginx server block OrderGuard + sertifikat.
- Jangan ubah konfigurasi Nginx Clockin/Parkline.
- Amankan/hapus file cookie uji di `/tmp/opencode` setelah disetujui.
- Pertahankan Clockin dan Parkline tetap aktif.
- PostgreSQL tetap localhost.

## Checkpoint G — Assurance

- Pertimbangkan auditd + rkhunter/chkrootkit/debsums.
- Review AppArmor `nautilus` yang hilang.
- Review `/etc/rc.local` yang menunjuk file hilang.
- Review PM2 persistence (`pm2-root` enabled tetapi inactive).

---

# 9. Rollback Procedure

- **SSH:** restore backup `sshd_config`, `sshd -t`, reload; gunakan console provider jika terkunci.
- **Firewall:** `ufw disable` dari console provider; jangan pernah mengaktifkan tanpa console.
- **Fail2ban:** stop/disable service, restore config, cek `fail2ban-client status`.
- **Update/reboot:** pilih kernel sebelumnya di GRUB jika boot gagal; gunakan snapshot provider.
- **Aplikasi:** jangan menghentikan Clockin/Parkline; OrderGuard preview hanya dihentikan setelah approval dan dapat dijalankan ulang dari perintah asal.
- **Database:** tidak ada perubahan database pada Phase 1.

---

# 10. Status Matrix

| Area | Status |
|---|---|
| SSH configuration investigation | PASS |
| SSH hardening readiness | **BLOCKED** |
| Root login/password exposure | **BLOCKED** |
| SSH key authentication | **BLOCKED** (authorized_keys kosong) |
| Non-root admin/sudo | **BLOCKED** |
| Firewall investigation | PASS |
| Firewall enforcement | **BLOCKED** |
| Public port exposure | **BLOCKED** |
| Fail2ban | **BLOCKED** (belum terpasang) |
| Security updates | WARNING |
| Pending reboot | **BLOCKED** |
| Kernel version | WARNING |
| Running services | PASS |
| Unexpected processes | PASS (psimon kernel thread) |
| User accounts | PASS (no unknown account) |
| SUID | PASS (fusermount3 false positive) |
| Cron/systemd persistence | WARNING |
| Package integrity | PASS (2 config notes) |
| OrderGuard preview exposure | **BLOCKED** |
| Nginx service | PASS |
| Nginx OrderGuard routing | **BLOCKED** |
| PostgreSQL access | PASS |
| PostgreSQL staging DB | PASS (feasible, not created) |
| Clockin availability | PASS |
| Parkline availability | WARNING (PM2 service inactive) |
| Intrusion evidence | WARNING (no conclusive compromise) |
| Rootkit/audit coverage | **NOT VERIFIED** |
| Secret hygiene `/tmp/opencode` | WARNING |
| Backup OrderGuard | **BLOCKED** (belum ada) |
| Off-site backup tooling | **BLOCKED** (`aws`/`rclone` absent) |
| Firewall provider / DNS control | **NOT VERIFIED** |

---

# 11. Kesimpulan

Phase 1 selesai secara read-only. Tidak ada perubahan sistem.

**Jangan lanjut ke SSH/firewall/reboot tanpa checkpoint persetujuan terpisah.**

Urutan yang disarankan:

1. Setujui laporan ini.
2. Checkpoint A: buat admin non-root + key; uji login baru.
3. Checkpoint B: SSH hardening setelah key terverifikasi.
4. Checkpoint C: firewall setelah console provider dan rollback siap.
5. Checkpoint D: fail2ban.
6. Checkpoint E: security updates + reboot dengan maintenance window.
7. Checkpoint F: application exposure + OrderGuard staging.
8. Checkpoint G: audit/rootkit assurance.

**Berhenti di sini. Menunggu persetujuan administrator.**
