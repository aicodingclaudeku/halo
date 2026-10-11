import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { usePermission } from '@/hooks/usePermission';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { hitungBungaPascaJatuhTempoSatuPeriode } from '@/accounting/SimpananBerjangkaBunga';
import {
  formatPersen,
  KebijakanProdukBerjangka,
  pilihKebijakanUntukTanggal,
  REKOMENDASI_KEBIJAKAN_PRODUK,
  ringkasanPerlakuanPascaJatuhTempo,
  validasiDrafKebijakanProduk,
} from '@/accounting/SimpananBerjangkaKebijakanProduk';
import {
  cabutKebijakanProduk,
  KontrakLegacyReview,
  listKebijakanProduk,
  listKontrakLegacyPerluReview,
  simpanKebijakanProduk,
  terapkanKebijakanKeKontrakLegacy,
} from '@/services/SimpananBerjangkaKebijakanProdukService';
import { GAYA_STATUS_BERJANGKA, tanggalPendek } from './tampilanBerjangka';
import type { StatusSimpananBerjangka } from '@/services/SimpananBerjangkaService';

/**
 * ============================================================
 * KEBIJAKAN PRODUK SIMPANAN BERJANGKA (RC-S128)
 * ============================================================
 * Satu-satunya tempat pengurus menetapkan perlakuan kontrak SETELAH
 * jatuh tempo. Layar ini tidak menghitung apa pun: validasi dari
 * `validasiDrafKebijakanProduk`, pemilihan versi dari
 * `pilihKebijakanUntukTanggal`, penyimpanan dari service (append-only).
 *
 * Isian awal mengikuti rekomendasi produk KOPKU (tanpa perpanjangan
 * otomatis, bunga pasca jatuh tempo aktif, bunga ke Simpanan Sukarela),
 * TETAPI rate pasca jatuh tempo sengaja kosong — angkanya keputusan
 * koperasi, bukan bawaan aplikasi.
 */
