import React, { useCallback, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AppTextInput from '@/components/AppTextInput';
import DatePicker from '@/components/DatePicker';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { colors, radius, spacing, typography } from '@/theme/colors';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { evaluasiRezimPajak, getPengaturanPajak, simpanPengaturanPajak, tetapkanOverrideRezim } from '@/services/PajakService';
import {
  ARTI_REZIM,
  HasilRezimPajak,
  LABEL_REZIM,
  LABEL_REZIM_SINGKAT,
  PengaturanPajak,
  RezimPajak,
  SkemaPajak,
  tahunAkhirFasilitasFinal,
  validasiPengaturanPajak,
} from '@/config/pajakPolicy';
import { isiInfoPajak, KunciInfo } from './infoPajak';
import { BilahBatas, Catatan, Kartu, LabelInfo, Memuat, Segmen, TombolInfo, TombolSimpan, pajakStyles as ps } from './PajakUi';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * RC-S87.5 — Pengaturan Pajak (versi SANGAT SEDERHANA).
 *
 * Yang terlihat hanya:
 *   (a) hasil: pajak apa yang berlaku, dalam satu kalimat;
 *   (b) DUA pertanyaan: memakai PPh Final UMKM? (Ya/Tidak) dan tahun
 *       terdaftar NPWP — lalu Simpan.
 * Alasan penetapan, angka penentu, versi kebijakan, dan penetapan manual
 * dilipat di "Detail untuk pengawas". Aturan RC-S87 tetap: operator tidak
 * memilih tarif; rezim dihitung `evaluasiRezimPajak`.
 */
export default function PengaturanPajakScreen() {
  const currentUser = useAppStore((s) => s.currentUser);
  const tahunPajak = Number(getTanggalLokalHariIni().slice(0, 4));
  const info = useCallback((k: KunciInfo) => isiInfoPajak(k, tahunPajak), [tahunPajak]);

  const [memuat, setMemuat] = useState(true);
  const [tersimpan, setTersimpan] = useState<PengaturanPajak | null>(null);
  const [skema, setSkema] = useState<SkemaPajak | null>(null);
  const [tahun, setTahun] = useState('');
  const [galat, setGalat] = useState<string | undefined>();
  const [menyimpan, setMenyimpan] = useState(false);
  const [rezim, setRezim] = useState<HasilRezimPajak | null>(null);
  const [mengapaBuka, setMengapaBuka] = useState(false);
  const [detailBuka, setDetailBuka] = useState(false);

  const [ovRezim, setOvRezim] = useState<RezimPajak | null>(null);
  const [ovAlasan, setOvAlasan] = useState('');
  const [ovNomor, setOvNomor] = useState('');
  const [ovTanggal, setOvTanggal] = useState(getTanggalLokalHariIni());
  const [ovMenyimpan, setOvMenyimpan] = useState(false);

  const muat = useCallback(async () => {
    try {
      const p = await getPengaturanPajak();
      setTersimpan(p);
      if (p) {
        setSkema(p.skema);
        setTahun(String(p.tahunTerdaftar));
      }
      setRezim(await evaluasiRezimPajak(tahunPajak));
    } catch (e) {
      notify('Gagal memuat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemuat(false);
    }
  }, [tahunPajak]);
  useFocusRefresh(muat, [muat]);

  const tahunAngka = /^\d{4}$/.test(tahun) ? Number(tahun) : NaN;
  const akhirFasilitas = Number.isInteger(tahunAngka) ? tahunAkhirFasilitasFinal(tahunAngka) : null;
  const berubah = !tersimpan || tersimpan.skema !== skema || String(tersimpan.tahunTerdaftar) !== tahun;

  const simpan = async () => {
    if (!currentUser) return;
    const salah = validasiPengaturanPajak({ skema: skema ?? '', tahunTerdaftar: tahunAngka }, tahunPajak);
    setGalat(salah ?? undefined);
    if (salah || !skema) return;
    setMenyimpan(true);
    try {
      await simpanPengaturanPajak({ skema, tahunTerdaftar: tahunAngka, updatedBy: currentUser.id });
      await muat();
      notify('Tersimpan', 'Jenis pajak koperasi sudah diperbarui.');
    } catch (e) {
      notify('Gagal menyimpan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpan(false);
    }
  };

  const simpanOverride = async () => {
    if (!currentUser || !ovRezim) return;
    setOvMenyimpan(true);
    try {
      await tetapkanOverrideRezim({ tahun: tahunPajak, rezim: ovRezim, alasan: ovAlasan, nomorDokumen: ovNomor, tanggalDokumen: ovTanggal, userId: currentUser.id });
      setOvAlasan('');
      setOvNomor('');
      setOvRezim(null);
      await muat();
      notify('Penetapan tercatat', `Tahun ${tahunPajak}: ${LABEL_REZIM[ovRezim]}.`);
    } catch (e) {
      notify('Gagal menyimpan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setOvMenyimpan(false);
    }
  };

  if (memuat) return <Memuat />;

  const r = rezim?.rezim ?? null;
  const p = rezim?.parameter;

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView style={ps.layar} contentContainerStyle={ps.isi} keyboardShouldPersistTaps="handled">
        {/* ---------- Hasil ---------- */}
        <View style={st.hasil}>
          <View style={st.baris}>
            <Text style={st.kecil}>Pajak koperasi tahun {tahunPajak}</Text>
            <TombolInfo isi={info('rezim')} />
          </View>
          <View style={st.baris}>
            <Text style={st.besar}>{r ? LABEL_REZIM_SINGKAT[r] : 'Belum diatur'}</Text>
            {r ? <TombolInfo isi={info(r)} /> : null}
          </View>
          <Text style={st.arti}>{r ? ARTI_REZIM[r] : 'Jawab dua pertanyaan di bawah, lalu simpan.'}</Text>

          {rezim && r ? (
            <>
              <TouchableOpacity style={st.mengapa} onPress={() => setMengapaBuka((b) => !b)} accessibilityRole="button" accessibilityState={{ expanded: mengapaBuka }}>
                <Ionicons name={rezim.sumber === 'OVERRIDE' ? 'document-lock-outline' : 'checkmark-circle'} size={16} color={rezim.sumber === 'OVERRIDE' ? colors.warning : colors.success} />
                <Text style={st.mengapaTeks}>{rezim.sumber === 'OVERRIDE' ? 'Ditetapkan manual' : 'Ditentukan otomatis'}</Text>
                <Text style={st.tautan}>{mengapaBuka ? 'Tutup' : 'Mengapa?'}</Text>
              </TouchableOpacity>
              {mengapaBuka ? (
                <View style={{ marginTop: spacing.sm }}>
                  {rezim.alasan.map((a, i) => (
                    <Text key={i} style={st.alasan}>
                      • {a}
                    </Text>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
        </View>
        {rezim?.peringatan.slice(0, 1).map((w) => (
          <Catatan key={w} nada="peringatan">
            {w}
          </Catatan>
        ))}

        {/* ---------- Dua pertanyaan ---------- */}
        <Kartu>
          <View style={st.tanya}>
            <View style={st.baris}>
              <Text style={st.nomor}>1</Text>
              <Text style={st.tanyaTeks}>Apakah koperasi memakai PPh Final UMKM?</Text>
              <TombolInfo isi={info('deklarasi')} />
            </View>
            <Segmen<SkemaPajak>
              opsi={[
                { nilai: 'FINAL_UMKM', label: 'Ya' },
                { nilai: 'UMUM', label: 'Tidak' },
              ]}
              nilai={skema}
              onChange={setSkema}
            />
            <Text style={ps.hint}>
              {skema === 'FINAL_UMKM'
                ? 'Aplikasi otomatis pindah ke PPh Badan bila syaratnya tidak lagi terpenuhi.'
                : skema === 'UMUM'
                ? 'Pajak dihitung dari laba setahun (PPh Badan).'
                : 'Bila ragu, tanyakan ke konsultan pajak koperasi.'}
            </Text>
          </View>

          <View style={st.tanya}>
            <View style={st.baris}>
              <Text style={st.nomor}>2</Text>
              <Text style={st.tanyaTeks}>Tahun terdaftar NPWP koperasi</Text>
              <TombolInfo isi={info('tahunTerdaftar')} />
            </View>
            <AppTextInput
              inputType="number"
              keyboardType="number-pad"
              maxLength={4}
              placeholder={String(tahunPajak)}
              value={tahun}
              onChangeText={(t) => setTahun(t.replace(/\D/g, ''))}
              hint={skema === 'FINAL_UMKM' && akhirFasilitas !== null ? `PPh Final boleh dipakai sampai tahun ${akhirFasilitas}.` : 'Lihat kartu/surat keterangan terdaftar NPWP.'}
              error={galat}
            />
          </View>

          <TombolSimpan label="Simpan" onPress={simpan} memproses={menyimpan} nonaktif={!berubah} />
        </Kartu>

        {/* ---------- Detail untuk pengawas ---------- */}
        <TouchableOpacity style={st.lipat} onPress={() => setDetailBuka((b) => !b)} accessibilityRole="button" accessibilityState={{ expanded: detailBuka }} activeOpacity={0.7}>
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.textMuted} />
          <Text style={st.lipatTeks}>Detail untuk pengawas</Text>
          <Ionicons name={detailBuka ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
        </TouchableOpacity>

        {detailBuka && p && r ? (
          <>
            <Kartu judul="Angka penentu">
              <View style={st.baris}>
                <LabelInfo label="Dari mana angka omzet?" info={info('peredaranBruto')} />
              </View>
              {p.skemaDeklarasi === 'FINAL_UMKM' ? (
                <>
                  <BilahBatas label={`Omzet ${tahunPajak - 1}`} nilai={p.omzetTahunSebelumnya} batas={p.batasOmzetFinal} info={info('batasFinal')} catatan="menentukan tahun ini" />
                  <BilahBatas label={`Omzet ${tahunPajak} (berjalan)`} nilai={p.omzetTahunBerjalan} batas={p.batasOmzetFinal} info={info('batasFinal')} catatan="menentukan tahun depan" />
                </>
              ) : null}
              {r !== 'FINAL_UMKM' ? <BilahBatas label={`Omzet ${tahunPajak} untuk Pasal 31E`} nilai={p.omzetTahunBerjalan} batas={p.batasPeredaranBrutoPenerima31E} info={info('batas31E')} /> : null}
              {rezim?.tahunAkhirFasilitasFinal && p.skemaDeklarasi === 'FINAL_UMKM' ? (
                <View style={[st.baris, st.barisAntara]}>
                  <LabelInfo label="Masa fasilitas PPh Final" info={info('masaFasilitas')} />
                  <Text style={st.nilai}>s.d. {rezim.tahunAkhirFasilitasFinal}</Text>
                </View>
              ) : null}
              <View style={[st.baris, st.barisAntara]}>
                <LabelInfo label="Cara penetapan" info={info('penetapan')} />
                <Text style={st.nilai}>{rezim?.sumber === 'OVERRIDE' ? 'Manual' : 'Otomatis'}</Text>
              </View>
              <View style={[st.baris, st.barisAntara]}>
                <LabelInfo label="Versi kebijakan" info={info('versiKebijakan')} />
                <Text style={st.nilai}>{p.versiKebijakan}</Text>
              </View>
              <Text style={st.nama}>{LABEL_REZIM[r]}</Text>
            </Kartu>

            <Kartu judul="Penetapan manual (pengecualian)" aksi={<TombolInfo isi={info('penetapanManual')} />}>
              <Catatan nada="peringatan">Hanya bila ada surat/keputusan pajak resmi. Tercatat dengan nama pengguna dan waktu.</Catatan>
              <View style={ps.field}>
                <Text style={ps.label}>Jenis pajak tahun {tahunPajak} *</Text>
                <Segmen<RezimPajak>
                  opsi={[
                    { nilai: 'FINAL_UMKM', label: 'Final 0,5%' },
                    { nilai: 'BADAN_31E', label: 'Pasal 31E' },
                    { nilai: 'BADAN_UMUM', label: 'Tarif 22%' },
                  ]}
                  nilai={ovRezim}
                  onChange={setOvRezim}
                />
              </View>
              <AppTextInput label="Alasan" required inputType="multiline" multiline value={ovAlasan} onChangeText={setOvAlasan} />
              <AppTextInput label="Nomor dokumen" required value={ovNomor} onChangeText={setOvNomor} />
              <View style={ps.field}>
                <Text style={ps.label}>Tanggal dokumen *</Text>
                <DatePicker value={ovTanggal} onChange={setOvTanggal} maximumDate={getWaktuSekarang()} />
              </View>
              <TombolSimpan label="Tetapkan" onPress={simpanOverride} memproses={ovMenyimpan} nonaktif={!ovRezim || !ovAlasan.trim() || !ovNomor.trim()} ikon="document-lock-outline" />
            </Kartu>
          </>
        ) : null}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const st = StyleSheet.create({
  hasil: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  baris: { flexDirection: 'row', alignItems: 'center' },
  barisAntara: { justifyContent: 'space-between', paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  kecil: { fontSize: typography.caption, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  besar: { fontSize: 20, fontWeight: '700', color: colors.text, marginTop: spacing.xs, flexShrink: 1 },
  arti: { fontSize: typography.body, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 20 },
  mengapa: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.md },
  mengapaTeks: { flex: 1, fontSize: typography.subtitle, color: colors.text, fontWeight: '600' },
  tautan: { fontSize: typography.subtitle, fontWeight: '700', color: colors.primary },
  alasan: { fontSize: typography.subtitle, color: colors.text, lineHeight: 19, marginBottom: 4 },

  tanya: { marginBottom: spacing.md },
  nomor: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    color: colors.white,
    textAlign: 'center',
    lineHeight: 22,
    fontSize: typography.caption,
    fontWeight: '700',
    marginRight: spacing.sm,
    overflow: 'hidden',
  },
  tanyaTeks: { fontSize: typography.body, fontWeight: '700', color: colors.text, flexShrink: 1, marginBottom: spacing.sm, marginTop: spacing.sm },

  lipat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  lipatTeks: { flex: 1, fontSize: typography.body, fontWeight: '600', color: colors.textMuted },
  nilai: { fontSize: typography.subtitle, fontWeight: '700', color: colors.text },
  nama: { fontSize: typography.caption, color: colors.textMuted, marginTop: spacing.sm },
});
