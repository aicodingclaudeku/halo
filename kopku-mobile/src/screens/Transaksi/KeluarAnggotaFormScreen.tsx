import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import AnggotaPicker from '@/components/AnggotaPicker';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import { Anggota } from '@/repositories/AnggotaRepository';
import {
  ajukanKeluarAnggota,
  previewKeluarAnggota,
  ALASAN_KELUAR,
  type AlasanKeluar,
  type PerhitunganKeluarAnggota,
} from '@/services/KeluarAnggotaService';
import { LABEL_ALASAN_KELUAR } from '@/screens/Transaksi/keluarAnggotaLabels';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * KELUAR ANGGOTA — alur persetujuan (Fase 8).
 *
 * Layar ini MENGGANTIKAN isi form lama di berkas yang sama; rutenya
 * tetap `KeluarAnggotaForm`. Alur lama membayar seketika begitu tombol
 * ditekan; sekarang jalurnya DIAJUKAN → DISETUJUI → DIBAYAR.
 *
 * RESTRUKTURISASI HUB — layar ini kini KHUSUS PENGAJUAN. Daftar
 * pengajuan, aksi Setujui/Tolak/Bayar, dan pemilih Sumber Pembayaran
 * DIPINDAH ke `DaftarKeluarAnggotaScreen` (dipindah, bukan disalin:
 * berkas ini tidak lagi mengimpor `listKeluarAnggota`,
 * `setujuiKeluarAnggota`, `tolakKeluarAnggota`, maupun
 * `bayarKeluarAnggota`). Sebelumnya keduanya menempel di satu gulungan
 * panjang, sehingga tombol yang mengeluarkan uang berada di layar yang
 * dibuka orang untuk mengetik pengajuan baru.
 *
 * SELURUH NOMINAL READ-ONLY dan berasal dari
 * `KeluarAnggotaService.previewKeluarAnggota()`. Layar ini tidak
 * menjumlahkan apa pun sendiri — kalau ia ikut menghitung, angka yang
 * dilihat pengurus bisa berbeda dari angka yang dibayar service, dan
 * perbedaan seperti itu baru ketahuan setelah uang keluar.
 *
 * Status juga selalu berasal dari database. Tidak ada status tampilan
 * yang disimpulkan sendiri oleh layar.
 */

function Baris({ label, nilai, tebal }: { label: string; nilai: number; tebal?: boolean }) {
  return (
    <View style={styles.ringkasBaris}>
      <Text style={[styles.ringkasLabel, tebal && styles.ringkasTebal]}>{label}</Text>
      <Text style={[styles.ringkasNilai, tebal && styles.ringkasTebal]}>{formatRupiah(nilai)}</Text>
    </View>
  );
}

