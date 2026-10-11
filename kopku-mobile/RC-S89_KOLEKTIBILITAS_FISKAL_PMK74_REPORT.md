# RC-S89 — Lapisan Cadangan Fiskal PMK 74/2024 untuk Kolektibilitas

## Latar belakang

Diminta: cek modul kolektibilitas KOPKU terhadap SOM Juklat Deputi Bidang
Pengawasan Koperasi No. 3/2025 (Kemenkop) dan PMK 74/2024 (fiskal), lalu
buatkan rekomendasi/implementasi kolektibilitas yang sesuai.

## Temuan audit (sebelum perubahan)

`LoanImpairmentService.ts` memakai 5 kategori berbasis **hari kalender**
tunggakan (Lancar/Dalam Perhatian/Kurang Lancar/Diragukan/Macet — ambang
0/1-90/91-120/121-180/181+, persentase 0,5/5/15/50/100%). Skema ini **tidak
cocok persis** dengan salah satu rujukan:

- **SOM Juklat 3/2025** (dibaca langsung dari `jdih.kop.go.id`): hanya
  mendefinisikan 3 kategori bermasalah (Kurang Lancar/Diragukan/Macet, tanpa
  "Dalam Perhatian"), dengan ambang dalam **bulan tunggakan relatif terhadap
  masa angsuran pinjaman** (bukan hari kalender tetap), plus kriteria
  kualitatif (rasio angsuran, nilai agunan, aturan 21 bulan untuk Macet).
- **PMK 74/2024 Ps.7 (Lampiran, baris Koperasi Simpan Pinjam)**: hanya 4
  kategori (Lancar 0,5% / Kurang Lancar 10% / Diragukan 50% / Macet 100%,
  TANPA "Dalam Perhatian Khusus" — itu istilah perbankan POJK 40/2019),
  dasar pencadangan = piutang **dikurangi agunan** (kecuali kategori Lancar).

## Keputusan (dikonfirmasi pengguna)

Opsi yang dipilih: **pertahankan skema 5-tier internal berbasis hari** untuk
staging risiko harian (SAK EP tidak mewajibkan bentuk staging tertentu untuk
ECL), dan **tambahkan lapisan pelaporan fiskal PMK 74 terpisah** untuk
kebutuhan SPT Badan/koreksi fiskal — bukan menimpa mesin aging yang sudah ada.

Mengubah threshold/persentase mesin internal TIDAK dilakukan (itu opsi 1,
tidak dipilih) — sesuai disiplin "policy vs bug" di `engineering-rules.md`,
perubahan kebijakan pencadangan buku butuh sign-off terpisah dari mnaz kalau
suatu saat diminta.

## Perubahan

### File baru

- **`src/services/KolektibilitasFiskalService.ts`** — modul independen,
  TIDAK mengubah `LoanImpairmentService.ts` sama sekali:
  - `PETA_KATEGORI_KE_FISKAL`: memetakan 5 kategori internal ke 4 kategori
    fiskal PMK 74. `DALAM_PERHATIAN` dipetakan ke `KURANG_LANCAR`
    (keputusan konservatif, didokumentasikan di kode — bisa diubah satu
    tempat kalau kebijakan koperasi berbeda).
  - `PERSENTASE_CADANGAN_FISKAL`: 0,5/10/50/100% persis Lampiran PMK 74 Ps.7.
  - `hitungCadanganFiskal()`: dasar = saldo pokok − nilai agunan (dari tabel
    `pinjaman_agunan` yang sudah ada sejak RC-S54 item 25), kecuali kategori
    Lancar yang dihitung tanpa pengurang agunan (persis bunyi Lampiran).
  - `getKlasifikasiFiskalPinjamanAktif()`: SATU query aging (dari
    `getKlasifikasiPinjamanAktif()` yang sudah ada) + JOIN agunan — tidak
    ada mesin klasifikasi kedua.
  - `getRingkasanCadanganFiskal()`, `getPerbandinganCadanganBukuFiskal()`:
    laporan agregat & pembanding buku vs fiskal untuk koreksi fiskal SPT
    Badan. **Tidak memposting jurnal apa pun** — cadangan yang dibukukan
    tetap murni versi SAK EP lewat `sesuaikanPenyisihanPiutang()` yang sudah
    ada; penyesuaian ke batas fiskal terjadi di SPT Badan, bukan di jurnal
    koperasi.

- **`src/__tests__/KolektibilitasFiskalService.test.ts`** — 8 test: konstanta
  PMK 74, pemetaan kategori, penghitungan dasar pencadangan (dengan/tanpa
  agunan, kategori Lancar vs lainnya, agunan melebihi piutang → dasar 0
  bukan negatif), serta I/O end-to-end lewat SQLite sungguhan.

### File diubah

- **`src/screens/Laporan/KolektibilitasPiutangScreen.tsx`** — layar sekarang
  memuat data lewat `getKlasifikasiFiskalPinjamanAktif()` (satu query,
  bukan dua — field buku & fiskal datang dari sumber yang sama). Ditambah:
  - Kartu ringkasan 4 kategori fiskal + kartu "Total Cadangan Fiskal" dengan
    selisih terhadap cadangan buku (indikasi arah koreksi fiskal).
  - Baris kategori fiskal + nilai cadangan fiskal pada tiap item di daftar
    detail per-pinjaman.
  - Tidak ada perubahan pada alur "Sesuaikan Penyisihan" (tetap murni buku/
    SAK EP, tidak tersentuh).

## Verifikasi

- `tsc --noEmit`: **0 error** (dijalankan 2×, setelah service baru & setelah
  perubahan layar).
- Test baru (`KolektibilitasFiskalService.test.ts`): **8/8 lulus**.
- Regresi menyeluruh — **seluruh 290 file test** dijalankan (dipecah 6 batch
  karena runtime penuh >300 detik untuk satu perintah):
  - 283 suite **lulus**.
  - 7 suite gagal, **seluruhnya pra-eksis** (`ENOENT` pada dokumen root yang
    memang tidak ikut ter-upload di ZIP ini: `POLICY_DECISION_RC-S53.md`,
    `POLICY_REGISTER_RC-S53.md`, `RC-S58_DEVICE_QA_CHECKLIST.md`) —
    `KontrolAkhirRcS53`, `PolicyRegisterRcS53`, `PendapatanKoperasiRcS67`,
    `PendapatanBungaCoaRcS70_6`, `ImbalHasilTetapRcS67_6`,
    `ReleaseHardeningRcS57`, `TemporalIntegrityRcS58`. **Bukan regresi** dari
    perubahan sesi ini — tidak ada satu pun kegagalan yang menyentuh modul
    pinjaman/kolektibilitas/laporan/akuntansi.
  - Total test individual yang lulus: 793+691+1039+799+1138+974 = **5.434
    passed**, 5 gagal (semuanya bagian dari 7 suite ENOENT di atas).

## Batasan yang belum dikerjakan (di luar cakupan sesi ini)

- Kriteria kualitatif SOM Juklat 3/2025 (rasio angsuran ≥75%, nilai agunan
  ≥100%, aturan 21 bulan untuk Macet) **belum diimplementasikan** — itu
  bagian dari Opsi 1 (selaraskan penuh) yang tidak dipilih sesi ini.
- Ambang bulan-relatif-terhadap-masa-angsuran SOM Juklat juga belum
  diimplementasikan; mesin aging tetap berbasis hari kalender seperti semula.
- Laporan cadangan fiskal ini belum dihubungkan ke modul Pajak Badan/SPT
  (`PajakBadanRcS87`) — saat ini murni layar terpisah untuk dibaca manual
  saat menyusun koreksi fiskal.
