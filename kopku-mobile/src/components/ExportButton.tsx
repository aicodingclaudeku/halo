import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DataLaporanExport, FormatExport, type GayaPdfLaporanKeuangan } from '@/export/ExportTypes';
import { GAYA_PDF_BAWAAN, getGayaPdfLaporanKeuangan, setGayaPdfLaporanKeuangan } from '@/services/PreferensiCetakService';
import { exportLaporan, shareExportedFile } from '@/services/ExportService';
import { useAppStore } from '@/store/useAppStore';
import PratinjauGayaPdf from '@/components/PratinjauGayaPdf';
import { notify } from '@/store/useNotifyStore';

interface ExportButtonProps {
  /** Data laporan yang SUDAH dibangun oleh ReportTableBuilders — null berarti belum siap (mis. masih loading). */
  data: DataLaporanExport | null;
  /** Label tombol, default "Export". */
  label?: string;
  /**
   * Tampilan tombol. 'header' = versi ringkas berikon untuk dipasang di
   * `headerRight` navigasi (sejajar judul layar), mengikuti tombol
   * Export di SimpananHistoriScreen. Logika export & modal format TIDAK
   * berbeda antar-varian.
   */
  variant?: 'default' | 'header';
  /**
   * Pilihan tambahan OPSIONAL di atas daftar format (mis. rentang histori
   * transaksi pada Detail Anggota). Layar pemanggil menyimpan nilainya dan
   * membangun ulang `data` sesuai pilihan; export memakai `data` terbaru.
   * Tanpa prop ini tampilan modal sama persis seperti sebelumnya.
   */
  pilihan?: {
    judul: string;
    opsi: readonly { kunci: string; label: string }[];
    nilai: string;
    onPilih: (kunci: string) => void;
    keterangan?: string;
  };
}

const FORMAT_OPTIONS: { format: FormatExport; label: string; sub: string }[] = [
  { format: 'PDF', label: 'PDF', sub: 'Untuk dicetak atau dibagikan sebagai dokumen' },
  { format: 'EXCEL', label: 'Excel (.xlsx)', sub: 'Untuk diolah lebih lanjut di spreadsheet' },
  { format: 'CSV', label: 'CSV', sub: 'Data mentah, kompatibel dengan aplikasi lain' },
];

/**
 * Dua template PDF untuk 5 laporan keuangan pokok (LPK, LPHU, LPE, LAK,
 * CALK). Standar = bawaan. Hanya bentuk cetak PDF; angka dan file
 * Excel/CSV sama persis.
 */
const GAYA_OPTIONS: { gaya: GayaPdfLaporanKeuangan; label: string; lencana?: string; sub: string }[] = [
  {
    gaya: 'STANDAR',
    label: 'Standar',
    lencana: 'Bawaan',
    sub: 'Kop di tengah, tabel bergaris tipis, angka dengan "Rp", ringkasan, dan tanda tangan pengurus.',
  },
  {
    gaya: 'JUKLAT',
    label: 'Contoh Laporan Juklat SOM 2025',
    sub: 'Mengikuti contoh laporan pada Lampiran Juklat SOM 2025: kop di dalam tabel berkisi, kolom tahun lama → baru, angka tanpa "Rp", dan tanda tangan pengurus.',
  },
];

/**
 * Tombol Export dipakai berulang di semua layar laporan (fase 6:
 * "Tombol Export pada laporan yang relevan", "Pilihan format PDF/
 * Excel/CSV", "Preview atau status proses export").
 */