export default function KeluarAnggotaFormScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [anggota, setAnggota] = useState<Anggota | null>(null);
  const [alasan, setAlasan] = useState<AlasanKeluar>('MENGUNDURKAN_DIRI');
  const [tanggalPengajuan, setTanggalPengajuan] = useState(getTanggalLokalHariIni());
  const [tanggalEfektif, setTanggalEfektif] = useState(getTanggalLokalHariIni());
  const [keterangan, setKeterangan] = useState('');

  const [preview, setPreview] = useState<PerhitunganKeluarAnggota | null>(null);
  const [memuatPreview, setMemuatPreview] = useState(false);
  const [sibuk, setSibuk] = useState<string | null>(null);

  // Ringkasan dibaca ULANG dari service setiap kali anggota berganti.
  useEffect(() => {
    let batal = false;
    if (!anggota) {
      setPreview(null);
      return;
    }
    setMemuatPreview(true);
    previewKeluarAnggota(anggota.id)
      .then((p) => {
        if (!batal) setPreview(p);
      })
      .catch((e) => {
        if (!batal) {
          setPreview(null);
          notify('Gagal memuat', e instanceof Error ? e.message : 'Ringkasan hak gagal dihitung.');
        }
      })
      .finally(() => {
        if (!batal) setMemuatPreview(false);
      });
    return () => {
      batal = true;
    };
  }, [anggota]);

  const ajukan = async () => {
    if (!anggota) {
      notify('Tidak dapat diajukan', 'Pilih anggota terlebih dahulu.');
      return;
    }
    if (!currentUser) return;
    if (tanggalEfektif < tanggalPengajuan) {
      notify('Tidak dapat diajukan', 'Tanggal efektif keluar tidak boleh mendahului tanggal pengajuan.');
      return;
    }
    setSibuk('ajukan');
    try {
      await ajukanKeluarAnggota({
        anggotaId: anggota.id,
        alasanKeluar: alasan,
        tanggalPengajuan,
        tanggalEfektifKeluar: tanggalEfektif,
        keterangan: keterangan.trim() === '' ? undefined : keterangan.trim(),
        createdBy: currentUser.id,
      });
      notify('Pengajuan keluar anggota berhasil dibuat.', anggota.namaLengkap);
      setAnggota(null);
      setKeterangan('');
      // Kembali ke hub — pengguna memilih sendiri apakah mau membuat
      // pengajuan lagi atau membuka Daftar Pengajuan. Layar daftar
      // memuat ulang saat difokuskan, jadi baris baru pasti terlihat.
      navigation.goBack();
    } catch (e) {
      notify('Gagal mengajukan', e instanceof Error ? e.message : 'Pengajuan gagal dibuat.');
    } finally {
      setSibuk(null);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <AnggotaPicker value={anggota} onChange={setAnggota} />

        <Text style={styles.label}>Alasan Keluar *</Text>
        <View style={styles.chipRow}>
          {ALASAN_KELUAR.map((a) => (
            <TouchableOpacity
              key={a}
              style={[styles.chip, alasan === a && styles.chipAktif]}
              onPress={() => setAlasan(a)}
            >
              <Text style={[styles.chipText, alasan === a && styles.chipTextAktif]}>
                {LABEL_ALASAN_KELUAR[a]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal Pengajuan *</Text>
        <DatePicker value={tanggalPengajuan} onChange={setTanggalPengajuan} />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal Efektif Keluar *</Text>
        <DatePicker value={tanggalEfektif} onChange={setTanggalEfektif} />

        {/*
          RINGKASAN READ-ONLY. Seluruh angka berasal dari
          previewKeluarAnggota(); tidak ada satu pun yang dijumlahkan di
          layar maupun dapat diketik pengguna.
        */}
        {anggota && (
          <View style={styles.ringkasCard}>
            {memuatPreview ? (
              <ActivityIndicator color={colors.primary} />
            ) : preview ? (
              <>
                <Text style={styles.ringkasJudul}>Ringkasan Hak</Text>
                <Baris label="Simpanan Pokok" nilai={preview.saldoSimpananPokok} />
                <Baris label="Simpanan Wajib" nilai={preview.saldoSimpananWajib} />
                <Baris label="Simpanan Sukarela" nilai={preview.saldoSimpananSukarela} />
                <Baris label="SHU Hak Anggota" nilai={preview.shuHakAnggota} />
                <Baris label="Total Hak" nilai={preview.totalHak} tebal />

                <Text style={[styles.ringkasJudul, { marginTop: spacing.md }]}>
                  Ringkasan Pengurang
                </Text>
                <Baris label="Saldo Pinjaman" nilai={preview.saldoPinjaman} />
                <Baris label="Kewajiban Lain" nilai={preview.kewajibanLain} />
                <Baris label="Total Pengurang" nilai={preview.totalPengurang} tebal />

                <View style={styles.pemisah} />
                <Baris label="Nilai Pengembalian" nilai={preview.nilaiPengembalian} tebal />
                {preview.tidakAdaPengembalian && (
                  <Text style={styles.catatan}>
                    Tidak ada pengembalian — seluruh hak anggota habis untuk menutup kewajibannya.
                    Sisa pinjaman yang belum tertutup TETAP tercatat sebagai piutang koperasi.
                  </Text>
                )}
                {preview.shuHakAnggota > 0 && (
                  <Text style={styles.catatan}>
                    SHU sudah disahkan RAT tetapi belum dibagikan. Selesaikan pembagian SHU lebih
                    dahulu; pembayaran keluar anggota akan ditolak sampai SHU tercatat sebagai
                    kewajiban.
                  </Text>
                )}
              </>
            ) : null}
          </View>
        )}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
        <FocusTextInput
          style={[styles.input, styles.textArea]}
          value={keterangan}
          onChangeText={setKeterangan}
          placeholder="Keterangan tambahan (opsional)"
          placeholderTextColor={colors.placeholder}
          multiline
        />

        <TouchableOpacity
          style={[styles.submitButton, sibuk === 'ajukan' && styles.disabled]}
          onPress={() => void ajukan()}
          disabled={sibuk === 'ajukan'}
        >
          {sibuk === 'ajukan' ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="exit-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Ajukan Keluar Anggota</Text>
            </>
          )}
        </TouchableOpacity>

      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  label: { fontSize: 12, color: colors.text, fontWeight: '600', marginBottom: spacing.xs },
  catatan: { fontSize: 11, color: colors.textFaint, lineHeight: 16, marginTop: spacing.sm },
  input: { ...formUi.inputStandalone },
  textArea: { ...formUi.inputStandaloneMultiline },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  chipTextAktif: { color: colors.white },

  ringkasCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  ringkasJudul: { fontSize: 12, fontWeight: '700', color: colors.primary, marginBottom: spacing.xs },
  ringkasBaris: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  ringkasLabel: { fontSize: 12, color: colors.textMuted },
  ringkasNilai: { fontSize: 12, color: colors.text },
  ringkasTebal: { fontWeight: '700', color: colors.text },
  pemisah: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },

  submitButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.6 },

});
