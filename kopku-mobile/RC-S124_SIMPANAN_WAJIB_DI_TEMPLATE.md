# RC-S124 — Simpanan Pokok / Wajib / Sukarela WAJIB di Template Import Data Awal

## Permintaan
Pada menu **Pengaturan › Struktur Template**, kolom Simpanan Pokok, Simpanan
Wajib, dan Simpanan Sukarela tidak lagi berlabel *Opsional* — ketiganya
**Wajib**.

## Prinsip
Layar Struktur Template TIDAK memiliki daftar kolom sendiri; seluruh isinya
dirender dari `SHEET_TEMPLATE` — objek yang sama yang membangun berkas
`.xlsx`. Test RC-S96 juga memastikan setiap kolom bertanda `wajib` benar-benar
DITOLAK parser bila dikosongkan. Karena itu perubahan dilakukan di sumbernya,
sehingga tiga hal tetap selaras:

1. Lencana **Wajib** di layar aplikasi,
2. Tanda `*` pada judul kolom di berkas Excel,
3. Validasi parser saat import.

## Perubahan

### `src/import/TemplateDataAwal.ts`
- `Simpanan Pokok`, `Simpanan Wajib`, `Simpanan Sukarela`: `wajib: false` → `wajib: true`.
- Catatan kolom: "tulis 0 bila tidak ada" (Pokok: "tulis 0 bila sudah pernah dicatat").
- Keterangan sheet Simpanan diperbarui.
- Sheet Petunjuk: tambahan baris "Ketiga kolom simpanan WAJIB diisi; tulis 0 bila memang tidak ada."

### `src/import/ExcelDataAwalParser.ts` — `parseSheetSimpanan`
- Kolom header wajib: `kodeanggota, tanggal, simpananpokok, simpananwajib, simpanansukarela`
  (berkas tanpa ketiga kolom ini ditolak di tingkat sheet).
- Sel nominal KOSONG kini ditolak: `"<Kolom> wajib diisi — tulis 0 bila tidak ada."`
  (sebelumnya diam-diam dianggap 0).
- Angka **0 tetap sah**. Aturan "minimal satu > 0" tetap berlaku.
- Aturan Simpanan Pokok satu kali per anggota tidak berubah — anggota yang
  Pokoknya sudah tercatat cukup diisi 0.

## Dampak bagi pengguna
- Template lama (tanpa kolom Wajib/Sukarela, atau dengan sel kosong) akan
  ditolak; pengurus perlu mengunduh template baru.

## Test
- `ExcelDataAwalParser.test.ts`
  - "nominal kosong dianggap 0" → "angka 0 diterima".
  - BARU: sel Pokok/Wajib/Sukarela kosong ditolak dengan pesan yang tepat.
  - BARU: sheet tanpa kolom Simpanan Wajib/Sukarela ditolak di tingkat sheet.
  - Pengecualian `SIMPANAN` pada test "kolom TIDAK wajib boleh dikosongkan" dihapus.
- Fixture SIMPANAN di `ExcelDataAwalParser.test.ts`, `ImportDataAwalRcS96.test.ts`,
  `RiwayatImportRcS100.test.ts` dilengkapi kolom Wajib/Sukarela bernilai `0`.

Hasil: 6 suite terkait import (ExcelDataAwalParser, ImportDataAwalRcS96,
ImportSederhanaRcS103, RiwayatImportRcS100, SaldoAwalOtomatisRcS107,
MigrasiPinjamanRcS102) — **190/190 lulus**.

Catatan: 6 suite berikut sudah gagal SEBELUM perubahan ini (diverifikasi pada
salinan asli, hasil identik 6 gagal / 136 lulus) dan tidak berkaitan dengan
import: PendapatanKoperasiRcS67, PendapatanBungaCoaRcS70_6,
TemporalIntegrityRcS58, ReleaseHardeningRcS57, SimpananDetailScreen,
KontrolAkhirRcS53.