export default function KebijakanProdukBerjangkaScreen() {
  const currentUser = useAppStore((s) => s.currentUser);
  const { can } = usePermission();
  const bolehUbah = can('pengaturan', 'edit');
  const hariIni = getTanggalLokalHariIni();

  const [daftar, setDaftar] = useState<KebijakanProdukBerjangka[] | null>(null);
  const [legacy, setLegacy] = useState<KontrakLegacyReview[]>([]);
  const [formBuka, setFormBuka] = useState(false);
  const [menyimpan, setMenyimpan] = useState(false);

  const [versi, setVersi] = useState('');
  const [berlakuMulai, setBerlakuMulai] = useState(hariIni);
  const [pascaAktif, setPascaAktif] = useState<boolean>(REKOMENDASI_KEBIJAKAN_PRODUK.POST_MATURITY_INTEREST);
  const [rate, setRate] = useState('');
  const [dasar, setDasar] = useState('');
  const [oleh, setOleh] = useState('');
  const [ditetapkanPada, setDitetapkanPada] = useState(hariIni);
  const [catatan, setCatatan] = useState('');

  const [cabut, setCabut] = useState<KebijakanProdukBerjangka | null>(null);
  const [alasanCabut, setAlasanCabut] = useState('');
  const [terapkan, setTerapkan] = useState<KontrakLegacyReview | null>(null);
  const [terapkanPolicyId, setTerapkanPolicyId] = useState<string | null>(null);
  const [terapkanTanggal, setTerapkanTanggal] = useState(hariIni);
  const [terapkanAlasan, setTerapkanAlasan] = useState('');
  const [terapkanOleh, setTerapkanOleh] = useState('');

  const muat = useCallback(async () => {
    try {
      const [k, l] = await Promise.all([listKebijakanProduk(), listKontrakLegacyPerluReview()]);
      setDaftar(k);
      setLegacy(l);
    } catch (e) {
      setDaftar([]);
      notify('Gagal memuat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  }, []);
  useFocusRefresh(() => {
    muat();
  }, [muat]);

  const berlakuHariIni = daftar ? pilihKebijakanUntukTanggal(daftar, hariIni) : null;
  const rateAngka = rate.trim() === '' ? null : Number(rate.replace(',', '.'));
  const draf = {
    versi,
    berlakuMulai,
    autoRenewal: REKOMENDASI_KEBIJAKAN_PRODUK.AUTO_RENEWAL,
    bungaPascaJatuhTempoAktif: pascaAktif,
    ratePascaJatuhTempo: pascaAktif ? rateAngka : null,
    dasarPenetapan: dasar,
    ditetapkanOleh: oleh,
    ditetapkanPada,
    catatan,
  };

  const simpan = async () => {
    if (!currentUser) return;
    const galat = validasiDrafKebijakanProduk(draf);
    if (galat.length) {
      notify('Periksa isian', galat.join('\n'));
      return;
    }
    setMenyimpan(true);
    try {
      await simpanKebijakanProduk({ ...draf, createdBy: currentUser.id });
      notify('Kebijakan tersimpan', `Versi ${versi.trim()} berlaku mulai ${berlakuMulai} untuk kontrak yang ditempatkan sejak tanggal itu.`);
      setFormBuka(false);
      setVersi('');
      setRate('');
      setDasar('');
      setCatatan('');
      muat();
    } catch (e) {
      notify('Gagal menyimpan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpan(false);
    }
  };

  const jalankanCabut = async () => {
    if (!cabut || !currentUser) return;
    try {
      await cabutKebijakanProduk({ id: cabut.id, alasan: alasanCabut, createdBy: currentUser.id });
      setCabut(null);
      setAlasanCabut('');
      muat();
    } catch (e) {
      notify('Tidak dapat dicabut', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  };

  const jalankanTerapkan = async () => {
    if (!terapkan || !currentUser || !terapkanPolicyId) {
      notify('Pilih versi kebijakan', 'Pilih versi kebijakan yang akan diterapkan.');
      return;
    }
    try {
      await terapkanKebijakanKeKontrakLegacy({
        kontrakId: terapkan.id,
        policyId: terapkanPolicyId,
        tanggalEfektif: terapkanTanggal,
        alasan: terapkanAlasan,
        ditetapkanOleh: terapkanOleh,
        createdBy: currentUser.id,
      });
      notify('Kebijakan diterapkan', `Kontrak ${terapkan.nomorTransaksi} memakai kebijakan baru mulai ${terapkanTanggal}, tanpa perhitungan surut.`);
      setTerapkan(null);
      setTerapkanAlasan('');
      muat();
    } catch (e) {
      notify('Gagal menerapkan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  };

  if (!daftar) {
    return (
      <View style={styles.tengah}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  const aktif = daftar.filter((k) => k.status === 'AKTIF');

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView style={styles.layar} contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }} {...PROP_SCROLL_FORM}>
        {/* 0. RC-S129 — penjelasan singkat untuk pengurus */}
        <View style={styles.intro}>
          <View style={styles.introKepala}>
            <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
            <Text style={styles.introJudul}>Apa yang diatur di sini?</Text>
          </View>
          <Text style={styles.introTeks}>
            Kebijakan produk menentukan apa yang terjadi bila anggota belum mencairkan simpanannya setelah jatuh tempo.
          </Text>
          <PoinIntro teks="Setiap kontrak baru menyalin kebijakan yang berlaku pada tanggal penempatannya." />
          <PoinIntro teks="Versi yang tersimpan tidak bisa diubah. Untuk mengubah aturan, buat versi baru." />
          <PoinIntro teks="Rate pasca jatuh tempo diisi sesuai keputusan pengurus/RAT — aplikasi tidak memberi angka bawaan." />
        </View>

        {/* 1. Yang berlaku hari ini */}
        <View style={[styles.kartu, berlakuHariIni ? styles.kartuAktif : styles.kartuPeringatan]}>
          <Text style={styles.kecil}>Berlaku hari ini</Text>
          {berlakuHariIni ? (
            <>
              <Text style={styles.judulBesar}>Versi {berlakuHariIni.versi}</Text>
              <Text style={styles.teks}>{ringkasanPerlakuanPascaJatuhTempo({
                autoRenewal: berlakuHariIni.autoRenewal,
                bungaPascaAktif: berlakuHariIni.bungaPascaJatuhTempoAktif,
                ratePascaJatuhTempo: berlakuHariIni.ratePascaJatuhTempo,
              })}</Text>
              <Text style={styles.hint}>Bunga dikreditkan ke Simpanan Sukarela setelah PPh; bunga tidak pernah ditambahkan ke pokok.</Text>
              <Text style={styles.hint}>
                Dasar: {berlakuHariIni.dasarPenetapan} · ditetapkan {berlakuHariIni.ditetapkanOleh}, {tanggalPendek(berlakuHariIni.ditetapkanPada)}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.judulBesar}>Belum ada kebijakan</Text>
              <Text style={styles.teks}>Penempatan Simpanan Berjangka baru ditolak sampai pengurus menetapkan kebijakan produk.</Text>
            </>
          )}
        </View>

        {/* 2. Versi baru */}
        {bolehUbah ? (
          <TouchableOpacity style={styles.tombolGaris} onPress={() => setFormBuka((b) => !b)} accessibilityRole="button">
            <Ionicons name={formBuka ? 'chevron-up' : 'add-circle-outline'} size={18} color={colors.primary} />
            <Text style={styles.tombolGarisTeks}>{formBuka ? 'Tutup formulir' : 'Tetapkan versi kebijakan baru'}</Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.hint}>Hanya pengguna dengan izin Pengaturan yang dapat menetapkan kebijakan.</Text>
        )}
        {formBuka && bolehUbah ? (
          <View style={styles.kartu}>
            <Text style={styles.formJudul}>Versi kebijakan baru</Text>
            <Text style={styles.hint}>Isi sesuai surat keputusan pengurus. Kolom bertanda * wajib.</Text>
            <Text style={formUi.label}>Nomor versi *</Text>
            <FocusTextInput style={styles.input} value={versi} onChangeText={setVersi} placeholder="mis. KBP-2026-01" placeholderTextColor={colors.placeholder} />
            <Text style={formUi.label}>Berlaku mulai (tanggal penempatan) *</Text>
            <DatePicker value={berlakuMulai} onChange={setBerlakuMulai} />

            <View style={styles.barisSwitch}>
              <View style={{ flex: 1 }}>
                <Text style={styles.teksTebal}>Bunga pasca jatuh tempo</Text>
                <Text style={styles.hint}>Pokok yang belum dicairkan setelah jatuh tempo tetap berbunga per bulan kalender penuh.</Text>
              </View>
              <Switch value={pascaAktif} onValueChange={setPascaAktif} />
            </View>
            {pascaAktif ? (
              <>
                <Text style={formUi.label}>Rate pasca jatuh tempo (% per tahun) *</Text>
                <FocusTextInput style={styles.input} value={rate} onChangeText={setRate} keyboardType="decimal-pad" placeholder="Wajib diisi sesuai keputusan koperasi" placeholderTextColor={colors.placeholder} />
                {rateAngka && rateAngka > 0 ? (
                  <Text style={styles.hint}>Contoh: pokok Rp10.000.000 → {formatRupiah(hitungBungaPascaJatuhTempoSatuPeriode(10_000_000, rateAngka))} per bulan.</Text>
                ) : null}
              </>
            ) : null}

            <View style={styles.tetap}>
              <BarisTetap label="Perpanjangan otomatis" nilai="Tidak" />
              <BarisTetap label="Bunga dikreditkan ke" nilai="Simpanan Sukarela" />
              <BarisTetap label="Kapitalisasi bunga ke pokok" nilai="Tidak" />
              <BarisTetap label="Basis rate · periode" nilai="Tahunan · bulan kalender" />
            </View>

            <Text style={formUi.label}>Dasar penetapan *</Text>
            <FocusTextInput style={styles.input} value={dasar} onChangeText={setDasar} placeholder="mis. Keputusan Pengurus No. 07/2026" placeholderTextColor={colors.placeholder} />
            <Text style={formUi.label}>Ditetapkan oleh *</Text>
            <FocusTextInput style={styles.input} value={oleh} onChangeText={setOleh} placeholder="mis. Rapat Pengurus" placeholderTextColor={colors.placeholder} />
            <Text style={formUi.label}>Tanggal penetapan *</Text>
            <DatePicker value={ditetapkanPada} onChange={setDitetapkanPada} />
            <Text style={formUi.label}>Catatan (opsional)</Text>
            <FocusTextInput style={[styles.input, { minHeight: 64 }]} multiline value={catatan} onChangeText={setCatatan} />
            <Text style={styles.hint}>Setelah disimpan, versi ini tidak dapat diubah. Perubahan berikutnya dibuat sebagai versi baru dan hanya berlaku untuk kontrak yang ditempatkan sejak tanggal berlakunya.</Text>
            <TouchableOpacity style={[styles.tombol, menyimpan && { opacity: 0.6 }]} onPress={simpan} disabled={menyimpan} accessibilityRole="button">
              {menyimpan ? <ActivityIndicator color={colors.white} /> : <Text style={styles.tombolTeks}>Simpan Kebijakan</Text>}
            </TouchableOpacity>
          </View>
        ) : null}

        {/* 3. Riwayat versi */}
        <Text style={styles.seksi}>Riwayat versi</Text>
        {daftar.length === 0 ? <Text style={styles.hint}>Belum ada versi.</Text> : null}
        {daftar.map((k) => (
          <View key={k.id} style={styles.kartu}>
            <View style={styles.barisAtas}>
              <Text style={[styles.teksTebal, k.status === 'DICABUT' && styles.coret]}>Versi {k.versi}</Text>
              <Text style={[styles.lencana, k.status === 'AKTIF' ? styles.lencanaAktif : styles.lencanaMati]}>{k.status === 'AKTIF' ? 'Aktif' : 'Dicabut'}</Text>
            </View>
            <Text style={styles.hint}>Berlaku mulai {tanggalPendek(k.berlakuMulai)}</Text>
            <Text style={styles.teks}>
              {k.bungaPascaJatuhTempoAktif && k.ratePascaJatuhTempo ? `Bunga pasca jatuh tempo ${formatPersen(k.ratePascaJatuhTempo)}/th` : 'Tanpa bunga pasca jatuh tempo'} · tanpa perpanjangan otomatis
            </Text>
            <Text style={styles.hint}>{k.dasarPenetapan}</Text>
            {k.alasanDicabut ? <Text style={styles.hint}>Dicabut: {k.alasanDicabut}</Text> : null}
            {bolehUbah && k.status === 'AKTIF' ? (
              <TouchableOpacity onPress={() => setCabut(k)} accessibilityRole="button">
                <Text style={styles.tautanBahaya}>Cabut (hanya bila belum dipakai kontrak)</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))}

        {/* 4. Kontrak lama */}
        <Text style={styles.seksi}>Kontrak lama perlu ditinjau ({legacy.length})</Text>
        {legacy.length === 0 ? <Text style={styles.hint}>Tidak ada kontrak lama yang menunggu keputusan.</Text> : null}
        <Text style={styles.hint}>
          Kontrak yang dibuat sebelum kebijakan produk tersedia tidak diberi bunga pasca jatuh tempo secara otomatis. Penerapan kebijakan
          dilakukan per kontrak, dicatat (siapa, kapan, versi, alasan), dan tidak berlaku surut.
        </Text>
        {legacy.map((k) => (
          <View key={k.id} style={styles.kartu}>
            <Text style={styles.teksTebal}>{k.nomorTransaksi} · {k.namaAnggota}</Text>
            <Text style={styles.hint}>
              {formatRupiah(k.nominal)} · jatuh tempo {tanggalPendek(k.tanggalJatuhTempo)} · {GAYA_STATUS_BERJANGKA[k.status as StatusSimpananBerjangka]?.arti ?? k.status}
            </Text>
            {bolehUbah && aktif.length > 0 ? (
              <TouchableOpacity onPress={() => { setTerapkan(k); setTerapkanPolicyId(berlakuHariIni?.id ?? aktif[0].id); }} accessibilityRole="button">
                <Text style={styles.tautan}>Terapkan kebijakan…</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
      </ScrollView>

      <Modal visible={!!cabut} transparent animationType="fade" onRequestClose={() => setCabut(null)}>
        <AreaAmanKeyboard varian="dialog" style={styles.latar}>
          <ScrollView contentContainerStyle={styles.dialog} keyboardShouldPersistTaps="handled">
            <Text style={styles.judulBesar}>Cabut versi {cabut?.versi}</Text>
            <Text style={styles.hint}>Versi yang sudah dipakai kontrak tidak dapat dicabut.</Text>
            <FocusTextInput style={styles.input} value={alasanCabut} onChangeText={setAlasanCabut} placeholder="Alasan pencabutan" placeholderTextColor={colors.placeholder} />
            <View style={styles.barisTombol}>
              <TouchableOpacity onPress={() => setCabut(null)}><Text style={styles.tautan}>Batal</Text></TouchableOpacity>
              <TouchableOpacity onPress={jalankanCabut}><Text style={styles.tautanBahaya}>Cabut</Text></TouchableOpacity>
            </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>

      <Modal visible={!!terapkan} transparent animationType="fade" onRequestClose={() => setTerapkan(null)}>
        <AreaAmanKeyboard varian="dialog" style={styles.latar}>
          <ScrollView contentContainerStyle={styles.dialog} keyboardShouldPersistTaps="handled">
            <Text style={styles.judulBesar}>Terapkan ke {terapkan?.nomorTransaksi}</Text>
            <Text style={formUi.label}>Versi kebijakan</Text>
            <View style={styles.chips}>
              {aktif.map((k) => (
                <TouchableOpacity key={k.id} style={[styles.chip, terapkanPolicyId === k.id && styles.chipAktif]} onPress={() => setTerapkanPolicyId(k.id)}>
                  <Text style={[styles.chipTeks, terapkanPolicyId === k.id && { color: colors.white }]}>{k.versi}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={formUi.label}>Tanggal efektif</Text>
            <DatePicker value={terapkanTanggal} onChange={setTerapkanTanggal} />
            <Text style={formUi.label}>Ditetapkan oleh</Text>
            <FocusTextInput style={styles.input} value={terapkanOleh} onChangeText={setTerapkanOleh} placeholder="mis. Rapat Pengurus" placeholderTextColor={colors.placeholder} />
            <Text style={formUi.label}>Alasan / dasar</Text>
            <FocusTextInput style={styles.input} value={terapkanAlasan} onChangeText={setTerapkanAlasan} placeholder="mis. Keputusan RAT 2026" placeholderTextColor={colors.placeholder} />
            <Text style={styles.hint}>Periode bunga pasca jatuh tempo yang dimulai sebelum tanggal efektif tidak dihitung.</Text>
            <View style={styles.barisTombol}>
              <TouchableOpacity onPress={() => setTerapkan(null)}><Text style={styles.tautan}>Batal</Text></TouchableOpacity>
              <TouchableOpacity onPress={jalankanTerapkan}><Text style={styles.tautan}>Terapkan</Text></TouchableOpacity>
            </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>
    </AreaAmanKeyboard>
  );
}

function PoinIntro({ teks }: { teks: string }) {
  return (
    <View style={styles.poin}>
      <Ionicons name="checkmark-circle" size={14} color={colors.primary} style={{ marginTop: 2 }} />
      <Text style={styles.poinTeks}>{teks}</Text>
    </View>
  );
}

function BarisTetap({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.barisTetap}>
      <Text style={styles.hint}>{label}</Text>
      <Text style={styles.teksTebal}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  layar: { flex: 1, backgroundColor: colors.background },
  tengah: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  kartu: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, marginBottom: spacing.md },
  kartuPeringatan: { borderColor: colors.warning, borderLeftWidth: 4 },
  kartuAktif: { borderColor: colors.primary, borderLeftWidth: 4 },
  intro: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: 14, marginBottom: spacing.md },
  introKepala: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  introJudul: { fontSize: 14, fontWeight: '800', color: colors.primary },
  introTeks: { fontSize: 13, color: colors.text, lineHeight: 19, marginBottom: 4 },
  poin: { flexDirection: 'row', gap: 6, marginTop: 4 },
  poinTeks: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  formJudul: { fontSize: 15, fontWeight: '800', color: colors.text },
  kecil: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  judulBesar: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 2, marginBottom: 4 },
  teks: { fontSize: 13, color: colors.text, lineHeight: 19 },
  teksTebal: { fontSize: 13, fontWeight: '700', color: colors.text },
  hint: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 3 },
  seksi: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: spacing.md, marginBottom: spacing.sm },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface, marginBottom: spacing.sm },
  barisSwitch: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginVertical: spacing.sm },
  tetap: { backgroundColor: colors.background, borderRadius: radius.sm, padding: 10, marginVertical: spacing.sm },
  barisTetap: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  tombol: { backgroundColor: colors.primary, borderRadius: radius.md, minHeight: 46, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  tombolTeks: { color: colors.white, fontWeight: '700', fontSize: 15 },
  tombolGaris: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, marginBottom: spacing.sm },
  tombolGarisTeks: { color: colors.primary, fontWeight: '700', fontSize: 14 },
  barisAtas: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lencana: { fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  lencanaAktif: { backgroundColor: colors.primaryLight, color: colors.primary },
  lencanaMati: { backgroundColor: colors.background, color: colors.textMuted },
  coret: { textDecorationLine: 'line-through', color: colors.textMuted },
  tautan: { color: colors.primary, fontWeight: '700', fontSize: 13, paddingVertical: 6 },
  tautanBahaya: { color: colors.danger, fontWeight: '700', fontSize: 13, paddingVertical: 6 },
  latar: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: spacing.lg },
  dialog: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg },
  barisTombol: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.lg, marginTop: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.primary, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipAktif: { backgroundColor: colors.primary },
  chipTeks: { color: colors.primary, fontWeight: '600', fontSize: 13 },
});
