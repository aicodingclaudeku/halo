import React, { useCallback, useRef, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import RekeningPicker from '@/components/RekeningPicker';
import FocusTextInput from '@/components/FocusTextInput';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { RekeningItem } from '@/services/KasBankService';
import { getInvestasiDetail, LABEL_JENIS_INVESTASI, type InvestasiListItem } from '@/services/InvestasiService';
import {
  catatPenarikanInvestasi,
  getStatusPenarikanInvestasi,
  pratinjauPenarikanInvestasi,
  type ModePenarikan,
  type PenarikanInvestasiInput,
  type PratinjauPenarikanInvestasi,
  type StatusPenarikanInvestasi,
} from '@/services/PenarikanInvestasiService';
import { getNilaiInvestasiTampilan, type NilaiInvestasiTampilan } from '@/services/PenarikanInvestasiQuery';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { formatRupiah } from '@/utils/money';
import { newId } from '@/utils/id';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { tanggalRingkas } from '@/utils/tarikSimpananUi';
import {
  dapatDitarik,
  isJenisPenarikan,
  judulJenisPenarikan,
  labelSelisih,
  pesanPenolakan,
  statusInvestasiUi,
  validasiFormPenarikan,
} from '@/utils/penarikanInvestasiUi';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * PENARIKAN DANA INVESTASI — DETAIL, FORMULIR, TINJAU, KONFIRMASI.
 *
 * Seluruh validasi final, nilai tercatat, untung/rugi, pemilihan akun
 * (mapping existing — pengguna tidak memilih COA), baris jurnal, status,
 * dan audit trail milik `PenarikanInvestasiService`: Tinjau memanggil
 * `pratinjauPenarikanInvestasi()` dan Konfirmasi memanggil
 * `catatPenarikanInvestasi()` — satu penyusun, sehingga jurnal yang
 * ditinjau identik dengan yang diposting. Layar ini tidak menghitung angka
 * akuntansi apa pun.
 *
 * Aturan (keputusan pengguna): Tarik Sebagian mengurangi nilai tercatat
 * sebesar dana ditarik tanpa untung/rugi; Tarik Seluruhnya (penarikan
 * terakhir) menghitung untung/rugi atas sisa nilai tercatat.
 */
export default function PenarikanInvestasiFormScreen({ route }: { route?: any }) {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const investasiId: string | undefined = route?.params?.investasiId;

  const [memuat, setMemuat] = useState(true);
  const [investasi, setInvestasi] = useState<InvestasiListItem | null>(null);
  const [nilai, setNilai] = useState<NilaiInvestasiTampilan | null>(null);
  const [statusTarik, setStatusTarik] = useState<StatusPenarikanInvestasi | null>(null);
  const [penarikanTerakhir, setPenarikanTerakhir] = useState<string | null>(null);

  const [mode, setMode] = useState<ModePenarikan | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [danaDiterima, setDanaDiterima] = useState<number | ''>('');
  const [bunga, setBunga] = useState<number | ''>('');
  const [sumberDana, setSumberDana] = useState<'KAS' | 'BANK' | null>(null);
  const [rekeningBank, setRekeningBank] = useState<RekeningItem | null>(null);
  const [keterangan, setKeterangan] = useState('');
  const [galat, setGalat] = useState<Record<string, string>>({});

  const [meninjau, setMeninjau] = useState(false);
  const [pratinjau, setPratinjau] = useState<PratinjauPenarikanInvestasi | null>(null);
  const [setuju, setSetuju] = useState(false);
  const [memposting, setMemposting] = useState(false);
  const [hasil, setHasil] = useState<{ journalId: string; pratinjau: PratinjauPenarikanInvestasi } | null>(null);
  /** Identitas submit — dibuat sekali per formulir; retry tidak menggandakan transaksi. */
  const kunciSubmit = useRef(newId());

  const muat = useCallback(async () => {
    if (!investasiId) return;
    setMemuat(true);
    try {
      const [inv, n, st] = await Promise.all([
        getInvestasiDetail(investasiId),
        getNilaiInvestasiTampilan(investasiId),
        getStatusPenarikanInvestasi(investasiId),
      ]);
      setInvestasi(inv);
      setNilai(n);
      setStatusTarik(st);
      setPenarikanTerakhir(st.tanggalTerakhir);
    } catch {
      setInvestasi(null);
    } finally {
      setMemuat(false);
    }
  }, [investasiId]);
  useFocusRefresh(() => {
    if (!hasil) void muat();
  }, [muat, hasil]);

  const deposito = investasi?.jenisInvestasi === 'DEPOSITO_BANK_UMUM';

  const susunInput = (): PenarikanInvestasiInput | null => {
    if (!investasi || !currentUser || danaDiterima === '' || !mode) return null;
    const b = deposito && bunga !== '' ? bunga : 0;
    const total = danaDiterima + b;
    return {
      investasiId: investasi.id,
      tanggal,
      mode,
      danaPokok: danaDiterima,
      bungaDeposito: b,
      sumberDana: total > 0 && sumberDana ? sumberDana : undefined,
      bankAccountId: sumberDana === 'BANK' ? rekeningBank?.id : undefined,
      keterangan: keterangan.trim() || undefined,
      createdBy: currentUser.id,
      idempotencyKey: kunciSubmit.current,
    };
  };

  const tinjau = async () => {
    if (!investasi || !nilai) return;
    const e = validasiFormPenarikan({
      tanggal,
      hariIni: getTanggalLokalHariIni(),
      tanggalPerolehan: investasi.tanggal,
      tanggalPenarikanTerakhir: penarikanTerakhir,
      mode: mode ?? undefined,
      saldoTersedia: nilai.nilaiTercatat,
      danaDiterima,
      bunga: deposito ? bunga : '',
      sumberDana,
      adaRekeningBank: !!rekeningBank,
    });
    if (!mode) e.mode = 'Pilih jenis penarikan.';
    setGalat(e);
    if (Object.keys(e).length > 0) return;
    const input = susunInput();
    if (!input) return;
    setMeninjau(true);
    try {
      setPratinjau(await pratinjauPenarikanInvestasi(input));
      setSetuju(false);
    } catch (err) {
      notify('Tidak dapat ditinjau', pesanPenolakan(err));
    } finally {
      setMeninjau(false);
    }
  };

  const posting = async () => {
    const input = susunInput();
    if (!input || !setuju || memposting) return;
    setMemposting(true);
    try {
      const r = await catatPenarikanInvestasi(input);
      setPratinjau(null);
      setHasil({ journalId: r.journalId, pratinjau: r.duplikat && pratinjau ? pratinjau : r.pratinjau });
    } catch (err) {
      setPratinjau(null);
      notify('Penarikan gagal diposting', pesanPenolakan(err));
      void muat();
    } finally {
      setMemposting(false);
    }
  };

  const gantiMode = (m: ModePenarikan) => {
    setMode(m);
    setDanaDiterima('');
    setGalat((g) => ({ ...g, mode: '', danaDiterima: '' }));
  };

  // ---------------- keadaan: memuat / tidak ditemukan ----------------
  if (memuat && !investasi) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!investasi || !nilai) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={36} color={colors.textFaint} />
        <Text style={styles.centerText}>Investasi tidak ditemukan.</Text>
      </View>
    );
  }

  // ---------------- keadaan: berhasil ----------------
  if (hasil) {
    const p = hasil.pratinjau;
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.isi} keyboardShouldPersistTaps="handled">
        <View style={styles.suksesBox}>
          <View style={styles.suksesIkon}>
            <Ionicons name="checkmark" size={32} color={colors.white} />
          </View>
          <Text style={styles.suksesJudul}>Penarikan Berhasil Diposting</Text>
          <Text style={styles.suksesSub}>
            {p.namaTujuan} · {p.nomorInvestasi}
          </Text>
          <Text style={styles.suksesNominal}>{formatRupiah(p.totalDiterima)}</Text>
          <Text style={styles.suksesSub}>
            {p.statusSesudah === 'SELESAI'
              ? 'Investasi telah ditarik seluruhnya. Status kini Selesai.'
              : `Status kini Sebagian Ditarik. Sisa saldo ${formatRupiah(p.nilaiSesudah)}.`}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.tombolUtama}
          accessibilityRole="button"
          onPress={() => navigation.replace('DetailPenarikanInvestasi', { journalId: hasil.journalId })}
        >
          <Ionicons name="document-text-outline" size={18} color={colors.white} />
          <Text style={styles.tombolUtamaText}>Lihat Detail Transaksi</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tombolKedua} accessibilityRole="button" onPress={() => navigation.goBack()}>
          <Text style={styles.tombolKeduaText}>Kembali ke Daftar Investasi</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  const st = statusInvestasiUi(investasi.status, statusTarik?.jumlahPenarikan ?? 0);
  const bisa = dapatDitarik(investasi.status);

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <View style={styles.container}>
        <ScrollView style={styles.container} contentContainerStyle={styles.isi} keyboardShouldPersistTaps="handled">
          {/* ---------------- DETAIL INVESTASI ---------------- */}
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.jenisLabel}>
                  {isJenisPenarikan(investasi.jenisInvestasi)
                    ? judulJenisPenarikan(investasi.jenisInvestasi)
                    : LABEL_JENIS_INVESTASI[investasi.jenisInvestasi]}
                </Text>
                <Text style={styles.nama}>{investasi.namaTujuan}</Text>
              </View>
              <View style={[styles.badge, st.nada === 'OK' ? styles.badgeOk : st.nada === 'WARN' ? styles.badgeWarn : styles.badgeMuted]}>
                <Text style={[styles.badgeText, st.nada === 'OK' ? styles.badgeTextOk : st.nada === 'WARN' ? styles.badgeTextWarn : styles.badgeTextMuted]}>
                  {st.label}
                </Text>
              </View>
            </View>
            <View style={styles.pemisah} />
            <BarisInfo label="Nomor bukti" nilai={investasi.nomorInvestasi} />
            {investasi.nomorRekeningInvestasi ? (
              <BarisInfo label={deposito ? 'Nomor deposito' : 'Nomor rekening'} nilai={investasi.nomorRekeningInvestasi} />
            ) : null}
            <BarisInfo label={deposito ? 'Bank' : 'Pihak'} nilai={investasi.namaTujuan} />
            <BarisInfo label="Tanggal penempatan" nilai={tanggalRingkas(investasi.tanggal.slice(0, 10))} />
            {deposito ? (
              <BarisInfo label="Jatuh tempo" nilai={investasi.tanggalJatuhTempo ? tanggalRingkas(investasi.tanggalJatuhTempo) : 'Tidak dicatat'} />
            ) : null}
            <View style={styles.pemisah} />
            <BarisInfo label={deposito ? 'Pokok deposito' : 'Nilai perolehan'} nilai={formatRupiah(nilai.nilaiAwal)} />
            {nilai.akumulasiPenyusutan > 0 ? <BarisInfo label="Akumulasi penyusutan" nilai={`− ${formatRupiah(nilai.akumulasiPenyusutan)}`} /> : null}
            {nilai.akumulasiImpairment > 0 ? <BarisInfo label="Penurunan nilai" nilai={`− ${formatRupiah(nilai.akumulasiImpairment)}`} /> : null}
            <BarisInfo label="Telah ditarik" nilai={nilai.totalDitarik > 0 ? `− ${formatRupiah(nilai.totalDitarik)}` : formatRupiah(0)} />
            <BarisInfo label="Saldo tersedia (nilai tercatat)" nilai={bisa ? formatRupiah(nilai.nilaiTercatat) : formatRupiah(0)} tebal />
            {statusTarik && statusTarik.jumlahPenarikan > 0 ? (
              <TouchableOpacity accessibilityRole="button" onPress={() => navigation.navigate('RiwayatPenarikanInvestasi')}>
                <Text style={styles.link}>Lihat {statusTarik.jumlahPenarikan} penarikan sebelumnya</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {!bisa ? (
            <View style={styles.tertahan}>
              <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} />
              <Text style={styles.tertahanText}>Investasi berstatus {st.label}. Tidak ada saldo yang dapat ditarik.</Text>
            </View>
          ) : (
            <>
              {/* ---------------- FORMULIR ---------------- */}
              <View style={styles.card}>
                <Text style={styles.cardJudul}>Data Penarikan</Text>

                <Text style={styles.label}>Jenis penarikan *</Text>
                <View style={styles.modeRow}>
                  {(
                    [
                      ['SEBAGIAN', 'Tarik Sebagian', 'Saldo berkurang sebesar dana ditarik'],
                      ['SELURUHNYA', 'Tarik Seluruhnya', 'Penarikan terakhir; untung/rugi dihitung'],
                    ] as const
                  ).map(([k, judul, ket]) => (
                    <TouchableOpacity
                      key={k}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: mode === k }}
                      style={[styles.modeCard, mode === k && styles.modeCardAktif]}
                      onPress={() => gantiMode(k)}
                    >
                      <Ionicons
                        name={mode === k ? 'radio-button-on' : 'radio-button-off'}
                        size={18}
                        color={mode === k ? colors.primary : colors.textFaint}
                      />
                      <Text style={styles.modeJudul}>{judul}</Text>
                      <Text style={styles.modeKet}>{ket}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {galat.mode ? <Text style={styles.errorText}>{galat.mode}</Text> : null}

                <Text style={[styles.label, styles.jarak]}>Tanggal transaksi *</Text>
                <DatePicker value={tanggal} onChange={setTanggal} maximumDate={getWaktuSekarang()} error={galat.tanggal} />

                <Text style={[styles.label, styles.jarak]}>
                  {mode === 'SELURUHNYA' ? (deposito ? 'Pokok deposito diterima *' : 'Dana pokok diterima *') : 'Jumlah dana ditarik *'}
                </Text>
                <CurrencyInput value={danaDiterima} onChangeValue={setDanaDiterima} error={galat.danaDiterima} />
                <Text style={styles.hint}>
                  {mode === 'SELURUHNYA'
                    ? `Sisa nilai tercatat ${formatRupiah(nilai.nilaiTercatat)}. Selisih dengan dana diterima dicatat otomatis sebagai keuntungan/kerugian.`
                    : `Maksimal di bawah saldo tersedia ${formatRupiah(nilai.nilaiTercatat)}.`}
                </Text>

                {deposito ? (
                  <>
                    <Text style={[styles.label, styles.jarak]}>Bunga deposito diterima</Text>
                    <CurrencyInput value={bunga} onChangeValue={setBunga} error={galat.bunga} />
                    <Text style={styles.hint}>Opsional. Dicatat otomatis ke Pendapatan Bunga Deposito dalam transaksi yang sama.</Text>
                  </>
                ) : null}

                <Text style={[styles.label, styles.jarak]}>Diterima ke *</Text>
                <View style={styles.segmen}>
                  {(['KAS', 'BANK'] as const).map((sd) => (
                    <TouchableOpacity
                      key={sd}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: sumberDana === sd }}
                      style={[styles.segmenItem, sumberDana === sd && styles.segmenItemAktif]}
                      onPress={() => {
                        setSumberDana(sd);
                        if (sd === 'KAS') setRekeningBank(null);
                        setGalat((g) => ({ ...g, sumberDana: '' }));
                      }}
                    >
                      <Ionicons
                        name={sd === 'KAS' ? 'cash-outline' : 'business-outline'}
                        size={16}
                        color={sumberDana === sd ? colors.white : colors.textMuted}
                      />
                      <Text style={[styles.segmenText, sumberDana === sd && styles.segmenTextAktif]}>
                        {sd === 'KAS' ? 'Kas' : 'Bank'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {sumberDana === 'BANK' ? (
                  <RekeningPicker label="Rekening bank" value={rekeningBank} onChange={setRekeningBank} hanyaBank />
                ) : null}
                {galat.sumberDana ? <Text style={styles.errorText}>{galat.sumberDana}</Text> : null}

                <Text style={[styles.label, styles.jarak]}>Keterangan</Text>
                <FocusTextInput
                  style={styles.inputMultiline}
                  value={keterangan}
                  onChangeText={setKeterangan}
                  multiline
                  placeholder="Opsional"
                  placeholderTextColor={colors.placeholder}
                />
              </View>

              <TouchableOpacity
                style={[styles.tombolUtama, meninjau && styles.disabled]}
                onPress={() => void tinjau()}
                disabled={meninjau}
                accessibilityRole="button"
              >
                {meninjau ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <>
                    <Text style={styles.tombolUtamaText}>Tinjau Penarikan</Text>
                    <Ionicons name="arrow-forward" size={18} color={colors.white} />
                  </>
                )}
              </TouchableOpacity>
            </>
          )}
        </ScrollView>

        {/* ---------------- TINJAU PENARIKAN ---------------- */}
        <Modal visible={!!pratinjau} transparent animationType="slide" onRequestClose={() => setPratinjau(null)}>
          <View style={styles.overlay}>
            <SafeAreaView edges={['bottom']} style={styles.lembar}>
              {pratinjau ? (
                <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg }}>
                  <View style={styles.pegangan} />
                  <Text style={styles.lembarJudul}>Tinjau Penarikan</Text>
                  <Text style={styles.lembarSub}>
                    {pratinjau.mode === 'SEBAGIAN' ? 'Tarik sebagian' : 'Tarik seluruhnya'} · {pratinjau.namaTujuan} ·{' '}
                    {tanggalRingkas(pratinjau.tanggal)}
                  </Text>

                  <View style={styles.ringkas}>
                    <BarisInfo label="Nilai investasi sebelum transaksi" nilai={formatRupiah(pratinjau.nilaiSebelum)} />
                    <BarisInfo label="Jumlah penarikan" nilai={formatRupiah(pratinjau.danaPokok)} />
                    <BarisInfo label="Nilai investasi yang dikembalikan" nilai={formatRupiah(pratinjau.nilaiDikembalikan)} />
                    <BarisInfo
                      label={pratinjau.mode === 'SEBAGIAN' ? 'Selisih (tidak berlaku untuk penarikan sebagian)' : labelSelisih(pratinjau.jenisSelisih)}
                      nilai={`${pratinjau.selisih < 0 ? '− ' : ''}${formatRupiah(Math.abs(pratinjau.selisih))}`}
                      warna={pratinjau.selisih < 0 ? colors.danger : pratinjau.selisih > 0 ? colors.success : undefined}
                    />
                    {pratinjau.bungaDeposito > 0 ? (
                      <BarisInfo label="Bunga deposito diterima" nilai={formatRupiah(pratinjau.bungaDeposito)} />
                    ) : null}
                    <BarisInfo
                      label="Diterima ke"
                      nilai={
                        pratinjau.rekeningAccountId
                          ? (() => {
                              const b = [...pratinjau.barisPokok, ...pratinjau.barisBunga].find(
                                (x) => x.accountId === pratinjau.rekeningAccountId
                              );
                              return b ? `${b.kode} ${b.nama}` : '-';
                            })()
                          : 'Tidak ada dana diterima'
                      }
                    />
                    <View style={styles.totalRow}>
                      <Text style={styles.totalLabel}>Total dana diterima</Text>
                      <Text style={styles.totalNilai}>{formatRupiah(pratinjau.totalDiterima)}</Text>
                    </View>
                    <View style={styles.sesudahRow}>
                      <Text style={styles.sesudahText}>
                        Setelah transaksi: saldo {formatRupiah(pratinjau.nilaiSesudah)} ·{' '}
                        {pratinjau.statusSesudah === 'SELESAI' ? 'Selesai' : 'Sebagian Ditarik'}
                      </Text>
                    </View>
                  </View>

                  <TabelJurnal judul="Jurnal penarikan" baris={pratinjau.barisPokok} />
                  {pratinjau.barisBunga.length > 0 ? <TabelJurnal judul="Jurnal bunga deposito" baris={pratinjau.barisBunga} /> : null}

                  <TouchableOpacity
                    style={[styles.setuju, setuju && styles.setujuAktif]}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: setuju }}
                    onPress={() => setSetuju((v) => !v)}
                  >
                    <Ionicons name={setuju ? 'checkbox' : 'square-outline'} size={20} color={setuju ? colors.primary : colors.textMuted} />
                    <Text style={styles.setujuText}>
                      Saya telah memeriksa data di atas. Transaksi yang sudah diposting tidak dapat diubah.
                    </Text>
                  </TouchableOpacity>

                  <View style={styles.lembarTombol}>
                    <TouchableOpacity style={styles.tombolBatal} onPress={() => setPratinjau(null)} accessibilityRole="button">
                      <Text style={styles.tombolKeduaText}>Periksa Lagi</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.tombolKonfirmasi, (!setuju || memposting) && styles.disabled]}
                      disabled={!setuju || memposting}
                      onPress={() => void posting()}
                      accessibilityRole="button"
                    >
                      {memposting ? (
                        <ActivityIndicator color={colors.white} />
                      ) : (
                        <>
                          <Ionicons name="checkmark-circle-outline" size={18} color={colors.white} />
                          <Text style={styles.tombolUtamaText}>Posting Penarikan</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                </ScrollView>
              ) : null}
            </SafeAreaView>
          </View>
        </Modal>
      </View>
    </AreaAmanKeyboard>
  );
}

