import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import {
  catatImbalanKerja,
  bayarImbalanKerja,
  listImbalanKerja,
  getSaldoUtangImbalanKerjaSaatIni,
  periodKeyDariTanggalImbalan,
  getNilaiAwalImbalan,
  simpanNilaiAwalImbalan,
  hapusNilaiAwalImbalan,
  JENIS_IMBALAN,
  type ImbalanKerjaRow,
  type JenisImbalan,
  type NilaiAwalImbalan,
} from '@/services/ImbalanKerjaService';
import { listPersonel, type PersonelRow } from '@/services/KoperasiMasterService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize, radius, spacing, touchTarget } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';
import DatePicker, { formatTanggalIndonesia } from '@/components/DatePicker';
import CurrencyInput from '@/components/CurrencyInput';
import RekeningPicker from '@/components/RekeningPicker';
import FocusTextInput from '@/components/FocusTextInput';
import { RekeningItem } from '@/services/KasBankService';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  labelJenisImbalan,
  labelJenisPersonel,
  labelStatusImbalan,
  ringkasanDaftarImbalan,
  saringImbalan,
  KELOMPOK_JENIS_IMBALAN,
  selisihHariKalender,
  tambahHariKalender,
  type FilterImbalan,
} from '@/utils/imbalanKerjaUi';

/**
 * IMBALAN KERJA — dua bagian yang jelas: "Catat Imbalan" dan "Daftar &
 * Pembayaran". Penyederhanaan tampilan (permintaan pengguna):
 *
 *   Catat: (1) pilih penerima dari master personel, (2) pilih jenis
 *   imbalan, (3) isi nilai & tanggal. Rincian yang jarang diubah (dasar
 *   perhitungan, jatuh tempo, keterangan) dilipat di "Rincian tambahan".
 *   Nilai bulan lalu dapat diingat dan diisikan otomatis (tetap bisa
 *   diubah sebelum disimpan).
 *
 *   Bayar: tiap baris "Belum Dibayar" punya tombol Bayar sendiri; sumber
 *   dana (Kas/Bank) dipilih di lembar konfirmasi baris itu, bukan di
 *   pilihan global yang berlaku untuk semua baris.
 *
 * SELURUH keputusan akuntansi tetap di `ImbalanKerjaService`: pengakuan
 * Dr Beban Imbalan Kerja / Cr Utang Imbalan Kerja lewat
 * `catatImbalanKerja()`, pembayaran Dr Utang / Cr Kas-Bank lewat
 * `bayarImbalanKerja()`. Layar ini tidak menghitung dan tidak menjurnal
 * apa pun; jenis personel & jabatan dibaca service dari master.
 */

const LABEL_BULAN = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

/** 'YYYY-MM' -> 'September 2026' UNTUK TAMPILAN SAJA (service tetap menerima periodKey mentah). */
function labelPeriode(periodKey: string): string {
  const [th, bl] = periodKey.split('-');
  const idx = parseInt(bl, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx > 11) return periodKey;
  return `${LABEL_BULAN[idx]} ${th}`;
}

type Tampilan = 'CATAT' | 'DAFTAR';

