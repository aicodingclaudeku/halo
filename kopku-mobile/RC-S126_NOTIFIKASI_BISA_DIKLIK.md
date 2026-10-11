# RC-S126 — Pesan notifikasi bisa diketuk

Hanya `src/components/LoncengNotifikasi.tsx` yang berubah. Tidak ada logika lisensi,
database, akuntansi, atau Dashboard yang disentuh.

- Setiap kartu di tab **Pengumuman** dan **Notifikasi** kini bisa diketuk.
- Ketuk → tampilan lengkap di dalam lembar yang sama: ikon, jenis, waktu, judul, isi penuh
  (bisa diseleksi/disalin), tombol tautan, dan tombol kembali (juga tombol Back Android).
- Notifikasi lisensi (masa berlaku, verifikasi online, jam perangkat) punya tombol
  **Buka info lisensi** yang membuka layar Lisensi lewat `router.push('/license')`,
  jalur yang sama dengan menu Pengaturan › Lisensi.
- Daftar kini ringkas (judul & isi dua baris) dengan petunjuk "Ketuk untuk membaca".
- Pesan yang diketuk otomatis ditandai sudah dibaca.
