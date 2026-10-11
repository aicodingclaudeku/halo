import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import { RekeningItem } from '@/services/KasBankService';
import { getBuktiKeluarAnggotaById, type BuktiKeluarAnggotaRow } from '@/services/BuktiTransaksiService';
import {
  getKeluarAnggotaDetailById,
  setujuiKeluarAnggota,
  tolakKeluarAnggota,
  bayarKeluarAnggota,
  type KeluarAnggotaDetail,
} from '@/services/KeluarAnggotaService';
import {
  LABEL_ALASAN_KELUAR,
  LABEL_STATUS_KELUAR,
  PENJELASAN_STATUS_KELUAR,
} from '@/screens/Transaksi/keluarAnggotaLabels';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';

/**
 * KELUAR ANGGOTA — DETAIL PENGAJUAN.
 *
 * MASALAH YANG DITUTUP. Setelah layar dipecah menjadi hub/pengajuan/
 * daftar, seluruh aksi (Setujui, Tolak, Bayar) beserta pemilih Sumber
 * Pembayaran masih menempel pada tiap kartu di Daftar Pengajuan. Satu
 * layar gulir berisi banyak kartu, masing-masing membawa tombol yang
 * mengeluarkan uang — dan pemilih Kas/Bank berdiri sendiri di atas
 * daftar, sehingga tidak jelas kartu MANA yang akan memakainya.
 *
 * Sekarang daftar hanya memantau dan membuka; keputusan dilakukan di
 * sini, pada satu pengajuan yang identitas dan angkanya sedang terlihat
 * penuh.
 *
 * YANG TIDAK DILAKUKAN LAYAR INI, DAN ITU DISENGAJA:
 *
 * 1. TIDAK menghitung apa pun. Seluruh nominal dibaca apa adanya dari
 *    baris yang disimpan service saat pengajuan dibuat.
 * 2. TIDAK menulis SQL, tidak membuat jurnal. Setiap mutasi lewat
 *    `KeluarAnggotaService` — service tetap penegak aturan, dan
 *    menyembunyikan tombol bukan pengamannya.
 * 3. TIDAK membawa objek pengajuan lewat params; hanya
 *    `keluarAnggotaId`, lalu dibaca ulang. Objek yang dikirim lewat
 *    params menjadi basi begitu status berubah dari layar lain.
 *
 * Aksi ganda dicegah `sibuk`: tombol dinonaktifkan sejak tap pertama
 * sampai service selesai, jadi dua ketukan cepat tidak menghasilkan
 * dua pembayaran.
 */

function Baris({ label, nilai, tebal }: { label: string; nilai: number; tebal?: boolean }) {
  return (
    <View style={styles.baris}>
      <Text style={[styles.barisLabel, tebal && styles.barisLabelTebal]}>{label}</Text>
      <Text style={[styles.barisNilai, tebal && styles.barisNilaiTebal]}>{formatRupiah(nilai)}</Text>
    </View>
  );
}

function BarisTeks({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.baris}>
      <Text style={styles.barisLabel}>{label}</Text>
      <Text style={styles.barisTeksNilai}>{nilai.trim() === '' ? '-' : nilai}</Text>
    </View>
  );
}

function gayaBadge(status: string) {
  if (status === 'DIBAYAR') return styles.badgeDibayar;
  if (status === 'DISETUJUI') return styles.badgeDisetujui;
  if (status === 'DITOLAK') return styles.badgeDitolak;
  return styles.badgeDiajukan;
}