export default function ImbalanKerjaFormScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [tampilan, setTampilan] = useState<Tampilan>('CATAT');
  const [saldo, setSaldo] = useState<number | null>(null);
  const [personel, setPersonel] = useState<PersonelRow[]>([]);
  const [daftar, setDaftar] = useState<ImbalanKerjaRow[]>([]);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [membayar, setMembayar] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterImbalan>('BELUM');

  // ---- isian Catat Imbalan
  const [pilihPenerimaOpen, setPilihPenerimaOpen] = useState(false);
  const [penerimaId, setPenerimaId] = useState<string | null>(null);
  const [jenisImbalan, setJenisImbalan] = useState<JenisImbalan>('HONORARIUM');
  const [nilai, setNilai] = useState<number | ''>('');
  const [tanggalPengakuan, setTanggalPengakuan] = useState(getTanggalLokalHariIni());
  /** Jatuh tempo disimpan sebagai jarak hari dari tanggal pengakuan (default 0 = hari yang sama). */
  const [jarakJatuhTempo, setJarakJatuhTempo] = useState(0);
  const [rincianTerbuka, setRincianTerbuka] = useState(false);
  const [dasar, setDasar] = useState<number | ''>('');
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [nilaiAwal, setNilaiAwal] = useState<NilaiAwalImbalan | null>(null);
  const [ingatNilai, setIngatNilai] = useState(false);

  // ---- lembar Bayar (per baris)
  const [barisBayar, setBarisBayar] = useState<ImbalanKerjaRow | null>(null);
  const [sumberDana, setSumberDana] = useState<'KAS' | 'BANK'>('KAS');
  const [rekeningBank, setRekeningBank] = useState<RekeningItem | null>(null);
  const bankAccountId = rekeningBank?.id ?? null;

  /** Periode DITURUNKAN dari tanggal pengakuan — satu sumber tanggal. */
  const periodKey = useMemo(() => periodKeyDariTanggalImbalan(tanggalPengakuan), [tanggalPengakuan]);
  const tanggalJatuhTempo = useMemo(
    () => tambahHariKalender(tanggalPengakuan, jarakJatuhTempo),
    [tanggalPengakuan, jarakJatuhTempo]
  );
  const penerima = useMemo(() => personel.find((p) => p.id === penerimaId) ?? null, [personel, penerimaId]);
  const keteranganJenis = KELOMPOK_JENIS_IMBALAN.find((k) => k.jenis.includes(jenisImbalan))?.keterangan ?? '';

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(null);
    try {
      const [orang, imbalan, s] = await Promise.all([
        listPersonel({ hanyaAktif: true }),
        listImbalanKerja(),
        getSaldoUtangImbalanKerjaSaatIni(),
      ]);
      setPersonel(orang);
      setDaftar(imbalan);
      setSaldo(s);
    } catch (e) {
      setGalat(e instanceof Error ? e.message : 'Data imbalan kerja gagal dimuat.');
    } finally {
      setMemuat(false);
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);

  /**
   * Nilai yang diingat (bila ada) untuk penerima + jenis ini diisikan ke
   * form. Operator tetap bebas mengubahnya sebelum menyimpan.
   */
  useEffect(() => {
    let batal = false;
    setNilaiAwal(null);
    setIngatNilai(false);
    if (!penerimaId) return;
    getNilaiAwalImbalan(penerimaId, jenisImbalan)
      .then((n) => {
        if (batal || !n) return;
        setNilaiAwal(n);
        setIngatNilai(true);
        setNilai(n.nilaiImbalan > 0 ? n.nilaiImbalan : '');
        setDasar(n.dasarPerhitungan > 0 ? n.dasarPerhitungan : '');
        setKeterangan(n.keterangan ?? '');
        setJarakJatuhTempo(n.selisihHariJatuhTempo);
      })
      .catch(() => undefined);
    return () => {
      batal = true;
    };
  }, [penerimaId, jenisImbalan]);

  const lupakanNilai = async () => {
    if (!penerimaId || !currentUser) return;
    try {
      await hapusNilaiAwalImbalan(penerimaId, jenisImbalan, currentUser.id);
      setNilaiAwal(null);
      setIngatNilai(false);
    } catch (err) {
      notify('Gagal', err instanceof Error ? err.message : 'Nilai tersimpan gagal dihapus.');
    }
  };

  /** Validasi layar — CERMIN aturan service, bukan aturan tambahan. */
  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!penerimaId) e.penerima = 'Pilih penerima terlebih dahulu.';
    if (nilai === '' || nilai <= 0) e.nilai = 'Isi nilai imbalan, lebih dari 0.';
    if (!tanggalPengakuan) e.tanggalPengakuan = 'Tanggal wajib diisi.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const simpanDanJurnal = async () => {
    if (!validate() || !currentUser) return;
    setSubmitting(true);
    try {
      const hasil = await catatImbalanKerja({
        personelId: penerimaId as string,
        periodKey,
        jenisImbalan,
        dasarPerhitungan: dasar === '' ? 0 : dasar,
        nilaiImbalan: nilai as number,
        tanggalPengakuan,
        tanggalJatuhTempo,
        keterangan: keterangan.trim() === '' ? undefined : keterangan.trim(),
        createdBy: currentUser.id,
      });

      // Ringkasan dari hasil NYATA yang dikembalikan database.
      notify(
        'Imbalan kerja berhasil dicatat.',
        `${labelJenisImbalan(hasil.jenisImbalan)} ${hasil.namaPenerima} · ${labelPeriode(hasil.periodKey)} · ` +
          `${formatRupiah(hasil.nilaiImbalan)}\nStatus ${labelStatusImbalan(hasil.status)} · jurnal pengakuan tercatat.`
      );

      // Nilai yang diingat hanya mengisi form bulan berikutnya; gagal di
      // sini tidak membatalkan imbalan yang sudah tercatat.
      if (ingatNilai) {
        try {
          await simpanNilaiAwalImbalan(
            hasil.personelId,
            hasil.jenisImbalan,
            {
              dasarPerhitungan: dasar === '' ? 0 : dasar,
              nilaiImbalan: nilai as number,
              selisihHariJatuhTempo: jarakJatuhTempo,
              keterangan: keterangan.trim() === '' ? null : keterangan.trim(),
            },
            currentUser.id
          );
        } catch {
          notify('Nilai belum diingat', 'Imbalan sudah tercatat, tetapi nilai untuk bulan berikutnya gagal disimpan.');
        }
      } else if (nilaiAwal) {
        await hapusNilaiAwalImbalan(hasil.personelId, hasil.jenisImbalan, currentUser.id).catch(() => undefined);
      }

      setFilter('BELUM');
      setPenerimaId(null);
      setDasar('');
      setNilai('');
      setKeterangan('');
      setJarakJatuhTempo(0);
      setRincianTerbuka(false);
      await muat();
    } catch (err) {
      notify('Gagal menyimpan', err instanceof Error ? err.message : 'Imbalan kerja gagal dicatat.');
    } finally {
      setSubmitting(false);
    }
  };

  const bukaBayar = (row: ImbalanKerjaRow) => {
    setSumberDana('KAS');
    setRekeningBank(null);
    setBarisBayar(row);
  };

  const bayar = async (row: ImbalanKerjaRow) => {
    if (!currentUser) return;
    if (sumberDana === 'BANK' && !bankAccountId) {
      notify('Tidak dapat dibayar', 'Pilih rekening bank terlebih dahulu.');
      return;
    }
    setMembayar(row.id);
    try {
      await bayarImbalanKerja({
        imbalanId: row.id,
        tanggal: getTanggalLokalHariIni(),
        sumberDana,
        bankAccountId: sumberDana === 'BANK' ? (bankAccountId as string) : undefined,
        createdBy: currentUser.id,
      });
      setBarisBayar(null);
      notify(
        'Pembayaran berhasil.',
        `${labelJenisImbalan(row.jenisImbalan)} ${row.namaPenerima} · ${formatRupiah(row.nilaiImbalan)} dibayar dari ${sumberDana === 'BANK' ? rekeningBank?.nama ?? 'Bank' : 'Kas'}.`
      );
      await muat();
    } catch (err) {
      notify('Gagal membayar', err instanceof Error ? err.message : 'Pembayaran imbalan gagal.');
    } finally {
      setMembayar(null);
    }
  };

  const ringkas = ringkasanDaftarImbalan(daftar);
  const tampil = saringImbalan(daftar, filter);

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}>
        {/* RINGKASAN — saldo 2-1600 dari service. */}
        <View style={styles.saldoCard}>
          <Text style={styles.saldoLabel}>UTANG IMBALAN KERJA SAAT INI</Text>
          {memuat ? (
            <ActivityIndicator color={colors.textMuted} style={{ alignSelf: 'flex-start', marginTop: spacing.xs }} />
          ) : (
            <Text style={styles.saldoValue}>{formatRupiah(saldo ?? 0)}</Text>
          )}
          <Text style={styles.saldoSub}>
            {ringkas.jumlahBelum > 0
              ? `${ringkas.jumlahBelum} imbalan belum dibayar · ${formatRupiah(ringkas.nilaiBelum)}`
              : 'Tidak ada imbalan yang belum dibayar.'}
          </Text>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => navigation.navigate('Laporan', { screen: 'BukuBesar' })}
            accessibilityRole="button"
            accessibilityLabel="Lihat riwayat lengkap di Buku Besar"
          >
            <Text style={styles.linkBukuBesar}>Lihat riwayat lengkap di Buku Besar</Text>
            <Ionicons name="chevron-forward" size={iconSize.sm} color={colors.textFaint} />
          </TouchableOpacity>
        </View>

        {galat !== null && (
          <View style={styles.kondisi}>
            <Text style={styles.errorText}>{galat}</Text>
            <TouchableOpacity onPress={() => void muat()}>
              <Text style={styles.linkBukuBesar}>Coba lagi</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* DUA BAGIAN: Catat | Daftar & Bayar */}
        <View style={styles.tabUtama}>
          {(
            [
              ['CATAT', 'Catat Imbalan'],
              ['DAFTAR', ringkas.jumlahBelum > 0 ? `Daftar & Bayar (${ringkas.jumlahBelum})` : 'Daftar & Bayar'],
            ] as const
          ).map(([k, label]) => (
            <TouchableOpacity
              key={k}
              accessibilityRole="tab"
              accessibilityState={{ selected: tampilan === k }}
              style={[styles.tabUtamaItem, tampilan === k && styles.tabUtamaItemAktif]}
              onPress={() => setTampilan(k)}
            >
              <Text style={[styles.tabUtamaText, tampilan === k && styles.tabUtamaTextAktif]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {tampilan === 'CATAT' ? (
          <View style={styles.card}>
            {/* 1 — PENERIMA */}
            <Langkah nomor={1} judul="Penerima" />
            {personel.length === 0 && !memuat ? (
              <View style={styles.kosongBox}>
                <Text style={styles.hint}>
                  Belum ada personel aktif. Tambahkan Pengurus/Pengawas/Karyawan lewat Pengaturan → Identitas Koperasi →
                  Administrasi.
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Pilih penerima"
                style={[styles.selector, !!errors.penerima && styles.selectorError]}
                onPress={() => setPilihPenerimaOpen(true)}
              >
                <Ionicons name="person-outline" size={18} color={colors.textMuted} />
                <Text style={penerima ? styles.selectorText : styles.selectorPlaceholder} numberOfLines={1}>
                  {penerima ? penerima.nama : 'Pilih penerima...'}
                </Text>
                <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} />
              </TouchableOpacity>
            )}
            {errors.penerima && <Text style={styles.errorText}>{errors.penerima}</Text>}

            {/* Jenis Personel & Jabatan READ-ONLY — cerminan baris master yang dibaca service. */}
            {penerima ? (
              <View style={[styles.duaKolom, styles.jarakKecil]}>
                <View style={styles.kolom}>
                  <Text style={styles.labelKecil}>Jenis Personel</Text>
                  <View style={styles.readonlyBox}>
                    <Text style={styles.readonlyValue}>{labelJenisPersonel(penerima.jenisPersonel)}</Text>
                  </View>
                </View>
                <View style={styles.kolom}>
                  <Text style={styles.labelKecil}>Jabatan</Text>
                  <View style={styles.readonlyBox}>
                    <Text style={styles.readonlyValue} numberOfLines={1}>{penerima.jabatan ?? '-'}</Text>
                  </View>
                </View>
              </View>
            ) : null}

            {/* 2 — JENIS IMBALAN */}
            <Langkah nomor={2} judul="Jenis Imbalan" />
            <View style={styles.chipRow}>
              {JENIS_IMBALAN.map((j) => {
                const aktif = jenisImbalan === j;
                return (
                  <TouchableOpacity
                    key={j}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: aktif }}
                    style={[styles.chip, aktif && styles.chipAktif]}
                    onPress={() => setJenisImbalan(j)}
                  >
                    <Text style={[styles.chipText, aktif && styles.chipTextAktif]}>{labelJenisImbalan(j)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.hint}>{keteranganJenis}</Text>

            {/* 3 — NILAI & TANGGAL */}
            <Langkah nomor={3} judul="Nilai & Tanggal" />
            <Text style={styles.label}>{jenisImbalan === 'HONORARIUM' ? 'Nilai Honorarium *' : 'Nilai Imbalan *'}</Text>
            <CurrencyInput value={nilai} onChangeValue={setNilai} placeholder="0" />
            {errors.nilai && <Text style={styles.errorText}>{errors.nilai}</Text>}
            {nilaiAwal ? (
              <View style={styles.infoBaris}>
                <Ionicons name="refresh-outline" size={14} color={colors.textMuted} />
                <Text style={styles.infoText}>Diisi dari nilai bulan lalu — boleh diubah.</Text>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Lupakan nilai tersimpan" onPress={() => void lupakanNilai()}>
                  <Text style={styles.linkKecil}>Lupakan</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <Text style={[styles.label, styles.jarak]}>Tanggal *</Text>
            <DatePicker value={tanggalPengakuan} onChange={setTanggalPengakuan} />
            {errors.tanggalPengakuan && <Text style={styles.errorText}>{errors.tanggalPengakuan}</Text>}
            <Text style={styles.hint}>
              Dicatat untuk periode <Text style={styles.tebal}>{labelPeriode(periodKey)}</Text>.
            </Text>

            {/* RINCIAN TAMBAHAN — dilipat supaya form utama tetap pendek. */}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ expanded: rincianTerbuka }}
              style={styles.lipatan}
              onPress={() => setRincianTerbuka((v) => !v)}
            >
              <Text style={styles.lipatanText}>Rincian tambahan (opsional)</Text>
              <Ionicons name={rincianTerbuka ? 'chevron-up' : 'chevron-down'} size={iconSize.sm} color={colors.textMuted} />
            </TouchableOpacity>
            {rincianTerbuka ? (
              <View style={styles.rincianBox}>
                <Text style={styles.label}>Jatuh Tempo Pembayaran</Text>
                <DatePicker
                  value={tanggalJatuhTempo}
                  onChange={(v: string) => setJarakJatuhTempo(selisihHariKalender(tanggalPengakuan, v))}
                />
                <Text style={styles.hint}>Bawaan: sama dengan tanggal pencatatan. Tidak bisa sebelum tanggal pencatatan.</Text>

                <Text style={[styles.label, styles.jarak]}>
                  {jenisImbalan === 'GAJI' || jenisImbalan === 'TUNJANGAN' ? 'Gaji Pokok / Dasar Perhitungan' : 'Dasar Perhitungan'}
                </Text>
                <CurrencyInput value={dasar} onChangeValue={setDasar} placeholder="0" />
                <Text style={styles.hint}>Sebagai catatan saja; yang dibukukan adalah nilai imbalan di atas.</Text>

                <Text style={[styles.label, styles.jarak]}>Keterangan</Text>
                <FocusTextInput
                  style={[styles.input, styles.textArea]}
                  value={keterangan}
                  onChangeText={setKeterangan}
                  placeholder="Mis. honor rapat pengurus Oktober"
                  placeholderTextColor={colors.placeholder}
                  multiline
                />
              </View>
            ) : null}

            {/* RINGKASAN sebelum simpan — bahasa sehari-hari, jurnal sebagai keterangan kecil. */}
            {penerima && nilai !== '' && nilai > 0 ? (
              <View style={styles.ringkasan}>
                <Text style={styles.ringkasanJudul}>
                  {labelJenisImbalan(jenisImbalan)} untuk {penerima.nama}
                </Text>
                <Text style={styles.ringkasanNilai}>{formatRupiah(nilai)}</Text>
                <Text style={styles.ringkasanSub}>
                  {labelPeriode(periodKey)} · jatuh tempo {formatTanggalIndonesia(tanggalJatuhTempo)} · dicatat sebagai utang, dibayar kemudian
                </Text>
                <Text style={styles.ringkasanJurnal}>Jurnal: Beban Imbalan Kerja (D) / Utang Imbalan Kerja (K)</Text>
              </View>
            ) : null}

            <TouchableOpacity
              accessibilityRole="checkbox"
              accessibilityState={{ checked: ingatNilai, disabled: !penerimaId }}
              style={styles.centangBaris}
              onPress={() => setIngatNilai((v) => !v)}
              disabled={!penerimaId}
            >
              <Ionicons name={ingatNilai ? 'checkbox' : 'square-outline'} size={iconSize.sm + 4} color={ingatNilai ? colors.text : colors.textMuted} />
              <Text style={[styles.centangText, !penerimaId && styles.centangNonaktif]}>Ingat nilai ini untuk bulan berikutnya</Text>
            </TouchableOpacity>

            {/* Tombol dinonaktifkan selama menyimpan; penjamin sebenarnya tetap
                UNIQUE(personel_id, period_key, jenis_imbalan) di database. */}
            <TouchableOpacity
              style={[styles.submitButton, submitting && styles.disabled]}
              onPress={() => void simpanDanJurnal()}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.submitButtonText}>SIMPAN &amp; JURNAL</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.card}>
            <View style={styles.tabRow}>
              {(
                [
                  ['BELUM', `Belum Dibayar (${ringkas.jumlahBelum})`],
                  ['SUDAH', `Sudah Dibayar (${ringkas.jumlahSudah})`],
                  ['SEMUA', 'Semua'],
                ] as const
              ).map(([k, label]) => (
                <TouchableOpacity
                  key={k}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: filter === k }}
                  style={[styles.tab, filter === k && styles.tabAktif]}
                  onPress={() => setFilter(k)}
                >
                  <Text style={[styles.tabText, filter === k && styles.tabTextAktif]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {memuat ? (
              <ActivityIndicator color={colors.textMuted} style={{ marginTop: spacing.lg }} />
            ) : daftar.length === 0 ? (
              <Text style={styles.kosongText}>Belum ada imbalan kerja yang dicatat.</Text>
            ) : tampil.length === 0 ? (
              <Text style={styles.kosongText}>
                {filter === 'BELUM' ? 'Semua imbalan sudah dibayar.' : 'Belum ada imbalan yang dibayar.'}
              </Text>
            ) : (
              tampil.map((row) => (
                <View key={row.id} style={styles.baris}>
                  <View style={styles.barisAtas}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.barisJudul} numberOfLines={1}>{row.namaPenerima}</Text>
                      <Text style={styles.barisDetail} numberOfLines={1}>
                        {labelJenisImbalan(row.jenisImbalan)} · {labelPeriode(row.periodKey)}
                        {row.jabatan ? ` · ${row.jabatan}` : ` · ${labelJenisPersonel(row.jenisPersonel)}`}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={styles.barisNominal}>{formatRupiah(row.nilaiImbalan)}</Text>
                      <View style={[styles.badge, row.status === 'PAID' ? styles.badgePaid : styles.badgePosted]}>
                        <Text style={styles.badgeText}>{labelStatusImbalan(row.status)}</Text>
                      </View>
                    </View>
                  </View>
                  <Text style={styles.barisTanggal}>
                    {row.tanggalPembayaran
                      ? `Dibayar ${formatTanggalIndonesia(row.tanggalPembayaran)}`
                      : `Jatuh tempo ${formatTanggalIndonesia(row.tanggalJatuhTempo)}`}
                  </Text>
                  {row.keterangan ? <Text style={styles.barisKeterangan} numberOfLines={2}>{row.keterangan}</Text> : null}

                  {row.status === 'POSTED' && (
                    <TouchableOpacity
                      style={[styles.tombolBayar, membayar === row.id && styles.disabled]}
                      onPress={() => bukaBayar(row)}
                      disabled={membayar === row.id}
                      accessibilityRole="button"
                    >
                      <Text style={styles.tombolBayarText}>Bayar</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))
            )}
          </View>
        )}
      </ScrollView>

      {/* PILIH PENERIMA */}
      <Modal visible={pilihPenerimaOpen} animationType="slide" onRequestClose={() => setPilihPenerimaOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Penerima</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Tutup" style={styles.closeIcon} onPress={() => setPilihPenerimaOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg }}>
            {personel.map((p) => (
              <TouchableOpacity
                key={p.id}
                accessibilityRole="button"
                style={[styles.pickRow, penerimaId === p.id && styles.pickRowAktif]}
                onPress={() => {
                  setPenerimaId(p.id);
                  setErrors((e) => ({ ...e, penerima: '' }));
                  setPilihPenerimaOpen(false);
                }}
              >
                <Text style={styles.pickTitle}>{p.nama}</Text>
                <Text style={styles.pickSub}>
                  {labelJenisPersonel(p.jenisPersonel)}
                  {p.jabatan ? ` · ${p.jabatan}` : ''}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* LEMBAR BAYAR — per baris, sumber dana dipilih di sini. */}
      <Modal visible={barisBayar !== null} transparent animationType="slide" onRequestClose={() => setBarisBayar(null)}>
        <View style={styles.lembarLatar}>
          <View style={styles.lembar}>
            {barisBayar ? (
              <>
                <Text style={styles.lembarJudul}>Bayar Imbalan</Text>
                <Text style={styles.lembarSub}>
                  {labelJenisImbalan(barisBayar.jenisImbalan)} {barisBayar.namaPenerima} · {labelPeriode(barisBayar.periodKey)}
                </Text>
                <Text style={styles.lembarNilai}>{formatRupiah(barisBayar.nilaiImbalan)}</Text>

                <Text style={[styles.label, styles.jarak]}>Dibayar dari</Text>
                <View style={styles.segmen}>
                  {(['KAS', 'BANK'] as const).map((s) => (
                    <TouchableOpacity
                      key={s}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: sumberDana === s }}
                      style={[styles.segmenItem, sumberDana === s && styles.segmenItemAktif]}
                      onPress={() => setSumberDana(s)}
                    >
                      <Text style={[styles.segmenText, sumberDana === s && styles.segmenTextAktif]}>{s === 'KAS' ? 'Kas' : 'Bank'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {sumberDana === 'BANK' && (
                  // Hanya rekening BANK — kas tidak boleh muncul di picker ini.
                  <RekeningPicker label="Rekening Bank" value={rekeningBank} onChange={setRekeningBank} hanyaBank />
                )}
                <Text style={styles.hint}>Pembayaran dicatat hari ini ({formatTanggalIndonesia(getTanggalLokalHariIni())}).</Text>

                <View style={styles.lembarAksi}>
                  <TouchableOpacity accessibilityRole="button" style={styles.tombolBatal} onPress={() => setBarisBayar(null)}>
                    <Text style={styles.tombolBatalText}>Batal</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    style={[styles.tombolKonfirmasi, membayar === barisBayar.id && styles.disabled]}
                    onPress={() => void bayar(barisBayar)}
                    disabled={membayar === barisBayar.id}
                  >
                    {membayar === barisBayar.id ? (
                      <ActivityIndicator color={colors.white} />
                    ) : (
                      <Text style={styles.submitButtonText}>Bayar {formatRupiah(barisBayar.nilaiImbalan)}</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </AreaAmanKeyboard>
  );
}

function Langkah({ nomor, judul }: { nomor: number; judul: string }) {
  return (
    <View style={styles.langkah}>
      <View style={styles.langkahNomor}>
        <Text style={styles.langkahNomorText}>{nomor}</Text>
      </View>
      <Text style={styles.langkahJudul}>{judul}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  saldoCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  saldoLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 },
  saldoValue: { fontSize: 24, fontWeight: '700', color: colors.text, marginTop: spacing.xs },
  saldoSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: touchTarget - 8, marginTop: spacing.xs },
  linkBukuBesar: { fontSize: 12, color: colors.primary, fontWeight: '600' },
  kondisi: { marginBottom: spacing.md },

  tabUtama: { flexDirection: 'row', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 4, marginBottom: spacing.md },
  tabUtamaItem: { flex: 1, paddingVertical: spacing.sm + 2, borderRadius: radius.sm, alignItems: 'center' },
  tabUtamaItemAktif: { backgroundColor: colors.primary },
  tabUtamaText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  tabUtamaTextAktif: { color: colors.white },

  card: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md },
  langkah: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md, marginBottom: spacing.sm },
  langkahNomor: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  langkahNomorText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  langkahJudul: { fontSize: 14, fontWeight: '700', color: colors.text },

  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.xs + 2 },
  labelKecil: { fontSize: 11, color: colors.textMuted, marginBottom: 4 },
  jarak: { marginTop: spacing.md },
  jarakKecil: { marginTop: spacing.sm },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 15 },
  tebal: { fontWeight: '700', color: colors.text },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  input: { ...formUi.inputStandalone },
  textArea: { minHeight: 72, textAlignVertical: 'top' },

  selector: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, minHeight: 48 },
  selectorError: { borderColor: colors.danger },
  selectorText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text },
  selectorPlaceholder: { flex: 1, fontSize: 14, color: colors.placeholder },
  kosongBox: { backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.md },

  duaKolom: { flexDirection: 'row', gap: spacing.sm },
  kolom: { flex: 1, minWidth: 0 },
  readonlyBox: { backgroundColor: colors.background, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  readonlyValue: { fontSize: 13, color: colors.text },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  chipAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text, fontWeight: '600' },
  chipTextAktif: { color: colors.white },

  infoBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  infoText: { flex: 1, fontSize: 11, color: colors.textMuted },
  linkKecil: { fontSize: 12, fontWeight: '600', color: colors.textMuted, textDecorationLine: 'underline' },

  lipatan: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  lipatanText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  rincianBox: { paddingTop: spacing.xs },

  ringkasan: { backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.md },
  ringkasanJudul: { fontSize: 12, fontWeight: '600', color: colors.text },
  ringkasanNilai: { fontSize: 20, fontWeight: '800', color: colors.text, marginTop: 2, fontVariant: ['tabular-nums'] },
  ringkasanSub: { fontSize: 11, color: colors.textMuted, marginTop: 4, lineHeight: 15 },
  ringkasanJurnal: { fontSize: 10.5, color: colors.textMuted, marginTop: 6 },

  centangBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md, minHeight: 36 },
  centangText: { flex: 1, fontSize: 13, color: colors.text },
  centangNonaktif: { color: colors.textFaint },

  submitButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', marginTop: spacing.md },
  submitButtonText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.5 },

  tabRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm, flexWrap: 'wrap' },
  tab: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  tabAktif: { backgroundColor: colors.text, borderColor: colors.text },
  tabText: { fontSize: 12, fontWeight: '600', color: colors.text },
  tabTextAktif: { color: colors.white },
  kosongText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.lg },

  baris: { borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: spacing.md },
  barisAtas: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  barisJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  barisDetail: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  barisNominal: { fontSize: 14, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  barisTanggal: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs },
  barisKeterangan: { fontSize: 12, color: colors.text, marginTop: 2 },
  badge: { borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2, marginTop: 4 },
  badgePosted: { backgroundColor: colors.warningBg },
  badgePaid: { backgroundColor: colors.primaryLight },
  badgeText: { fontSize: 10, fontWeight: '700', color: colors.text },
  tombolBayar: { alignSelf: 'flex-start', backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.sm },
  tombolBayarText: { color: colors.white, fontWeight: '700', fontSize: 13 },

  segmen: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  segmenItem: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingVertical: spacing.sm + 2, alignItems: 'center' },
  segmenItemAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  segmenText: { fontSize: 13, fontWeight: '600', color: colors.text },
  segmenTextAktif: { color: colors.white },

  modalContainer: { flex: 1, backgroundColor: colors.background },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  modalTitle: { ...modalUi.title },
  closeIcon: { ...modalUi.closeIcon },
  pickRow: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.sm },
  pickRowAktif: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  pickTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  pickSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  lembarLatar: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  lembar: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, paddingBottom: spacing.xl },
  lembarJudul: { fontSize: 16, fontWeight: '700', color: colors.text },
  lembarSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  lembarNilai: { fontSize: 22, fontWeight: '800', color: colors.text, marginTop: spacing.sm, fontVariant: ['tabular-nums'] },
  lembarAksi: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  tombolBatal: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center' },
  tombolBatalText: { fontSize: 15, fontWeight: '600', color: colors.text },
  tombolKonfirmasi: { flex: 2, backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center' },
});
