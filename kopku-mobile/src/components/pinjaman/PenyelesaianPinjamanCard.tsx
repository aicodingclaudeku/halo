import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Modal, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import { notify } from '@/store/useNotifyStore';
import { useAppStore } from '@/store/useAppStore';
import { usePermission } from '@/hooks/usePermission';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  DAFTAR_JALUR_PENYELESAIAN,
  LABEL_JALUR_PENYELESAIAN,
  LABEL_NOMOR_PENYELESAIAN,
  LABEL_TANGGAL_PENYELESAIAN,
  validasiPenyelesaian,
  type JalurPenyelesaian,
  type PenyelesaianPinjaman,
} from '@/accounting/PenyelesaianPinjaman';
import { catatPenyelesaianPinjaman, batalkanPenyelesaianPinjaman } from '@/services/PenyelesaianPinjamanService';

/**
 * RC-S133.6.4 (v82) — KARTU "PENYELESAIAN PENGADILAN / ASURANSI" di Detail
 * Pinjaman. Pencatatan MANUAL kriteria Macet angka 3 (SOM 12.1): penyelesaian
 * sudah diserahkan ke Pengadilan Negeri atau diajukan klaim ke perusahaan
 * asuransi kredit.
 *
 * - Terlihat bila pinjaman AKTIF, atau bila sudah ada pencatatan (riwayat).
 * - Tombol catat/ubah/batalkan hanya untuk role berizin `pinjaman:approve`
 *   (bawaan Admin & Pengurus). Penjaga sebenarnya ada di service.
 * - Tidak membuat jurnal; hanya memengaruhi penggolongan kolektibilitas
 *   (Macet sejak tanggal yang dicatat). Setiap perubahan masuk audit_log.
 */
interface Props {
  pinjamanId: string;
  statusPinjaman: string;
  tanggalPinjaman: string;
  penyelesaian: PenyelesaianPinjaman | null;
  /** Dipanggil setelah pencatatan berubah, agar layar induk memuat ulang. */
  onBerubah: () => void | Promise<void>;
}

