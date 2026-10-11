import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, Modal, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import FocusTextInput from '@/components/FocusTextInput';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker, { formatTanggalIndonesia } from '@/components/DatePicker';
import PilihanOpsi from '@/components/form/PilihanOpsi';
import {
  LABEL_JENIS_KOREKSI,
  ambilRekeningBankKoreksi,
  koreksiAngsuran,
  koreksiPencairanPinjaman,
  koreksiSetoranSimpanan,
  type PemeriksaanKoreksi,
} from '@/services/KoreksiTransaksiService';
import { formatRupiah } from '@/utils/money';
import { notify } from '@/store/useNotifyStore';
import { getWaktuSekarang } from '@/services/DevClockService';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';

/**
 * RC-S133.6.2 — FORM KOREKSI TRANSAKSI (setoran simpanan, pencairan, angsuran).
 *
 * Koreksi = jurnal pembalik + (opsional) pencatatan ulang dengan data yang
 * benar, dalam satu transaksi database (KoreksiTransaksiService). Jurnal asal
 * tidak diedit/dihapus. Alasan wajib; pengguna yang menjalankan tercatat
 * sebagai pengotorisasi di jejak koreksi.
 */
export default function FormKoreksiTransaksi({
  visible,
  pemeriksaan,
  userId,
  onClose,
  onSelesai,
}: {
  visible: boolean;
  pemeriksaan: PemeriksaanKoreksi;
  userId: string;
  onClose: () => void;
  onSelesai: () => void;
}) {
  const s = pemeriksaan.setoran;
  const c = pemeriksaan.pencairan;
  const a = pemeriksaan.angsuran;
  const asal = s ?? c ?? a;

  const [alasan, setAlasan] = useState('');
  const [catatUlang, setCatatUlang] = useState(true);
  const [tanggal, setTanggal] = useState(asal?.tanggal ?? '');
  const [pokok, setPokok] = useState<number | ''>(s?.pokok ?? 0);
  const [wajib, setWajib] = useState<number | ''>(s?.wajib ?? 0);
  const [sukarela, setSukarela] = useState<number | ''>(s?.sukarela ?? 0);
  const [nominal, setNominal] = useState<number | ''>(a?.nominal ?? 0);
  const [sumberDana, setSumberDana] = useState<'KAS' | 'BANK'>(asal?.sumberDana ?? 'KAS');
  const [bankId, setBankId] = useState<string>(asal?.bankAccountId ?? '');
  const [banks, setBanks] = useState<{ id: string; namaBank: string; nomorRekening: string }[]>([]);
  const [proses, setProses] = useState(false);

  useEffect(() => {
    if (!visible) return;
    void ambilRekeningBankKoreksi()
      .then((b) => {
        setBanks(b);
        if (!bankId && b.length === 1) setBankId(b[0].id);
      })
      .catch(() => setBanks([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const galatForm = useMemo(() => {
    if (alasan.trim().length < 5) return 'Isi alasan koreksi (minimal 5 karakter).';
    if (!catatUlang) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) return 'Pilih tanggal pencatatan ulang.';
    if (sumberDana === 'BANK' && !bankId) return 'Pilih rekening bank.';
    if (s && Number(pokok || 0) + Number(wajib || 0) + Number(sukarela || 0) <= 0) return 'Isi minimal satu nominal simpanan.';
    if (a && Number(nominal || 0) <= 0) return 'Isi nominal pembayaran.';
    return null;
  }, [alasan, catatUlang, tanggal, sumberDana, bankId, s, a, pokok, wajib, sukarela, nominal]);

  const jalankan = async () => {
    if (galatForm || proses) return;
    setProses(true);
    try {
      const bank = sumberDana === 'BANK' ? bankId : undefined;
      if (s) {
        await koreksiSetoranSimpanan({
          journalId: pemeriksaan.journalId,
          alasan,
          userId,
          catatUlang: catatUlang
            ? { tanggal, pokok: Number(pokok || 0), wajib: Number(wajib || 0), sukarela: Number(sukarela || 0), sumberDana, bankAccountId: bank }
            : null,
        });
      } else if (c) {
        await koreksiPencairanPinjaman({
          journalId: pemeriksaan.journalId,
          alasan,
          userId,
          cairkanUlang: catatUlang ? { tanggal, sumberDana, bankAccountId: bank } : null,
        });
      } else if (a) {
        await koreksiAngsuran({
          journalId: pemeriksaan.journalId,
          alasan,
          userId,
          bayarUlang: catatUlang ? { tanggal, nominal: Number(nominal || 0), sumberDana, bankAccountId: bank } : null,
        });
      }
      notify(
        'Koreksi tersimpan',
        catatUlang
          ? 'Transaksi asal dibalik dengan jurnal pembalik dan dicatat ulang dengan data yang benar. Jejak koreksi tercatat.'
          : 'Transaksi asal dibalik dengan jurnal pembalik. Jejak koreksi tercatat.'
      );
      onSelesai();
    } catch (e) {
      notify('Koreksi gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProses(false);
    }
  };

  const labelUlang = c ? 'Cairkan ulang dengan data yang benar' : a ? 'Catat ulang pembayaran yang benar' : 'Catat ulang setoran yang benar';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <AreaAmanKeyboard varian="dialog" style={styles.backdrop}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card} testID="form-koreksi-transaksi">
            <Text style={styles.judul}>Koreksi {LABEL_JENIS_KOREKSI[pemeriksaan.jenis]}</Text>
            <Text style={styles.sub}>
              Jurnal {pemeriksaan.nomorJurnal} tidak diubah atau dihapus: dibuat jurnal PEMBALIK bertanggal hari ini
              {catatUlang ? ', lalu transaksi dicatat ulang dengan data di bawah' : ''}. Keduanya ditautkan ke transaksi asal.
            </Text>

            <View style={styles.kotakAsal}>
              <Text style={styles.kotakJudul}>Transaksi asal</Text>
              {s ? (
                <>
                  <Baris label="Anggota" nilai={`${s.nomorAnggota} — ${s.namaAnggota}`} />
                  <Baris label="Tanggal" nilai={formatTanggalIndonesia(s.tanggal)} />
                  <Baris label="Pokok / Wajib / Sukarela" nilai={`${formatRupiah(s.pokok)} / ${formatRupiah(s.wajib)} / ${formatRupiah(s.sukarela)}`} />
                  <Baris label="Sumber dana" nilai={s.sumberDana} />
                </>
              ) : null}
              {c ? (
                <>
                  <Baris label="Pinjaman" nilai={`${c.nomorPinjaman} — ${c.namaAnggota}`} />
                  <Baris label="Tanggal cair" nilai={formatTanggalIndonesia(c.tanggal)} />
                  <Baris label="Jumlah" nilai={formatRupiah(c.jumlahPinjaman)} />
                  <Baris label="Sumber dana" nilai={c.sumberDana} />
                </>
              ) : null}
              {a ? (
                <>
                  <Baris label="Pinjaman" nilai={`${a.nomorPinjaman} — ${a.namaAnggota}`} />
                  <Baris label="Angsuran ke" nilai={String(a.nomorAngsuran)} />
                  <Baris label="Tanggal bayar" nilai={formatTanggalIndonesia(a.tanggal)} />
                  <Baris label="Nominal" nilai={`${formatRupiah(a.nominal)} (pokok ${formatRupiah(a.porsiPokok)}, jasa ${formatRupiah(a.porsiJasa)}, denda ${formatRupiah(a.porsiDenda)})`} />
                </>
              ) : null}
            </View>

            {pemeriksaan.catatan.map((t, i) => (
              <View key={i} style={styles.catatan}>
                <Ionicons name="information-circle-outline" size={15} color={colors.warning} />
                <Text style={styles.catatanTeks}>{t}</Text>
              </View>
            ))}

            <Text style={styles.label}>Alasan koreksi *</Text>
            <FocusTextInput
              style={styles.input}
              value={alasan}
              onChangeText={setAlasan}
              placeholder="Mis. nominal salah ketik, seharusnya Rp50.000"
              placeholderTextColor={colors.placeholder}
              multiline
              testID="koreksi-alasan"
            />

            <View style={styles.baris}>
              <Text style={styles.labelSwitch}>{labelUlang}</Text>
              <Switch value={catatUlang} onValueChange={setCatatUlang} testID="koreksi-catat-ulang" />
            </View>

            {catatUlang ? (
              <View>
                <Text style={styles.label}>Tanggal</Text>
                <DatePicker value={tanggal} onChange={setTanggal} maximumDate={getWaktuSekarang()} />
                {s ? (
                  <>
                    <Text style={styles.label}>Simpanan Pokok</Text>
                    <CurrencyInput value={pokok} onChangeValue={setPokok} />
                    <Text style={styles.label}>Simpanan Wajib</Text>
                    <CurrencyInput value={wajib} onChangeValue={setWajib} />
                    <Text style={styles.label}>Simpanan Sukarela</Text>
                    <CurrencyInput value={sukarela} onChangeValue={setSukarela} />
                  </>
                ) : null}
                {a ? (
                  <>
                    <Text style={styles.label}>Nominal pembayaran</Text>
                    <CurrencyInput value={nominal} onChangeValue={setNominal} />
                  </>
                ) : null}
                <Text style={styles.label}>Sumber dana</Text>
                <PilihanOpsi
                  opsi={[
                    { nilai: 'KAS', label: 'Kas', ikon: 'cash-outline' },
                    { nilai: 'BANK', label: 'Bank', ikon: 'business-outline' },
                  ]}
                  nilai={sumberDana}
                  onChange={(v) => setSumberDana(v as 'KAS' | 'BANK')}
                />
                {sumberDana === 'BANK' ? (
                  banks.length === 0 ? (
                    <Text style={styles.galat}>Belum ada rekening bank aktif.</Text>
                  ) : (
                    <View style={{ marginTop: spacing.sm }}>
                      <PilihanOpsi
                        opsi={banks.map((b) => ({ nilai: b.id, label: `${b.namaBank} ${b.nomorRekening}` }))}
                        nilai={bankId}
                        onChange={setBankId}
                      />
                    </View>
                  )
                ) : null}
                {c ? (
                  <Text style={styles.petunjuk}>Jumlah pinjaman dan jadwal angsuran tetap. Bila jumlah/tenor salah, matikan pilihan ini lalu ubah pinjaman dari menu Pinjaman.</Text>
                ) : null}
              </View>
            ) : (
              <Text style={styles.petunjuk}>
                {c
                  ? 'Pinjaman kembali berstatus Disetujui (belum cair).'
                  : 'Transaksi hanya dibalik; tidak ada transaksi pengganti.'}
              </Text>
            )}

            {galatForm ? <Text style={styles.galat}>{galatForm}</Text> : null}

            <View style={styles.aksi}>
              <TouchableOpacity style={styles.tombolBatal} onPress={onClose} disabled={proses}>
                <Text style={styles.tombolBatalTeks}>Tutup</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tombolKoreksi, (!!galatForm || proses) && styles.nonaktif]}
                onPress={jalankan}
                disabled={!!galatForm || proses}
                accessibilityRole="button"
                testID="koreksi-simpan"
              >
                {proses ? <ActivityIndicator color={colors.white} /> : <Text style={styles.tombolKoreksiTeks}>Simpan Koreksi</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </AreaAmanKeyboard>
    </Modal>
  );
}

function Baris({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.barisAsal}>
      <Text style={styles.barisLabel}>{label}</Text>
      <Text style={styles.barisNilai}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...modalUi.backdrop },
  scroll: { ...modalUi.scrollContent },
  card: { ...modalUi.card },
  judul: { ...modalUi.title },
  sub: { ...modalUi.description },
  kotakAsal: { backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.sm },
  kotakJudul: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', marginBottom: 4 },
  barisAsal: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: 2 },
  barisLabel: { fontSize: 12, color: colors.textMuted },
  barisNilai: { fontSize: 12, color: colors.text, flex: 1, textAlign: 'right' },
  catatan: { flexDirection: 'row', gap: 6, marginTop: spacing.sm, alignItems: 'flex-start' },
  catatanTeks: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  label: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginTop: spacing.md, marginBottom: 4 },
  input: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  baris: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md, gap: spacing.sm },
  labelSwitch: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text },
  petunjuk: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 17 },
  galat: { fontSize: 12, color: colors.danger, marginTop: spacing.sm },
  aksi: { ...modalUi.actions, marginTop: spacing.md },
  tombolBatal: { ...modalUi.secondaryButton },
  tombolBatalTeks: { ...modalUi.secondaryText },
  tombolKoreksi: { ...modalUi.destructiveButton },
  tombolKoreksiTeks: { ...modalUi.primaryText },
  nonaktif: { opacity: 0.6 },
});
