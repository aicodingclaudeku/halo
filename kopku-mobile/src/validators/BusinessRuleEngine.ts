/**
 * BusinessRuleEngine — Phase 3 (AUDIT_INTERNAL.md §5: "BusinessRuleEngine:
 * MISSING — logika tersebar ad-hoc per service").
 *
 * SEMUA fungsi di sini murni (pure): tidak ada akses database, tidak
 * ada side effect, cuma menerima angka/status yang SUDAH diambil
 * pemanggil dari database lalu mengembalikan hasil valid/tidak +
 * alasan. Ini SENGAJA dipisah dari I/O — sama seperti pola
 * `PinjamanCalculator.ts`/`ShuCalculator.ts` yang sudah ada di
 * codebase — supaya setiap rule bisa dites SATU-SATU tanpa perlu
 * database sungguhan/mock, dan supaya satu rule bisa dipakai ulang
 * dari service manapun tanpa duplikasi logika.
 *
 * Modul ini TIDAK memanggil dirinya sendiri secara otomatis dari
 * service manapun di Phase 3 — penyambungan (service memanggil rule
 * yang relevan sebelum createJournal) dikerjakan di Phase 4
 * (Liquidity/Cash/Bank) dan Phase 6-7 (Loan & Loan payment), supaya
 * tiap penyambungan bisa diuji sekaligus dengan konteks service-nya.
 */

export interface RuleResult {
  valid: boolean;
  /** Kosong kalau valid. Pesan siap-tampil kalau tidak valid. */
  reason?: string;
}

// ============================================================
// CASH / BANK / LIQUIDITY
// ============================================================

/** Rule: "cash sufficient" / "bank sufficient" — saldo rekening yang dipakai harus cukup untuk nominal yang mau keluar. */
export function checkSaldoCukup(params: {
  saldoTersedia: number;
  nominalKeluar: number;
  namaRekening?: string;
}): RuleResult {
  if (params.nominalKeluar <= params.saldoTersedia) return { valid: true };
  return {
    valid: false,
    reason: `Saldo ${params.namaRekening ?? 'rekening'} tidak cukup (saldo: ${params.saldoTersedia}, dibutuhkan: ${params.nominalKeluar}).`,
  };
}

export interface LiquidityCheckInput {
  kas: number;
  bank: number;
  reservedLiquidity: number;
  minimumCashReserve: number;
  pendingDisbursement: number;
  jumlahDiajukan: number;
}

export interface LiquidityCheckResult extends RuleResult {
  availableLiquidity: number;
}

/**
 * Rule: "liquidity sufficient" — sesuai rumus yang diminta:
 *   availableLiquidity = kas + bank - reservedLiquidity - minimumCashReserve - pendingDisbursement
 *   valid jika jumlahDiajukan <= availableLiquidity
 *
 * Contoh dari spesifikasi: Kas 5jt, Bank 3jt, Reserve 2jt →
 * available 6jt, pinjaman 10jt → DITOLAK. Fungsi ini murni hitung —
 * pemanggil (Phase 4/6) yang bertanggung jawab mengambil kas/bank
 * sungguhan lewat getAccountBalance() dan reservedLiquidity/
 * minimumCashReserve lewat AccountingPolicyService.
 */
export function checkLiquiditySufficient(input: LiquidityCheckInput): LiquidityCheckResult {
  const availableLiquidity =
    input.kas + input.bank - input.reservedLiquidity - input.minimumCashReserve - input.pendingDisbursement;

  if (input.jumlahDiajukan <= availableLiquidity) {
    return { valid: true, availableLiquidity };
  }
  return {
    valid: false,
    availableLiquidity,
    reason: `Likuiditas tidak cukup: tersedia ${availableLiquidity} (kas ${input.kas} + bank ${input.bank} - reserved ${input.reservedLiquidity} - minimum reserve ${input.minimumCashReserve} - pending ${input.pendingDisbursement}), dibutuhkan ${input.jumlahDiajukan}.`,
  };
}

/**
 * Rule: "no negative balance" — saldo SESUDAH transaksi tidak boleh
 * negatif, kecuali kebijakan overdraft eksplisit mengizinkan
 * (izinkanOverdraft=true, mis. untuk rekening bank tertentu yang
 * memang punya fasilitas cerukan — TIDAK pernah default true).
 */
