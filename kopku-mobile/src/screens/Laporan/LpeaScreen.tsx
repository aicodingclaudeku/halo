import React, { useCallback, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AppTextInput from '@/components/AppTextInput';
import ReportRow from '@/components/report/ReportRow';
import ReportSectionCard from '@/components/report/ReportSectionCard';
import SummaryCard from '@/components/report/SummaryCard';
import EmptyState from '@/components/report/EmptyState';
import ExportButton from '@/components/ExportButton';
import { useFocusRefresh, usePermintaanTerakhir } from '@/hooks/useFocusRefresh';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { tungguTugasStartupSelesai } from '@/services/StartupTasks';
import { buildLpeaExport } from '@/export/ReportTableBuilders';
import {
  getLpea,
  getTahunBukuTersedia,
  setParameterLpea,
  KETERBATASAN_STRUKTURAL,
  LABEL_KELOMPOK_PEA,
  LABEL_PARAMETER_LPEA,
  LABEL_STATUS_KOMPONEN,
  parameterLpeaKosong,
  type HasilKomponenPea,
  type LaporanLpeaLengkap,
  type ParameterLpea,
} from '@/services/LpeaService';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { ui } from '@/theme/ui';

/**
 * RC-S101 — LAPORAN PROMOSI EKONOMI ANGGOTA (LPEA).
 *
 * Susunan mengikuti Lampiran butir 7 Juklak SOM No. 3/2025, dengan dua
 * kelompok manfaat yang dipisah tegas sesuai butir 5.8 angka 2:
 *
 *   MANFAAT EKONOMI DARI SIMPAN PINJAM LEWAT KOPERASI
 *     Penghematan Beban Pinjaman Anggota   (buku pembantu A & B)
 *     Kelebihan Balas Jasa Simpanan Anggota (buku pembantu C & D)
 *     = Jumlah promosi ekonomi dari transaksi penyediaan jasa
 *   PROMOSI EKONOMI PADA AKHIR TAHUN
 *     Pembagian SHU periode berjalan untuk anggota
 *   = Jumlah Promosi Ekonomi Anggota
 *
 * SELURUH rumus ada di `LpeaPlan` (modul murni, diuji terhadap angka
 * contoh naskah) dan pengambilan datanya di `LpeaRepository`. Layar ini
 * tidak menghitung apa pun.
 *
 * KETERBATASAN DITAMPILKAN, TIDAK DISEMBUNYIKAN. Rumus resmi menuntut
 * tarif rata-rata di lembaga keuangan LAIN — fakta pasar yang tidak
 * mungkin diketahui aplikasi. Selama tarif itu belum diisi koperasi,
 * komponennya ditandai "belum dapat dihitung", tidak dihitung nol, dan
 * tidak ikut ke total; totalnya sendiri ditandai belum lengkap.
 */
export default function LpeaScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  // RC-S95 — tahun buku adalah TANGGAL BISNIS, jadi cadangannya WAJIB
  // mengikuti jam aplikasi (Mode Pengujian Waktu), bukan `new Date()`.
  // Versi pertama layar ini memakai `new Date().getFullYear()` dan
  // langsung tertangkap penjaga JamSimulasiMenyeluruhRcS95 — tanpa itu,
  // menggeser jam untuk pengujian akan membuka LPEA tahun yang salah.
  const tahunAktif = koperasi?.tahunBukuAktif ?? Number(getTanggalLokalHariIni().slice(0, 4));

  const [tahunBuku, setTahunBuku] = useState<number>(tahunAktif);
  const [tahunTersedia, setTahunTersedia] = useState<number[]>([]);
  const [data, setData] = useState<LaporanLpeaLengkap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bukaParameter, setBukaParameter] = useState(false);
  const [bukaRincian, setBukaRincian] = useState(false);

  const permintaan = usePermintaanTerakhir();

  const muat = useCallback(() => {
    void (async () => {
      const token = permintaan.mulai();
      setLoading(true);
      setError(null);
      try {
        // Pola yang SAMA dengan PosisiKeuanganScreen & LabaRugiScreen:
        // tunggu pekerjaan latar yang menulis jurnal selesai sebelum
        // membaca angka, supaya laporan tidak membaca buku setengah jalan.
        await tungguTugasStartupSelesai();
        const [hasil, tahun] = await Promise.all([getLpea(tahunBuku), getTahunBukuTersedia()]);
        if (!permintaan.masihTerbaru(token)) return;
        setData(hasil);
        setTahunTersedia(tahun.length > 0 ? tahun : [tahunBuku]);
      } catch (e) {
        if (!permintaan.masihTerbaru(token)) return;
        setError(e instanceof Error ? e.message : 'Gagal memuat laporan.');
      } finally {
        if (permintaan.masihTerbaru(token)) setLoading(false);
      }
    })();
  }, [permintaan, tahunBuku]);

  useFocusRefresh(muat, [muat]);
  useReportRefreshHeader(muat, { loading, testID: 'refresh-lpea' });

  const laporan = data?.laporan;

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={ui.screenContent}>
        {/* KOP LAPORAN — pola yang sama dengan Laporan Hasil Usaha. */}
        <View style={styles.kop}>
          <Text style={styles.kopKoperasi} numberOfLines={2}>
            {koperasi?.nama ?? '—'}
          </Text>
          <Text style={styles.kopJudul}>Laporan Promosi Ekonomi Anggota</Text>
          {laporan ? (
            <Text style={styles.kopPeriode}>
              Untuk periode yang berakhir tanggal {formatTanggalIndonesia(laporan.tanggalSelesai)}
            </Text>
          ) : null}
          <Text style={styles.kopStandar}>Juklak SOM No. 3/2025 butir 5.8 &amp; Lampiran butir 7</Text>
        </View>

        {/* FILTER TAHUN BUKU — naskah butir 5.8 angka 1: manfaat selama SATU TAHUN. */}
        <Text style={styles.labelFilter}>Tahun Buku</Text>
        <View style={styles.tahunBaris}>
          {(tahunTersedia.length > 0 ? tahunTersedia : [tahunBuku]).map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.chipTahun, t === tahunBuku && styles.chipTahunAktif]}
              onPress={() => setTahunBuku(t)}
              testID={`tahun-${t}`}
            >
              <Text style={[styles.chipTahunText, t === tahunBuku && styles.chipTahunTextAktif]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading && <ActivityIndicator style={{ marginTop: spacing.lg }} color={colors.primary} />}
        {!loading && error && <Text style={styles.error}>{error}</Text>}

        {!loading && !error && laporan && (
          <>
            {laporan.totalBelumLengkap && (
              <View style={styles.bannerBelumLengkap}>
                <Ionicons name="alert-circle" size={20} color={colors.warning} />
                <Text style={styles.bannerBelumLengkapText}>
                  Total laporan ini BELUM LENGKAP. Rumus resmi menuntut tarif rata-rata di lembaga keuangan lain, dan
                  sebagian belum diisi. Angka komponen yang belum lengkap tidak ditaksir dan tidak ikut dijumlahkan.
                </Text>
              </View>
            )}

            <ExportButton
              data={
                koperasi
                  ? buildLpeaExport(
                      { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                      laporan,
                      data.rincianShu,
                      'Laporan Promosi Ekonomi Anggota'
                    )
                  : null
              }
            />

            {/* ---------- MANFAAT DARI SIMPAN PINJAM ---------- */}
            <Text style={styles.judulBagian}>Manfaat Ekonomi dari Simpan Pinjam lewat Koperasi</Text>

            {(['PENGHEMATAN_BEBAN_PINJAMAN', 'KELEBIHAN_BALAS_JASA_SIMPANAN'] as const).map((kel, idx) => {
              const anggota = laporan.komponen.filter((k) => k.kelompok === kel);
              const subtotal =
                kel === 'PENGHEMATAN_BEBAN_PINJAMAN'
                  ? laporan.subtotalPenghematanBebanPinjaman
                  : laporan.subtotalKelebihanBalasJasaSimpanan;
              return (
                <ReportSectionCard
                  key={kel}
                  title={LABEL_KELOMPOK_PEA[kel]}
                  nomor={idx === 0 ? 'I' : 'II'}
                  testID={`seksi-${kel.toLowerCase()}`}
                >
                  {anggota.map((k) => (
                    <BarisKomponen key={k.komponen} k={k} />
                  ))}
                  <ReportRow label={`Jumlah ${LABEL_KELOMPOK_PEA[kel]}`} value={subtotal} variant="subtotal" />
                </ReportSectionCard>
              );
            })}

            <View style={styles.band}>
              <Text style={styles.bandLabel}>Jumlah Promosi Ekonomi dari Penyediaan Jasa untuk Anggota</Text>
              <Text style={styles.bandNilai}>{formatRupiah(laporan.jumlahPeaPelayanan)}</Text>
            </View>

            {/* ---------- PEMBAGIAN SHU ---------- */}
            <ReportSectionCard
              title="Promosi Ekonomi pada Akhir Tahun"
              nomor="III"
              testID="seksi-pembagian-shu"
              catatan="Hanya pembagian SHU yang SUDAH diproses yang dihitung. SHU yang baru dihitung atau baru disahkan RAT belum menjadi manfaat yang diterima anggota."
            >
              {laporan.bagianShu.sudahDibagikan ? (
                <>
                  <ReportRow
                    label={`Pembagian SHU untuk anggota (${laporan.bagianShu.jumlahAnggotaPenerima} anggota)`}
                    value={laporan.bagianShu.totalBagianAnggota}
                    indent
                  />
                  {laporan.bagianShu.shuDisahkanRat !== null && (
                    <Text style={styles.rekonsiliasi}>
                      Rekonsiliasi: SHU disahkan RAT {formatRupiah(laporan.bagianShu.shuDisahkanRat)} · bagian
                      anggota yang dibagikan {formatRupiah(laporan.bagianShu.totalBagianAnggota)}. Selisihnya adalah
                      bagian cadangan, dana pendidikan, sosial, pengurus, dan alokasi lain menurut konfigurasi SHU —
                      bukan manfaat anggota.
                    </Text>
                  )}
                </>
              ) : (
                <Text style={styles.statusTeks}>
                  Belum dibagikan. Tidak ada manfaat pembagian SHU yang boleh dilaporkan untuk tahun buku ini.
                </Text>
              )}
            </ReportSectionCard>

            <SummaryCard
              label="Jumlah Promosi Ekonomi Anggota"
              value={laporan.jumlahPeaAnggota}
              caption={
                laporan.totalBelumLengkap
                  ? 'BELUM LENGKAP — sebagian komponen belum dapat dihitung'
                  : `Tahun buku ${laporan.tahunBuku}`
              }
            />

            {/* ---------- PEMBEDAAN TEGAS ---------- */}
            <View style={styles.kartuPembeda}>
              <Text style={styles.kartuPembedaJudul}>Yang BUKAN manfaat ekonomi anggota</Text>
              <Text style={styles.kartuPembedaIsi}>
                • Pendapatan koperasi (jasa pinjaman yang diterima koperasi) — itu penghasilan koperasi, bukan manfaat
                anggota.{'\n'}• Saldo simpanan anggota — itu milik anggota yang dititipkan, bukan manfaat.{'\n'}• Pokok
                pinjaman yang dicairkan — itu utang anggota, bukan manfaat.{'\n'}• SHU yang belum dibagikan — belum
                diterima anggota.{'\n'}Yang dilaporkan di atas hanya SELISIH tarif terhadap lembaga keuangan lain, dan
                pembagian SHU yang benar-benar sudah dibagikan.
              </Text>
            </View>

            {/* ---------- PARAMETER TARIF ---------- */}
            <PanelParameter
              tahunBuku={laporan.tahunBuku}
              parameterAwal={laporan.parameter}
              terbuka={bukaParameter}
              onToggle={() => setBukaParameter((v) => !v)}
              onTersimpan={muat}
            />

            {/* ---------- RINCIAN PER ANGGOTA ---------- */}
            {data.rincianShu.length > 0 && (
              <View style={styles.panel}>
                <TouchableOpacity style={styles.panelHeader} onPress={() => setBukaRincian((v) => !v)}>
                  <Ionicons name="people-outline" size={iconSize.md} color={colors.primary} />
                  <Text style={styles.panelJudul}>Rincian Pembagian SHU per Anggota</Text>
                  <Ionicons
                    name={bukaRincian ? 'chevron-up' : 'chevron-down'}
                    size={iconSize.md}
                    color={colors.textFaint}
                  />
                </TouchableOpacity>
                {bukaRincian && (
                  <View style={styles.panelIsi}>
                    {data.rincianShu.map((r) => (
                      <View key={r.nomorAnggota} style={styles.barisAnggota}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.anggotaNama}>{r.namaLengkap}</Text>
                          <Text style={styles.anggotaSub}>
                            {r.nomorAnggota} · jasa modal {formatRupiah(r.jasaModal)} · jasa usaha{' '}
                            {formatRupiah(r.jasaUsaha)}
                          </Text>
                        </View>
                        <Text style={styles.anggotaNilai}>{formatRupiah(r.totalShuAnggota)}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* ---------- KETERBATASAN ---------- */}
            <View style={styles.kartuKeterbatasan}>
              <Text style={styles.kartuKeterbatasanJudul}>Keterbatasan &amp; Catatan</Text>
              {laporan.keterbatasan.map((k, i) => (
                <Text key={`b-${i}`} style={styles.keterbatasanItem}>
                  • {k}
                </Text>
              ))}
              {KETERBATASAN_STRUKTURAL.map((k, i) => (
                <Text key={`s-${i}`} style={styles.keterbatasanItem}>
                  • {k}
                </Text>
              ))}
            </View>
          </>
        )}

        {!loading && !error && !laporan && <EmptyState message="Belum ada data untuk laporan ini." />}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

/** Satu baris komponen A–D. Status non-DIHITUNG ditulis sebagai teks, bukan nol. */
function BarisKomponen({ k }: { k: HasilKomponenPea }) {
  if (k.status !== 'DIHITUNG') {
    return (
      <View style={styles.barisBelum}>
        <View style={{ flex: 1 }}>
          <Text style={styles.barisBelumLabel}>
            {k.label} <Text style={styles.huruf}>({k.huruf})</Text>
          </Text>
          {k.totalBasis > 0 && (
            <Text style={styles.barisBelumSub}>
              Basis tersedia {formatRupiah(k.totalBasis)} dari {k.jumlahBaris} transaksi
            </Text>
          )}
          {k.parameterKurang.length > 0 && (
            <Text style={styles.barisBelumSub}>
              Belum diisi: {k.parameterKurang.map((p) => LABEL_PARAMETER_LPEA[p] ?? p).join(', ')}
            </Text>
          )}
        </View>
        <Text style={styles.badgeStatus}>{LABEL_STATUS_KOMPONEN[k.status]}</Text>
      </View>
    );
  }
  return (
    <View>
      <ReportRow label={`${k.label} (${k.huruf})`} value={k.nilai} indent />
      <Text style={styles.barisJejak}>
        Basis {formatRupiah(k.totalBasis)} · {k.jumlahBaris} transaksi · tarif koperasi{' '}
        {k.tarifKoperasiPersenPerBulan === null ? 'per transaksi' : `${k.tarifKoperasiPersenPerBulan}%`} vs luar{' '}
        {k.tarifLuarPersenPerBulan}% per bulan
      </Text>
    </View>
  );
}

/** Panel pengisian tarif pembanding — data yang WAJIB dari koperasi, bukan asumsi aplikasi. */
function PanelParameter({
  tahunBuku,
  parameterAwal,
  terbuka,
  onToggle,
  onTersimpan,
}: {
  tahunBuku: number;
  parameterAwal: ParameterLpea;
  terbuka: boolean;
  onToggle: () => void;
  onTersimpan: () => void;
}) {
  const [nilai, setNilai] = useState<Record<string, string>>(() => teksDariParameter(parameterAwal));
  const [sumber, setSumber] = useState(parameterAwal.sumberAcuan ?? '');
  const [menyimpan, setMenyimpan] = useState(false);

  const simpan = async () => {
    setMenyimpan(true);
    try {
      const p: ParameterLpea = { ...parameterLpeaKosong(tahunBuku), sumberAcuan: sumber.trim() || null };
      for (const kunci of KUNCI_TARIF) {
        const teks = (nilai[kunci] ?? '').trim().replace(',', '.');
        // Kosong berarti BELUM DIISI (null), bukan nol.
        p[kunci] = teks === '' ? null : Number(teks);
      }
      const tidakSah = KUNCI_TARIF.filter((k) => p[k] !== null && !Number.isFinite(p[k] as number));
      if (tidakSah.length > 0) {
        notify('Tidak dapat disimpan', 'Ada tarif yang bukan angka. Kosongkan bila belum diketahui.');
        return;
      }
      await setParameterLpea(p);
      notify('Tarif disimpan', 'Laporan dihitung ulang memakai tarif yang baru.', undefined, 'success');
      onTersimpan();
    } catch (e) {
      notify('Gagal menyimpan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpan(false);
    }
  };

  return (
    <View style={styles.panel}>
      <TouchableOpacity style={styles.panelHeader} onPress={onToggle} testID="panel-parameter-lpea">
        <Ionicons name="options-outline" size={iconSize.md} color={colors.primary} />
        <Text style={styles.panelJudul}>Tarif Pembanding (Tahun {tahunBuku})</Text>
        <Ionicons name={terbuka ? 'chevron-up' : 'chevron-down'} size={iconSize.md} color={colors.textFaint} />
      </TouchableOpacity>
      {terbuka && (
        <View style={styles.panelIsi}>
          <Text style={styles.panelCatatan}>
            Rumus resmi PEA adalah SELISIH tarif koperasi terhadap tarif rata-rata di lembaga keuangan LAIN — angka yang
            tidak mungkin diketahui aplikasi dan harus ditetapkan koperasi. Semua dalam PERSEN PER BULAN. Biarkan kosong
            bila belum diketahui; komponennya akan ditandai belum dapat dihitung, bukan dianggap nol.
          </Text>
          {KUNCI_TARIF.map((kunci) => (
            <AppTextInput
              key={kunci}
              label={LABEL_PARAMETER_LPEA[kunci] ?? kunci}
              value={nilai[kunci] ?? ''}
              onChangeText={(t) => setNilai((v) => ({ ...v, [kunci]: t }))}
              placeholder="contoh: 1.5"
              keyboardType="decimal-pad"
              noIcon
              testID={`input-${kunci}`}
            />
          ))}
          <AppTextInput
            label="Sumber acuan tarif luar"
            value={sumber}
            onChangeText={setSumber}
            placeholder="contoh: SBDK Bank X, Januari 2026"
            noIcon
          />
          <TouchableOpacity style={styles.tombolSimpan} onPress={simpan} disabled={menyimpan}>
            {menyimpan ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.tombolSimpanText}>Simpan Tarif</Text>
            )}
          </TouchableOpacity>
          {parameterAwal.diperbaruiPada && (
            <Text style={styles.panelCatatan}>Terakhir diperbarui: {parameterAwal.diperbaruiPada.slice(0, 10)}</Text>
          )}
        </View>
      )}
    </View>
  );
}

const KUNCI_TARIF = [
  'tarifLuarJasaPinjaman',
  'tarifKoperasiJasaProvisi',
  'tarifLuarJasaProvisi',
  'tarifKoperasiTabungan',
  'tarifLuarTabungan',
  'tarifLuarSimpananBerjangka',
] as const satisfies readonly (keyof ParameterLpea)[];

function teksDariParameter(p: ParameterLpea): Record<string, string> {
  const hasil: Record<string, string> = {};
  for (const k of KUNCI_TARIF) {
    const v = p[k];
    hasil[k] = typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  }
  return hasil;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  kop: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopWidth: 3,
    borderTopColor: colors.primary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  kopKoperasi: { fontSize: 15, fontWeight: '800', color: colors.primary, textAlign: 'center' },
  kopJudul: { fontSize: 13, fontWeight: '700', color: colors.text, marginTop: 2, textAlign: 'center' },
  kopPeriode: { fontSize: 12, color: colors.textMuted, marginTop: 2, textAlign: 'center' },
  kopStandar: { fontSize: 10, color: colors.textFaint, marginTop: spacing.xs, textAlign: 'center' },

  labelFilter: { ...ui.sectionLabel },
  tahunBaris: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.md },
  chipTahun: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipTahunAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTahunText: { fontSize: 13, fontWeight: '600', color: colors.text },
  chipTahunTextAktif: { color: colors.white },

  error: { color: colors.danger, textAlign: 'center', marginTop: spacing.lg },

  bannerBelumLengkap: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  bannerBelumLengkapText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },

  judulBagian: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },

  barisBelum: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.sm },
  barisBelumLabel: { fontSize: 13, color: colors.text },
  huruf: { fontSize: 11, color: colors.textFaint },
  barisBelumSub: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  badgeStatus: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.warning,
    backgroundColor: colors.warningBg,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  barisJejak: { fontSize: 10, color: colors.textFaint, paddingLeft: spacing.md, marginTop: -2, marginBottom: 4 },
  statusTeks: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', paddingVertical: spacing.xs },
  rekonsiliasi: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: spacing.xs },

  band: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  bandLabel: { fontSize: 11, fontWeight: '800', color: colors.white, textTransform: 'uppercase', letterSpacing: 0.3 },
  bandNilai: { fontSize: 17, fontWeight: '800', color: colors.white, fontVariant: ['tabular-nums'], marginTop: 2 },

  kartuPembeda: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  kartuPembedaJudul: { fontSize: 12, fontWeight: '800', color: colors.danger, marginBottom: spacing.xs },
  kartuPembedaIsi: { fontSize: 11, color: colors.text, lineHeight: 17 },

  panel: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.focusBg,
  },
  panelJudul: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text },
  panelIsi: { padding: spacing.md, gap: spacing.xs },
  panelCatatan: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  tombolSimpan: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  tombolSimpanText: { fontSize: 13, fontWeight: '700', color: colors.white },

  barisAnggota: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  anggotaNama: { fontSize: 12, color: colors.text, fontWeight: '600' },
  anggotaSub: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  anggotaNilai: { fontSize: 12, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },

  kartuKeterbatasan: {
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.xl,
  },
  kartuKeterbatasanJudul: { fontSize: 12, fontWeight: '800', color: colors.text, marginBottom: spacing.xs },
  keterbatasanItem: { fontSize: 11, color: colors.text, lineHeight: 17, marginBottom: 3 },
});