function TabelJurnal({ judul, baris }: { judul: string; baris: PratinjauPenarikanInvestasi['barisPokok'] }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={styles.sectionLabel}>{judul}</Text>
      <View style={styles.jurnal}>
        <View style={styles.jurnalHeader}>
          <Text style={[styles.jurnalTh, { flex: 1 }]}>Akun</Text>
          <Text style={[styles.jurnalTh, styles.jurnalNum]}>Debit</Text>
          <Text style={[styles.jurnalTh, styles.jurnalNum]}>Kredit</Text>
        </View>
        {baris.map((b, idx) => (
          <View key={`${b.accountId}-${idx}`} style={styles.jurnalRow}>
            <Text style={[styles.jurnalAkun, b.kredit > 0 && { paddingLeft: spacing.md }]}>
              {b.kode} {b.nama}
            </Text>
            <Text style={styles.jurnalNum} numberOfLines={1}>
              {b.debit > 0 ? formatRupiah(b.debit) : ''}
            </Text>
            <Text style={styles.jurnalNum} numberOfLines={1}>
              {b.kredit > 0 ? formatRupiah(b.kredit) : ''}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function BarisInfo({ label, nilai, tebal, warna }: { label: string; nilai: string; tebal?: boolean; warna?: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoNilai, tebal && styles.infoNilaiTebal, warna ? { color: warna } : null]}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.background },
  centerText: { fontSize: 13, color: colors.textMuted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  cardJudul: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  jenisLabel: { fontSize: 11, fontWeight: '700', color: colors.primary, letterSpacing: 0.3, textTransform: 'uppercase' },
  nama: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 2 },
  pemisah: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 4 },
  infoLabel: { fontSize: 12.5, color: colors.textMuted, flex: 1 },
  infoNilai: { fontSize: 13, fontWeight: '600', color: colors.text, textAlign: 'right', flexShrink: 1 },
  infoNilaiTebal: { fontWeight: '700' },
  badge: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  badgeOk: { backgroundColor: colors.primaryLight },
  badgeMuted: { backgroundColor: colors.background },
  badgeText: { fontSize: 10.5, fontWeight: '700' },
  badgeTextOk: { color: colors.success },
  badgeTextMuted: { color: colors.textMuted },
  badgeWarn: { backgroundColor: colors.warningBg },
  badgeTextWarn: { color: colors.warning },
  link: { fontSize: 12.5, fontWeight: '700', color: colors.primary, marginTop: spacing.sm },
  modeRow: { flexDirection: 'row', gap: spacing.sm },
  modeCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    gap: 4,
    backgroundColor: colors.surface,
  },
  modeCardAktif: { borderColor: colors.primary, borderWidth: 1.5, backgroundColor: colors.primaryLight },
  modeJudul: { fontSize: 13, fontWeight: '700', color: colors.text },
  modeKet: { fontSize: 11, color: colors.textMuted, lineHeight: 15 },
  sesudahRow: { marginTop: spacing.sm },
  sesudahText: { fontSize: 11.5, color: colors.textMuted, textAlign: 'right' },
  tertahan: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  tertahanText: { flex: 1, fontSize: 12.5, color: colors.textMuted },
  label: { fontSize: 12, fontWeight: '600', color: colors.text, marginBottom: spacing.xs },
  jarak: { marginTop: spacing.md },
  hint: { fontSize: 11.5, color: colors.textMuted, marginTop: 4 },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  segmen: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  segmenItem: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segmenItemAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  segmenText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  segmenTextAktif: { color: colors.white },
  tombolUtama: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 15,
    marginTop: spacing.sm,
  },
  tombolUtamaText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  tombolKedua: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    marginTop: spacing.md,
    backgroundColor: colors.surface,
  },
  tombolKeduaText: { fontSize: 14, fontWeight: '700', color: colors.text },
  disabled: { opacity: 0.5 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  lembar: { backgroundColor: colors.surface, borderTopLeftRadius: radius.md * 2, borderTopRightRadius: radius.md * 2, maxHeight: '92%' },
  pegangan: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md },
  lembarJudul: { fontSize: 17, fontWeight: '700', color: colors.text },
  lembarSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.md },
  ringkas: { backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.text,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  totalLabel: { fontSize: 13, fontWeight: '700', color: colors.text },
  totalNilai: { fontSize: 19, fontWeight: '700', color: colors.primary },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: spacing.xs },
  jurnal: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden' },
  jurnalHeader: { flexDirection: 'row', backgroundColor: colors.primaryLight, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  jurnalTh: { fontSize: 10.5, fontWeight: '700', color: colors.primary, textTransform: 'uppercase' },
  jurnalRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border },
  jurnalAkun: { flex: 1, fontSize: 12, color: colors.text, paddingRight: spacing.xs },
  jurnalNum: { width: 104, textAlign: 'right', fontSize: 12, color: colors.text, fontVariant: ['tabular-nums'] },
  setuju: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.md,
  },
  setujuAktif: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  setujuText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  lembarTombol: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  tombolBatal: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tombolKonfirmasi: {
    flex: 2,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  suksesBox: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    gap: 4,
  },
  suksesIkon: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  suksesJudul: { fontSize: 17, fontWeight: '700', color: colors.text },
  suksesSub: { fontSize: 12.5, color: colors.textMuted, textAlign: 'center' },
  suksesNominal: { fontSize: 24, fontWeight: '700', color: colors.primary, marginVertical: spacing.sm },
});