export function checkTidakNegatif(params: {
  saldoSaatIni: number;
  perubahan: number; // negatif kalau saldo berkurang
  izinkanOverdraft?: boolean;
}): RuleResult {
  const saldoSesudah = params.saldoSaatIni + params.perubahan;
  if (saldoSesudah >= 0 || params.izinkanOverdraft) return { valid: true };
  return {
    valid: false,
    reason: `Transaksi ini akan membuat saldo negatif (${saldoSesudah}). Kebijakan overdraft tidak aktif untuk rekening ini.`,
  };
}

// ============================================================
// ANGGOTA
// ============================================================

/** Rule: "member active" — anggota berstatus selain AKTIF tidak boleh jadi subjek transaksi finansial baru. */
export function checkAnggotaAktif(statusAnggota: string): RuleResult {
  if (statusAnggota === 'AKTIF') return { valid: true };
  return {
    valid: false,
    reason: `Anggota berstatus "${statusAnggota}" — hanya anggota AKTIF yang bisa melakukan transaksi baru.`,
  };
}

// ============================================================
// PINJAMAN — eligibility & limit
// ============================================================

/**
 * Rule: "saving balance" — syarat saldo simpanan minimum sebelum
 * boleh mengajukan pinjaman. `minimum` 0 = tidak ada syarat (default
 * AccountingPolicyService), jadi fungsi ini otomatis selalu valid
 * kalau kebijakan belum diaktifkan admin.
 */
export function checkSaldoSimpananMinimum(saldoSimpanan: number, minimum: number): RuleResult {
  if (minimum <= 0 || saldoSimpanan >= minimum) return { valid: true };
  return {
    valid: false,
    reason: `Saldo simpanan (${saldoSimpanan}) belum memenuhi syarat minimum pengajuan pinjaman (${minimum}).`,
  };
}

/**
 * Rule: "kepemilikan simpanan wajib" — SYARAT WAJIB (bukan kebijakan
 * configurable seperti checkSaldoSimpananMinimum di atas) sebelum
 * anggota boleh mengajukan pinjaman: HARUS sudah punya Simpanan Pokok
 * DAN Simpanan Wajib (> 0), terlepas dari pengaturan
 * MINIMUM_SALDO_SIMPANAN_PINJAMAN. Kedua alasan ditampilkan sekaligus
 * kalau keduanya belum ada, supaya anggota/petugas tahu persis apa
 * yang kurang tanpa harus dicoba berulang.
 */
export function checkKepemilikanSimpananPokokWajib(saldoPokok: number, saldoWajib: number): RuleResult {
  const kurang: string[] = [];
  if (saldoPokok <= 0) kurang.push('Simpanan Pokok');
  if (saldoWajib <= 0) kurang.push('Simpanan Wajib');
  if (kurang.length === 0) return { valid: true };
  return {
    valid: false,
    reason: `Pengajuan pinjaman ditolak: anggota belum memiliki ${kurang.join(' dan ')}.`,
  };
}

/** Rule: "loan limit" — plafon pinjaman per pengajuan. `limit` 0 = tanpa batas. */
export function checkLimitPinjaman(jumlahDiajukan: number, limit: number): RuleResult {
  if (limit <= 0 || jumlahDiajukan <= limit) return { valid: true };
  return {
    valid: false,
    reason: `Jumlah pinjaman (${jumlahDiajukan}) melebihi plafon maksimum (${limit}).`,
  };
}

/** Rule: "outstanding limit" — total sisa pinjaman berjalan + pinjaman baru tidak boleh melebihi batas. `limit` 0 = tanpa batas. */
export function checkLimitOutstanding(outstandingSaatIni: number, jumlahBaru: number, limit: number): RuleResult {
  if (limit <= 0) return { valid: true };
  const totalSesudah = outstandingSaatIni + jumlahBaru;
  if (totalSesudah <= limit) return { valid: true };
  return {
    valid: false,
    reason: `Total pinjaman berjalan setelah pengajuan ini (${totalSesudah} = ${outstandingSaatIni} + ${jumlahBaru}) melebihi batas outstanding (${limit}).`,
  };
}

/**
 * Rule: "overdue limit" — anggota dengan tunggakan aktif melebihi
 * batas (jumlah baris DAN/ATAU hari keterlambatan, tergantung mana
 * yang dikonfigurasi admin) tidak boleh mengajukan pinjaman baru.
 * Kedua limit 0 = tidak dicek sama sekali (default).
 */