export default function PenyelesaianPinjamanCard({ pinjamanId, statusPinjaman, tanggalPinjaman, penyelesaian, onBerubah }: Props) {
  const currentUser = useAppStore((s) => s.currentUser);
  const { can } = usePermission();
  const bolehMencatat = can('pinjaman', 'approve');

  const [formTerbuka, setFormTerbuka] = useState(false);
  const [batalTerbuka, setBatalTerbuka] = useState(false);
  const [jalur, setJalur] = useState<JalurPenyelesaian>('PENGADILAN');
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [nomor, setNomor] = useState('');
  const [dokumen, setDokumen] = useState('');
  const [alasan, setAlasan] = useState('');
  const [alasanBatal, setAlasanBatal] = useState('');
  const [galat, setGalat] = useState<string[]>([]);
  const [proses, setProses] = useState(false);

  const aktif = statusPinjaman === 'AKTIF';
  if (!aktif && !penyelesaian) return null;

  const bukaForm = () => {
    setJalur(penyelesaian?.jalur ?? 'PENGADILAN');
    setTanggal(penyelesaian?.tanggal || getTanggalLokalHariIni());
    setNomor(penyelesaian?.nomor ?? '');
    setDokumen(penyelesaian?.dokumen ?? '');
    setAlasan(penyelesaian?.alasan ?? '');
    setGalat([]);
    setFormTerbuka(true);
  };

  const simpan = async () => {
    if (!currentUser) return;
    // Validasi yang sama dengan service, supaya pesan muncul di form (bukan hanya saat simpan).
    const v = validasiPenyelesaian({ jalur, tanggal, nomor, dokumen, alasan }, getTanggalLokalHariIni(), tanggalPinjaman);
    if (!v.valid) {
      setGalat(v.galat);
      return;
    }
    setGalat([]);
    setProses(true);
    try {
      await catatPenyelesaianPinjaman({ pinjamanId, jalur, tanggal, nomor, dokumen, alasan, actingUserId: currentUser.id });
      setFormTerbuka(false);
      await onBerubah();
      notify(
        'Tercatat',
        'Penyelesaian dicatat. Pinjaman digolongkan Macet sejak tanggal tersebut (Laporan Kolektibilitas Piutang). Tidak ada jurnal yang dibuat.'
      );
    } catch (e) {
      setGalat([e instanceof Error ? e.message : 'Terjadi kesalahan.']);
    } finally {
      setProses(false);
    }
  };

  const batalkan = async () => {
    if (!currentUser || !alasanBatal.trim()) return;
    setProses(true);
    try {
      await batalkanPenyelesaianPinjaman({ pinjamanId, alasan: alasanBatal.trim(), actingUserId: currentUser.id });
      setBatalTerbuka(false);
      setAlasanBatal('');
      await onBerubah();
      notify('Dibatalkan', 'Pencatatan penyelesaian dibatalkan. Riwayatnya tetap tersimpan di audit log.');
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProses(false);
    }
  };

  return (
    <View style={s.kartu} testID="kartu-penyelesaian-pinjaman">
      <View style={s.judulBaris}>
        <Ionicons name="hammer-outline" size={18} color={colors.primary} />
        <Text style={s.judul}>Penyelesaian Pengadilan / Asuransi</Text>
      </View>

      {penyelesaian ? (
        <>
          <View style={s.pil}>
            <Text style={s.pilTeks}>MACET sejak {penyelesaian.tanggal}</Text>
          </View>
          <Baris label="Jalur" nilai={LABEL_JALUR_PENYELESAIAN[penyelesaian.jalur]} />
          <Baris label={LABEL_NOMOR_PENYELESAIAN[penyelesaian.jalur]} nilai={penyelesaian.nomor} />
          <Baris label="Dokumen" nilai={penyelesaian.dokumen} />
          {penyelesaian.alasan ? <Baris label="Keterangan" nilai={penyelesaian.alasan} /> : null}
          <Text style={s.catatan}>
            Kriteria Macet angka 3 (SOM 12.1). Dicatat manual; perubahannya tersimpan di audit log. Tidak ada jurnal.
          </Text>
          {bolehMencatat && aktif && (
            <View style={s.aksi}>
              <TouchableOpacity style={s.tombolSekunder} onPress={bukaForm} testID="tombol-ubah-penyelesaian">
                <Text style={s.tombolSekunderTeks}>Ubah</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.tombolBahaya} onPress={() => setBatalTerbuka(true)} testID="tombol-batal-penyelesaian">
                <Text style={s.tombolBahayaTeks}>Batalkan Pencatatan</Text>
              </TouchableOpacity>
            </View>
          )}
        </>
      ) : (
        <>
          <Text style={s.catatan}>
            Belum ada. Catat bila penyelesaian pinjaman ini sudah diserahkan ke Pengadilan Negeri atau sudah diajukan klaim
            ganti rugi ke perusahaan asuransi kredit — pinjaman akan digolongkan Macet (SOM 12.1 kriteria Macet angka 3).
          </Text>
          {bolehMencatat ? (
            <TouchableOpacity style={s.tombolUtama} onPress={bukaForm} testID="tombol-catat-penyelesaian">
              <Text style={s.tombolUtamaTeks}>Catat Penyelesaian</Text>
            </TouchableOpacity>
          ) : (
            <Text style={s.catatan}>Hanya Admin/Pengurus yang dapat mencatat.</Text>
          )}
        </>
      )}

      <Modal visible={formTerbuka} transparent animationType="fade" onRequestClose={() => setFormTerbuka(false)}>
        <AreaAmanKeyboard varian="dialog" style={s.overlay}>
          <ScrollView contentContainerStyle={s.scrollIsi} keyboardShouldPersistTaps="handled">
            <View style={s.modalKartu}>
              <Text style={s.modalJudul}>{penyelesaian ? 'Ubah Penyelesaian' : 'Catat Penyelesaian'}</Text>
              <Text style={s.modalSub}>
                Isi dari dokumen resmi. Pinjaman akan digolongkan Macet sejak tanggal ini. Tidak ada jurnal yang dibuat.
              </Text>

              <Text style={s.label}>Jalur *</Text>
              <View style={s.jalurBaris}>
                {DAFTAR_JALUR_PENYELESAIAN.map((j) => (
                  <TouchableOpacity
                    key={j}
                    style={[s.chip, jalur === j && s.chipAktif]}
                    onPress={() => setJalur(j)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: jalur === j }}
                  >
                    <Text style={[s.chipTeks, jalur === j && s.chipTeksAktif]}>{LABEL_JALUR_PENYELESAIAN[j]}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={s.label}>{LABEL_TANGGAL_PENYELESAIAN[jalur]} *</Text>
              <DatePicker value={tanggal} onChange={setTanggal} />

              <Text style={s.label}>{LABEL_NOMOR_PENYELESAIAN[jalur]} *</Text>
              <FocusTextInput style={s.input} value={nomor} onChangeText={setNomor} placeholder={jalur === 'PENGADILAN' ? 'mis. 123/Pdt.G/2026/PN Xxx' : 'mis. KLM-2026-0001'} />

              <Text style={s.label}>Dokumen bukti *</Text>
              <FocusTextInput style={s.input} value={dokumen} onChangeText={setDokumen} placeholder="mis. Surat gugatan tgl 1-9-2026 / Surat klaim No. ..." />

              <Text style={s.label}>Keterangan (opsional)</Text>
              <FocusTextInput style={[s.input, s.inputBanyak]} value={alasan} onChangeText={setAlasan} multiline placeholder="Catatan tambahan" />

              {galat.length > 0 && (
                <View style={s.galatKotak} testID="galat-penyelesaian">
                  {galat.map((g, i) => (
                    <Text key={i} style={s.galatTeks}>
                      • {g}
                    </Text>
                  ))}
                </View>
              )}

              <View style={s.modalAksi}>
                <TouchableOpacity style={s.batalTombol} onPress={() => setFormTerbuka(false)}>
                  <Text style={s.batalTeks}>Tutup</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.simpanTombol, proses && s.nonaktif]} onPress={simpan} disabled={proses} testID="simpan-penyelesaian">
                  {proses ? <ActivityIndicator color={colors.white} /> : <Text style={s.simpanTeks}>Simpan</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>

      <Modal visible={batalTerbuka} transparent animationType="fade" onRequestClose={() => setBatalTerbuka(false)}>
        <AreaAmanKeyboard varian="dialog" style={s.overlay}>
          <ScrollView contentContainerStyle={s.scrollIsi} keyboardShouldPersistTaps="handled">
            <View style={s.modalKartu}>
              <Text style={s.modalJudul}>Batalkan Pencatatan</Text>
              <Text style={s.modalSub}>
                Pencatatan dikosongkan; pinjaman kembali digolongkan menurut tunggakan dan agunannya. Riwayat tetap ada di audit log.
              </Text>
              <FocusTextInput
                style={[s.input, s.inputBanyak]}
                value={alasanBatal}
                onChangeText={setAlasanBatal}
                multiline
                placeholder="Alasan pembatalan (wajib diisi)"
              />
              <View style={s.modalAksi}>
                <TouchableOpacity style={s.batalTombol} onPress={() => setBatalTerbuka(false)}>
                  <Text style={s.batalTeks}>Tutup</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.bahayaTombol, (!alasanBatal.trim() || proses) && s.nonaktif]}
                  onPress={batalkan}
                  disabled={!alasanBatal.trim() || proses}
                >
                  {proses ? <ActivityIndicator color={colors.white} /> : <Text style={s.simpanTeks}>Batalkan</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>
    </View>
  );
}

