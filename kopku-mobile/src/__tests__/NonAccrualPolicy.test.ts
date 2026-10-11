import {
  getAccrualStatus,
  isNonAccrual,
  alasanNonAccrual,
  HARI_MINIMUM_NON_ACCRUAL_DEFAULT,
} from '@/accounting/NonAccrualPolicy';

/**
 * SESI 2 §J — KEBIJAKAN NON-ACCRUAL TERPUSAT.
 *
 * Batasnya diuji TEPAT di titik peralihan (89/90/91) karena di situlah
 * kesalahan off-by-one pada kebijakan pengakuan pendapatan bersembunyi.
 */
describe('getAccrualStatus — batas 90 hari', () => {
  test('default kebijakan adalah 90 hari', () => {
    expect(HARI_MINIMUM_NON_ACCRUAL_DEFAULT).toBe(90);
  });

  test('89 hari -> ACCRUAL', () => {
    expect(getAccrualStatus(89)).toBe('ACCRUAL');
    expect(isNonAccrual(89)).toBe(false);
  });

  test('90 hari -> NON_ACCRUAL (batasnya inklusif)', () => {
    expect(getAccrualStatus(90)).toBe('NON_ACCRUAL');
    expect(isNonAccrual(90)).toBe(true);
  });

  test('91 hari -> NON_ACCRUAL', () => {
    expect(getAccrualStatus(91)).toBe('NON_ACCRUAL');
  });

  test('0 hari (lancar) -> ACCRUAL', () => {
    expect(getAccrualStatus(0)).toBe('ACCRUAL');
  });

  test('hari negatif (belum jatuh tempo) diperlakukan sebagai ACCRUAL, bukan error', () => {
    expect(getAccrualStatus(-10)).toBe('ACCRUAL');
  });

  test('pecahan hari dibulatkan ke bawah — 89,9 hari belum mencapai batas', () => {
    expect(getAccrualStatus(89.9)).toBe('ACCRUAL');
    expect(getAccrualStatus(90.1)).toBe('NON_ACCRUAL');
  });

  test('nilai tidak valid tidak boleh diam-diam menjadi NON_ACCRUAL', () => {
    expect(getAccrualStatus(NaN)).toBe('ACCRUAL');
  });

  test('ambang dapat dikonfigurasi — batas bergeser sesuai kebijakan koperasi', () => {
    expect(getAccrualStatus(100, 120)).toBe('ACCRUAL');
    expect(getAccrualStatus(120, 120)).toBe('NON_ACCRUAL');
    expect(getAccrualStatus(59, 60)).toBe('ACCRUAL');
    expect(getAccrualStatus(60, 60)).toBe('NON_ACCRUAL');
  });

  test('alasan yang dihasilkan menyebutkan ambang DAN tunggakan aktual', () => {
    const pesan = alasanNonAccrual(103, 90);
    expect(pesan).toMatch(/Non-accrual/);
    expect(pesan).toContain('90');
    expect(pesan).toContain('103');
  });
});

/**
 * Kebijakan ini TIDAK BOLEH diturunkan dari ambang kolektibilitas. Test di
 * bawah mengunci pemisahan tersebut: titik non-accrual ditentukan HANYA
 * oleh hari tunggakan dan ambang kebijakan koperasi — bukan oleh kategori
 * kolektibilitas, bukan oleh persentase pencadangan. Dua keputusan bisnis
 * yang berbeda, dua ambang yang berbeda: persis yang dulu tercampur.
 */
describe('pemisahan kebijakan pencadangan vs pengakuan pendapatan', () => {
  // Dua test di bawah dulu memanggil `klasifikasikanKolektibilitas(hari)`
  // milik LoanImpairmentService untuk menunjukkan bahwa kategori dan titik
  // non-accrual bisa bergerak terpisah. Fungsi itu sudah TIDAK ADA:
  // penggolongan sekarang mengikuti SOM Juklat 3/2025, yang BUKAN fungsi
  // dari hari tunggakan saja (ia juga bergantung pada masa angsuran,
  // komponen pokok/jasa, dan rasio agunan) — justru itu penegasan paling
  // kuat dari pemisahan yang dijaga modul ini. Yang diuji sekarang adalah
  // sifat yang memang menjadi tanggung jawab modul ini: keputusan
  // non-accrual ditentukan HANYA oleh hari tunggakan & ambangnya.
  test('titik non-accrual murni fungsi hari tunggakan, tidak terikat kategori kolektibilitas', () => {
    expect(getAccrualStatus(89)).toBe('ACCRUAL');
    expect(getAccrualStatus(90)).toBe('NON_ACCRUAL');
    expect(getAccrualStatus(100)).toBe('NON_ACCRUAL');
  });

  test('peralihan ke penggolongan SOM tidak menggeser titik non-accrual', () => {
    // Ambang non-accrual tetap 90 hari, apa pun kategori SOM pinjamannya —
    // tidak ada satu pun konstanta SOM yang ikut menentukannya.
    expect(getAccrualStatus(45)).toBe('ACCRUAL');
    expect(getAccrualStatus(45, 30)).toBe('NON_ACCRUAL'); // hanya ambang kebijakan yang menggesernya
  });
});