export default function ExportButton({ data: dataLaporan, label = 'Export', variant = 'default', pilihan }: ExportButtonProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  // RC-S100 — logo koperasi ikut ke kop PDF. Diambil di SINI (satu titik
  // yang dilewati SELURUH export laporan) supaya 30+ builder laporan dan
  // layar pemanggilnya tidak perlu diubah satu per satu.
  const logoUri = useAppStore((s) => s.koperasi?.logoUri);
  const [pilihFormat, setPilihFormat] = useState(false);
  const [memproses, setMemproses] = useState<FormatExport | null>(null);
  const [gayaPdf, setGayaPdf] = useState<GayaPdfLaporanKeuangan>(GAYA_PDF_BAWAAN);
  // Pilihan tampilan hanya relevan untuk laporan keuangan pokok.
  const adaPilihanGaya = !!dataLaporan?.laporanKeuangan?.juklat;

  // Pilihan terakhir pengguna dimuat saat lembar format dibuka.
  useEffect(() => {
    if (!pilihFormat || !adaPilihanGaya) return;
    let batal = false;
    getGayaPdfLaporanKeuangan()
      .then((g) => {
        if (!batal) setGayaPdf(g);
      })
      .catch(() => undefined);
    return () => {
      batal = true;
    };
  }, [pilihFormat, adaPilihanGaya]);

  const pilihGaya = (g: GayaPdfLaporanKeuangan) => {
    setGayaPdf(g);
    setGayaPdfLaporanKeuangan(g).catch(() => undefined);
  };

  const jalankanExport = async (format: FormatExport) => {
    // Tampilan PDF yang dipilih ikut ke data laporan keuangan; laporan lain apa adanya.
    const data =
      dataLaporan && format === 'PDF' && dataLaporan.laporanKeuangan
        ? { ...dataLaporan, laporanKeuangan: { ...dataLaporan.laporanKeuangan, gayaPdf } }
        : dataLaporan;
    if (!data || !currentUser) return;
    setPilihFormat(false);
    setMemproses(format);
    try {
      const file = await exportLaporan(currentUser.id, data, format, logoUri);
      setMemproses(null);
      notify('Export Berhasil', `File ${file.fileName} berhasil dibuat.`, [
        { text: 'Tutup', style: 'cancel' },
        { text: 'Bagikan', onPress: () => shareExportedFile(file).catch((e) => notify('Gagal Membagikan', e instanceof Error ? e.message : 'Terjadi kesalahan.')) },
      ]);
    } catch (e) {
      setMemproses(null);
      notify('Export Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan saat membuat file.');
    }
  };

  const disabled = !dataLaporan || memproses !== null;

  return (
    <>
      {variant === 'header' ? (
        <TouchableOpacity
          style={[styles.headerButton, disabled && styles.buttonDisabled]}
          onPress={() => setPilihFormat(true)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={label}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {memproses ? (
            <ActivityIndicator color="#1B5E20" size="small" />
          ) : (
            <Ionicons name="download-outline" size={18} color="#1B5E20" />
          )}
          <Text style={styles.headerButtonText}>{memproses ? `${memproses}…` : label}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.button, disabled && styles.buttonDisabled]}
          onPress={() => setPilihFormat(true)}
          disabled={disabled}
        >
          {memproses ? (
            <View style={styles.progressRow}>
              <ActivityIndicator color="#1B5E20" size="small" />
              <Text style={styles.buttonText}>Membuat {memproses}…</Text>
            </View>
          ) : (
            <Text style={styles.buttonText}>{label}</Text>
          )}
        </TouchableOpacity>
      )}

      <Modal visible={pilihFormat} transparent animationType="fade" onRequestClose={() => setPilihFormat(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
            <Text style={styles.cardTitle}>Pilih Format Export</Text>
            {pilihan ? (
              <View style={styles.gayaBlok}>
                <Text style={styles.gayaJudul}>{pilihan.judul}</Text>
                <View style={styles.gayaRow}>
                  {pilihan.opsi.map((o) => {
                    const aktif = pilihan.nilai === o.kunci;
                    return (
                      <TouchableOpacity
                        key={o.kunci}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: aktif }}
                        style={[styles.gayaItem, aktif && styles.gayaItemAktif]}
                        onPress={() => pilihan.onPilih(o.kunci)}
                      >
                        <Text style={[styles.gayaLabel, aktif && styles.gayaLabelAktif]}>{o.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {pilihan.keterangan ? <Text style={styles.gayaSub}>{pilihan.keterangan}</Text> : null}
              </View>
            ) : null}
            {adaPilihanGaya ? (
              <View style={styles.gayaBlok}>
                <Text style={styles.gayaJudul}>Template PDF</Text>
                <View style={styles.templateRow}>
                  {GAYA_OPTIONS.map((o) => {
                    const aktif = gayaPdf === o.gaya;
                    return (
                      <TouchableOpacity
                        key={o.gaya}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: aktif }}
                        accessibilityLabel={`Template ${o.label}`}
                        style={[styles.templateKartu, aktif && styles.templateKartuAktif]}
                        onPress={() => pilihGaya(o.gaya)}
                        activeOpacity={0.85}
                      >
                        <View style={styles.templatePratinjau}>
                          <PratinjauGayaPdf gaya={o.gaya} />
                          {aktif ? (
                            <View style={styles.templateCentang}>
                              <Ionicons name="checkmark" size={12} color="#fff" />
                            </View>
                          ) : null}
                        </View>
                        <Text style={[styles.templateLabel, aktif && styles.templateLabelAktif]} numberOfLines={2}>
                          {o.label}
                        </Text>
                        {o.lencana ? <Text style={styles.templateLencana}>{o.lencana}</Text> : null}
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={styles.gayaSub}>{GAYA_OPTIONS.find((o) => o.gaya === gayaPdf)?.sub}</Text>
                <Text style={styles.templateCatatan}>Berlaku untuk PDF. Excel dan CSV tidak terpengaruh.</Text>
              </View>
            ) : null}
            {FORMAT_OPTIONS.map((opt) => (
              <TouchableOpacity key={opt.format} style={styles.option} onPress={() => jalankanExport(opt.format)}>
                <Text style={styles.optionLabel}>{opt.label}</Text>
                <Text style={styles.optionSub}>{opt.sub}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.cancel} onPress={() => setPilihFormat(false)}>
              <Text style={styles.cancelText}>Batal</Text>
            </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#1B5E20',
    alignSelf: 'flex-start',
    marginBottom: 12,
  },
  buttonDisabled: { opacity: 0.5 },
  headerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#E8F3E9',
  },
  headerButtonText: { color: '#1B5E20', fontSize: 13, fontWeight: '700' },
  buttonText: { color: '#1B5E20', fontWeight: '700', fontSize: 13 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, maxHeight: '92%' },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#222', marginBottom: 12 },
  option: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EEE' },
  optionLabel: { fontSize: 14, fontWeight: '600', color: '#222' },
  optionSub: { fontSize: 11, color: '#888', marginTop: 2 },
  cancel: { paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  cancelText: { color: '#888', fontWeight: '600' },
  gayaBlok: { marginBottom: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#EEE' },
  gayaJudul: { fontSize: 12, fontWeight: '700', color: '#555', marginBottom: 6 },
  gayaRow: { flexDirection: 'row', gap: 8 },
  gayaItem: { flex: 1, borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  gayaItemAktif: { backgroundColor: '#1B5E20', borderColor: '#1B5E20' },
  gayaLabel: { fontSize: 13, fontWeight: '600', color: '#222' },
  gayaLabelAktif: { color: '#fff' },
  gayaSub: { fontSize: 11, color: '#888', marginTop: 6, lineHeight: 15 },
  templateRow: { flexDirection: 'row', gap: 10 },
  templateKartu: { flex: 1, borderWidth: 1, borderColor: '#DDD', borderRadius: 10, padding: 8, backgroundColor: '#FAFBFA' },
  templateKartuAktif: { borderColor: '#1B5E20', borderWidth: 2, padding: 7, backgroundColor: '#F1F7F1' },
  templatePratinjau: { paddingHorizontal: 10, paddingTop: 2, paddingBottom: 6 },
  templateCentang: {
    position: 'absolute',
    top: -4,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#1B5E20',
    alignItems: 'center',
    justifyContent: 'center',
  },
  templateLabel: { fontSize: 12, fontWeight: '700', color: '#222', textAlign: 'center', lineHeight: 16 },
  templateLabelAktif: { color: '#1B5E20' },
  templateLencana: { alignSelf: 'center', marginTop: 3, fontSize: 9.5, fontWeight: '700', color: '#1B5E20', backgroundColor: '#E8F3E9', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, overflow: 'hidden' },
  templateCatatan: { fontSize: 10.5, color: '#9a9a9a', marginTop: 4, fontStyle: 'italic' },
});