function Baris({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={s.baris}>
      <Text style={s.barisLabel}>{label}</Text>
      <Text style={s.barisNilai}>{nilai}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  kartu: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.lg },
  judulBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  judul: { fontSize: 15, fontWeight: '800', color: colors.text },
  pil: { alignSelf: 'flex-start', backgroundColor: colors.dangerBg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, marginBottom: spacing.sm },
  pilTeks: { fontSize: 11, fontWeight: '800', color: colors.danger },
  baris: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 3 },
  barisLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 0 },
  barisNilai: { fontSize: 12, color: colors.text, fontWeight: '600', flex: 1, textAlign: 'right' },
  catatan: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: spacing.sm },
  aksi: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  tombolUtama: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 11, alignItems: 'center', marginTop: spacing.md },
  tombolUtamaTeks: { color: colors.white, fontWeight: '700', fontSize: 13 },
  tombolSekunder: { flex: 1, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, paddingVertical: 10, alignItems: 'center' },
  tombolSekunderTeks: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  tombolBahaya: { flex: 1, borderWidth: 1, borderColor: colors.danger, borderRadius: radius.sm, paddingVertical: 10, alignItems: 'center' },
  tombolBahayaTeks: { color: colors.danger, fontWeight: '700', fontSize: 13 },
  overlay: { ...modalUi.backdrop },
  scrollIsi: { ...modalUi.scrollContent },
  modalKartu: { ...modalUi.card },
  modalJudul: { fontSize: 16, fontWeight: '800', color: colors.text },
  modalSub: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 4, marginBottom: spacing.sm },
  label: { fontSize: 12, fontWeight: '700', color: colors.text, marginTop: spacing.md, marginBottom: 4 },
  input: { ...formUi.inputStandalone },
  inputBanyak: { ...formUi.inputStandaloneMultiline },
  jalurBaris: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  chipAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTeks: { fontSize: 12, color: colors.text },
  chipTeksAktif: { color: colors.white, fontWeight: '600' },
  galatKotak: { backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.md },
  galatTeks: { fontSize: 12, color: colors.danger, lineHeight: 17 },
  modalAksi: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
  batalTombol: { paddingHorizontal: spacing.lg, paddingVertical: 10 },
  batalTeks: { color: colors.textMuted, fontWeight: '600' },
  simpanTombol: { backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.sm },
  bahayaTombol: { backgroundColor: colors.danger, paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.sm },
  simpanTeks: { color: colors.white, fontWeight: '700' },
  nonaktif: { opacity: 0.5 },
});