export default function KeluarAnggotaDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const keluarAnggotaId: string | undefined = route.params?.keluarAnggotaId;
  const currentUser = useAppStore((s) => s.currentUser);

  const [row, setRow] = useState<KeluarAnggotaDetail | null>(null);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);
  const [tidakDitemukan, setTidakDitemukan] = useState(false);
  const [sibuk, setSibuk] = useState(false);
  /**
   * RC-S76 — bukti pembayaran, dibaca lewat `journalId` yang DISIMPAN
   * service saat membayar. Nomor bukti tidak pernah dirakit di layar.
   * `null` selama belum dibayar atau bila jurnalnya tidak punya bukti.
   */
  const [bukti, setBukti] = useState<BuktiKeluarAnggotaRow | null>(null);

  const [sumberDana, setSumberDana] = useState<'KAS' | 'BANK'>('KAS');
  const [rekeningBank, setRekeningBank] = useState<RekeningItem | null>(null);
  const bankAccountId = rekeningBank?.id ?? null;

  const muat = useCallback(async () => {
    if (!keluarAnggotaId) {
      setMemuat(false);
      setTidakDitemukan(true);
      return;
    }
    setMemuat(true);
    setGalat(null);
    setTidakDitemukan(false);
    try {
      const detail = await getKeluarAnggotaDetailById(keluarAnggotaId);
      if (!detail) {
        setRow(null);
        setTidakDitemukan(true);
        return;
      }
      setRow(detail);
      // Bukti hanya dicari setelah pembayaran benar-benar tercatat.
      // Kegagalannya TIDAK menggagalkan layar: detail pengajuan tetap
      // berguna walau bagian buktinya tidak dapat dibaca.
      setBukti(
        detail.statusPengajuan === 'DIBAYAR' && detail.journalId
          ? await getBuktiKeluarAnggotaById(detail.journalId).catch(() => null)
          : null
      );
    } catch {
      // Pesan teknis/SQLite tidak diteruskan ke pengguna.
      setGalat('Detail pengajuan tidak dapat dimuat.');
    } finally {
      setMemuat(false);
    }
  }, [keluarAnggotaId]);

  useFocusRefresh(muat, [muat]);

  /** Setiap mutasi diikuti pembacaan ulang, supaya status yang terlihat adalah status database. */
  const jalankanMutasi = async (kerja: () => Promise<unknown>, pesanGagal: string) => {
    if (sibuk) return; // penjaga tambahan selain `disabled` pada tombol
    setSibuk(true);
    try {
      await kerja();
      await muat();
    } catch (e) {
      notify(pesanGagal, e instanceof Error ? e.message : 'Proses gagal.');
    } finally {
      setSibuk(false);
    }
  };

  const setujui = () => {
    if (!row || !currentUser) return;
    Alert.alert(
      'Setujui Pengajuan?',
      `Pengajuan ${row.namaAnggota} akan berpindah ke status Disetujui dan siap dibayarkan.`,
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Setujui',
          onPress: () =>
            void jalankanMutasi(async () => {
              await setujuiKeluarAnggota(row.id, currentUser.id, getTanggalLokalHariIni());
              notify('Pengajuan disetujui.', row.namaAnggota);
            }, 'Gagal menyetujui'),
        },
      ]
    );
  };

  const tolak = () => {
    if (!row || !currentUser) return;
    Alert.alert('Tolak Pengajuan?', `Pengajuan ${row.namaAnggota} akan ditandai Ditolak.`, [
      { text: 'Batal', style: 'cancel' },
      {
        text: 'Tolak',
        style: 'destructive',
        onPress: () =>
          void jalankanMutasi(async () => {
            await tolakKeluarAnggota(row.id, currentUser.id);
            notify('Pengajuan ditolak.', row.namaAnggota);
          }, 'Gagal menolak'),
      },
    ]);
  };

  const bayar = () => {
    if (!row || !currentUser) return;
    if (sumberDana === 'BANK' && !bankAccountId) {
      notify('Tidak dapat dibayar', 'Pilih rekening bank terlebih dahulu.');
      return;
    }
    Alert.alert(
      'Bayar Pengajuan Keluar Anggota?',
      `Pembayaran ${formatRupiah(row.nilaiPengembalian)} akan dicatat menggunakan sumber dana ${sumberDana === 'KAS' ? 'Kas' : 'Bank'}.`,
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Bayar',
          onPress: () =>
            void jalankanMutasi(async () => {
              const hasil = await bayarKeluarAnggota({
                id: row.id,
                tanggal: getTanggalLokalHariIni(),
                sumberDana,
                bankAccountId: sumberDana === 'BANK' ? (bankAccountId as string) : undefined,
                createdBy: currentUser.id,
              });
              notify(
                'Pembayaran berhasil.',
                `${row.namaAnggota} · ${formatRupiah(hasil.nilaiPengembalian)}`
              );
            }, 'Gagal membayar'),
        },
      ]
    );
  };

  if (memuat) {
    return (
      <View style={styles.pusat}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.pusatTeks}>Memuat detail pengajuan…</Text>
      </View>
    );
  }

  if (galat !== null) {
    return (
      <View style={styles.pusat}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.danger} />
        <Text style={styles.pusatTeks}>{galat}</Text>
        <TouchableOpacity accessibilityRole="button" style={styles.cobaLagi} onPress={() => void muat()}>
          <Text style={styles.cobaLagiTeks}>Coba lagi</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (tidakDitemukan || !row) {
    return (
      <View style={styles.pusat}>
        <Ionicons name="document-outline" size={32} color={colors.textMuted} />
        <Text style={styles.pusatTeks}>Pengajuan tidak ditemukan.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.isi}>
      {/* STATUS — badge + teks, tidak pernah dibedakan warna saja. */}
      <View style={styles.hero}>
        <View style={[styles.badge, gayaBadge(row.statusPengajuan)]}>
          <Text style={styles.badgeText}>{LABEL_STATUS_KELUAR[row.statusPengajuan]}</Text>
        </View>
        <Text style={styles.heroNominal}>{formatRupiah(row.nilaiPengembalian)}</Text>
        <Text style={styles.heroKeterangan}>Nilai pengembalian</Text>
        <Text style={styles.heroPenjelasan}>{PENJELASAN_STATUS_KELUAR[row.statusPengajuan]}</Text>
      </View>

      <Text style={styles.seksi}>Anggota</Text>
      <View style={styles.kartu}>
        <BarisTeks label="Nama Anggota" nilai={row.namaAnggota} />
        <BarisTeks label="Nomor Anggota" nilai={row.nomorAnggota ?? '-'} />
      </View>

      <Text style={styles.seksi}>Pengajuan</Text>
      <View style={styles.kartu}>
        <BarisTeks label="Tanggal Pengajuan" nilai={row.tanggalPengajuan} />
        <BarisTeks label="Tanggal Efektif Keluar" nilai={row.tanggalEfektifKeluar} />
        <BarisTeks label="Alasan Keluar" nilai={LABEL_ALASAN_KELUAR[row.alasanKeluar]} />
        <BarisTeks label="Keterangan" nilai={row.keterangan ?? '-'} />
      </View>

      {/* Seluruh angka DIBACA dari baris yang disimpan service. */}
      <Text style={styles.seksi}>Ringkasan Hak Anggota</Text>
      <View style={styles.kartu}>
        <Baris label="Simpanan Pokok" nilai={row.saldoSimpananPokok} />
        <Baris label="Simpanan Wajib" nilai={row.saldoSimpananWajib} />
        <Baris label="Simpanan Sukarela" nilai={row.saldoSimpananSukarela} />
        <Baris label="SHU Hak Anggota" nilai={row.shuHakAnggota} />
        <Baris label="Total Hak" nilai={row.totalHak} tebal />
      </View>

      <Text style={styles.seksi}>Pengurang</Text>
      <View style={styles.kartu}>
        <Baris label="Saldo Pinjaman" nilai={row.saldoPinjaman} />
        <Baris label="Kewajiban Lain" nilai={row.kewajibanLain} />
        <Baris label="Total Pengurang" nilai={row.totalPengurang} tebal />
        <Baris label="Nilai Pengembalian" nilai={row.nilaiPengembalian} tebal />
      </View>

      {/* RC-S76 — BUKTI TRANSAKSI. CTA hanya muncul bila pembayaran
          benar-benar menghasilkan jurnal; tanpa `journalId` tidak ada
          bukti yang dapat dibuka, dan menawarkannya hanya akan membawa
          pengguna ke layar kosong. */}
      {row.statusPengajuan === 'DIBAYAR' && (
        <>
          <Text style={styles.seksi}>Bukti Transaksi</Text>
          <View style={styles.kartu}>
            <BarisTeks label="Nomor Bukti" nilai={bukti?.nomorBukti ?? '-'} />
            <BarisTeks label="Tanggal Pembayaran" nilai={row.tanggalPembayaran ?? '-'} />
            <BarisTeks label="Sumber Dana" nilai={row.sumberPembayaran === 'BANK' ? 'Bank' : 'Kas'} />
          </View>
          {row.journalId ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Lihat bukti keluar anggota"
              style={styles.ctaBukti}
              onPress={() =>
                // Lintas tab: `BuktiTransaksiDetail` milik LaporanStack,
                // sedangkan layar ini di TransaksiStack. Navigasi lewat
                // tab induk mengikuti pola project.
                navigation.navigate('Laporan', {
                  screen: 'BuktiTransaksiDetail',
                  initial: false,
                  params: { jenis: 'KELUAR_ANGGOTA', id: row.journalId },
                })
              }
            >
              <Text style={styles.ctaBuktiTeks}>Lihat Bukti Keluar Anggota</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.primary} />
            </TouchableOpacity>
          ) : (
            <Text style={styles.catatan}>Bukti transaksi belum tersedia untuk pengajuan ini.</Text>
          )}
        </>
      )}

      {/* RC-S76 §20 — TRANSPARANSI, bukan penagihan. Angkanya dibaca
          apa adanya dari baris yang disimpan service; RC ini tidak
          mengubah status pinjaman dan tidak membuat jurnal tambahan. */}
      {row.saldoPinjaman > 0 && (
        <>
          <Text style={styles.seksi}>Catatan Kewajiban</Text>
          <View style={styles.kartu}>
            <Baris label="Saldo Pinjaman" nilai={row.saldoPinjaman} />
          </View>
          <Text style={styles.catatan}>
            Saldo pinjaman anggota masih tercatat sebagai piutang koperasi dan tidak dihapus oleh
            proses keluar anggota.
          </Text>
        </>
      )}

      {/* AKSI — hanya yang sesuai status. DITOLAK & DIBAYAR final. */}
      {row.statusPengajuan === 'DIAJUKAN' && (
        <View style={styles.aksiRow}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Setujui pengajuan keluar anggota"
            style={[styles.aksiUtama, sibuk && styles.disabled]}
            onPress={setujui}
            disabled={sibuk}
          >
            {sibuk ? <ActivityIndicator color={colors.white} /> : <Text style={styles.aksiTeks}>Setujui</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Tolak pengajuan keluar anggota"
            style={[styles.aksiTolak, sibuk && styles.disabled]}
            onPress={tolak}
            disabled={sibuk}
          >
            <Text style={styles.aksiTeks}>Tolak</Text>
          </TouchableOpacity>
        </View>
      )}

      {row.statusPengajuan === 'DISETUJUI' && (
        <>
          {/* Sumber Pembayaran HANYA di sini — konteks pembayaran satu pengajuan. */}
          <Text style={styles.seksi}>Sumber Pembayaran</Text>
          <View style={styles.chipRow}>
            {(['KAS', 'BANK'] as const).map((s) => (
              <TouchableOpacity
                key={s}
                accessibilityRole="button"
                accessibilityState={{ selected: sumberDana === s }}
                accessibilityLabel={`Sumber dana ${s === 'KAS' ? 'Kas' : 'Bank'}`}
                style={[styles.chip, sumberDana === s && styles.chipAktif]}
                onPress={() => setSumberDana(s)}
              >
                <Text style={[styles.chipTeks, sumberDana === s && styles.chipTeksAktif]}>
                  {s === 'KAS' ? 'Kas' : 'Bank'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {sumberDana === 'BANK' && (
            <RekeningPicker label="Rekening Bank" value={rekeningBank} onChange={setRekeningBank} hanyaBank />
          )}

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Bayar pengajuan keluar anggota"
            style={[styles.aksiBayar, sibuk && styles.disabled]}
            onPress={bayar}
            disabled={sibuk}
          >
            {sibuk ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.aksiTeks}>Bayar Pengajuan</Text>
            )}
          </TouchableOpacity>
        </>
      )}

      {row.statusPengajuan === 'DIBAYAR' && (
        <View style={styles.final}>
          <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} />
          <Text style={styles.finalTeks}>Selesai — pembayaran sudah dicatat.</Text>
        </View>
      )}

      {row.statusPengajuan === 'DITOLAK' && (
        <View style={styles.final}>
          <Ionicons name="close-circle-outline" size={18} color={colors.danger} />
          <Text style={styles.finalTeks}>Pengajuan ini sudah ditolak.</Text>
        </View>
      )}

      <TouchableOpacity
        accessibilityRole="button"
        style={styles.kembali}
        onPress={() => navigation.goBack()}
      >
        <Text style={styles.kembaliTeks}>Kembali ke Daftar Pengajuan</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xl },
  pusat: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  pusatTeks: { color: colors.textMuted, textAlign: 'center', fontSize: 13 },
  cobaLagi: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  cobaLagiTeks: { color: colors.primary, fontWeight: '700', fontSize: 13 },

  hero: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  heroNominal: { fontSize: 26, fontWeight: '800', color: colors.primary, marginTop: spacing.sm },
  heroKeterangan: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  heroPenjelasan: { fontSize: 12, color: colors.text, marginTop: spacing.sm, lineHeight: 17 },

  seksi: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
  },
  baris: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: 10,
  },
  barisLabel: { fontSize: 13, color: colors.textMuted, flexShrink: 0 },
  barisLabelTebal: { fontWeight: '700', color: colors.text },
  barisNilai: { fontSize: 13, color: colors.text, flex: 1, textAlign: 'right' },
  barisNilaiTebal: { fontWeight: '800', color: colors.text },
  barisTeksNilai: { fontSize: 13, color: colors.text, fontWeight: '600', flex: 1, textAlign: 'right' },

  badge: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm },
  badgeDiajukan: { backgroundColor: '#FFF4E5' },
  badgeDisetujui: { backgroundColor: '#E3F2FD' },
  badgeDibayar: { backgroundColor: '#E6F4EA' },
  badgeDitolak: { backgroundColor: '#FDECEA' },
  badgeText: { fontSize: 11, fontWeight: '700', color: colors.text },

  chipRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  chip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTeks: { fontSize: 13, fontWeight: '600', color: colors.text },
  chipTeksAktif: { color: colors.white, fontWeight: '700' },

  aksiRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  aksiUtama: {
    flex: 1,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  aksiTolak: {
    flex: 1,
    backgroundColor: colors.danger,
    paddingVertical: 14,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  aksiBayar: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radius.sm,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  aksiTeks: { color: colors.white, fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.6 },

  final: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  finalTeks: { fontSize: 13, color: colors.text, flex: 1 },

  ctaBukti: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 13,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  ctaBuktiTeks: { fontSize: 13, fontWeight: '700', color: colors.primary, flex: 1 },
  catatan: { fontSize: 11, color: colors.textFaint, lineHeight: 16, marginTop: spacing.sm },
  kembali: { marginTop: spacing.lg, alignItems: 'center', paddingVertical: spacing.sm },
  kembaliTeks: { fontSize: 13, color: colors.primary, fontWeight: '600' },
});