export function checkBatasTunggakan(params: {
  jumlahTunggakanAktif: number;
  hariTerlambatMaksimum: number;
  limitJumlahTunggakan: number;
  limitHariTerlambat: number;
}): RuleResult {
  if (params.limitJumlahTunggakan > 0 && params.jumlahTunggakanAktif >= params.limitJumlahTunggakan) {
    return {
      valid: false,
      reason: `Anggota memiliki ${params.jumlahTunggakanAktif} tunggakan aktif (batas: ${params.limitJumlahTunggakan}) — pengajuan pinjaman baru ditolak.`,
    };
  }
  if (params.limitHariTerlambat > 0 && params.hariTerlambatMaksimum > params.limitHariTerlambat) {
    return {
      valid: false,
      reason: `Anggota memiliki tunggakan terlambat ${params.hariTerlambatMaksimum} hari (batas: ${params.limitHariTerlambat} hari) — pengajuan pinjaman baru ditolak.`,
    };
  }
  return { valid: true };
}

/** Rule: "loan not already disbursed" — pinjaman hanya boleh dicairkan sekali. */
export function checkBelumDicairkan(statusPinjaman: string): RuleResult {
  if (statusPinjaman === 'DIAJUKAN' || statusPinjaman === 'DISETUJUI') return { valid: true };
  return {
    valid: false,
    reason: `Pinjaman berstatus "${statusPinjaman}" tidak bisa dicairkan (mungkin sudah cair, lunas, atau ditolak).`,
  };
}

// ============================================================
// PEMBAYARAN
// ============================================================

/**
 * Rule: "payment <= outstanding" — nominal pembayaran TIDAK BOLEH
 * melebihi sisa tagihan. Berbeda dari perilaku lama `bayarAngsuran`
 * (memotong diam-diam, lihat AUDIT_INTERNAL.md §3.2) — rule ini
 * eksplisit MENOLAK, bukan memotong, supaya pemanggil bisa
 * menampilkan pesan jelas ke user dan tidak ada uang yang "hilang"
 * dari jurnal.
 */
export function checkPembayaranTidakMelebihiOutstanding(nominalBayar: number, outstanding: number): RuleResult {
  if (nominalBayar <= outstanding) return { valid: true };
  return {
    valid: false,
    reason: `Nominal pembayaran (${nominalBayar}) melebihi sisa tagihan/outstanding (${outstanding}).`,
  };
}

// ============================================================
// GABUNGAN — jalankan beberapa rule sekaligus, hasil rule pertama yang gagal
// ============================================================

/**
 * Jalankan beberapa RuleResult (yang sudah dihitung pemanggil) secara
 * berurutan, return rule pertama yang gagal — supaya service pemanggil
 * cukup satu `if` untuk melempar error, bukan berantai if/else per rule.
 */
export function validateAll(...results: RuleResult[]): RuleResult {
  const gagal = results.find((r) => !r.valid);
  return gagal ?? { valid: true };
}

/**
 * RC-S133.6.4 — pasangan `validateAll` yang mengembalikan SEMUA alasan
 * kegagalan, bukan hanya yang pertama. Dipakai di tempat yang tidak
 * menolak melainkan memperingatkan (import data awal): pengurus perlu
 * melihat seluruh syarat yang tidak terpenuhi sekaligus.
 */
export function collectFailures(...results: RuleResult[]): string[] {
  return results.filter((r) => !r.valid).map((r) => r.reason ?? 'Syarat tidak terpenuhi.');
}

/**
 * RC-S133.6.4 — ubah alasan penolakan menjadi kalimat peringatan netral
 * ("ditolak" menyesatkan bila pinjaman justru tetap dicatat). Pesan asli
 * tidak diubah; ini hanya dipakai di jalur peringatan (import data awal).
 */
export function alasanSebagaiPeringatan(reason: string): string {
  const netral = reason
    .replace(/^Pengajuan pinjaman ditolak: /, '')
    .replace(/ — pengajuan pinjaman baru ditolak\.$/, '.')
    .replace(/ — hanya anggota AKTIF yang bisa melakukan transaksi baru\.$/, '.');
  return netral.charAt(0).toUpperCase() + netral.slice(1);
}
