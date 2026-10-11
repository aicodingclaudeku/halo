import React, { useCallback, useMemo, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { ScrollView, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import AppTextInput from '@/components/AppTextInput';
import { RekeningItem } from '@/services/KasBankService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { colors, radius, semantic, spacing, typography } from '@/theme/colors';
import { formatRupiah } from '@/utils/money';
import { getPeriodeLokalSekarang, getTanggalLokalHariIni } from '@/utils/tanggal';
import { getRingkasanPajak, SaldoAkunPajak, setorPajak } from '@/services/PajakService';
import {
  daftarMasa,
  KODE_UTANG_PPH_29,
  KODE_UTANG_PPH_BUNGA_SIMPANAN,
  KODE_UTANG_PPH_FINAL,
  labelMasa,
  normalisasiNtpn,
  validasiNtpn,
} from '@/config/pajakPolicy';
import { isiInfoPajak, KunciInfo } from './infoPajak';
import {
  Catatan,
  JudulSeksi,
  Kartu,
  LabelInfo,
  Lencana,
  Memuat,
  PemilihMasa,
  PesanGalat,
  PratinjauJurnal,
  TombolSimpan,
  pajakStyles as ps,
} from './PajakUi';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * RC-S87.2 — Setor Pajak (desain ulang UI/UX).
 *
 * Dapat dibuka dari hub Pajak MAUPUN dari menu Bayar Kewajiban (kartu
 * "Setor Pajak", atau saat utang pajak dipilih di "Kewajiban Lainnya").
 * Alur 3 langkah: ① pilih utang pajak → ② rincian setoran → ③ bukti setor
 * (NTPN), lalu ringkasan dan simpan.
 *
 * Jalur jurnal TIDAK berubah (RC-S84): `setorPajak()` → `bayarKewajibanCoa`
 * (Dr Utang PPh / Kr Kas-Bank; menolak setoran melebihi saldo utang).
 * Layar hanya menampilkan; validasi final tetap di service.
 */

type Golongan = { label: string; nada: 'netral' | 'sukses' | 'peringatan' };

function golonganAkun(kode: string): Golongan {
  if (kode === KODE_UTANG_PPH_BUNGA_SIMPANAN) return { label: 'Dipotong dari anggota', nada: 'peringatan' };
  if (kode === KODE_UTANG_PPH_FINAL || kode === KODE_UTANG_PPH_29) return { label: 'Pajak koperasi', nada: 'sukses' };
  return { label: 'Lainnya', nada: 'netral' };
}

export default function SetorPajakFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const prefill: { kodeAkun?: string; masa?: string } = route.params ?? {};
  const currentUser = useAppStore((s) => s.currentUser);
  const tahun = Number(getTanggalLokalHariIni().slice(0, 4));
  const info = useCallback((k: KunciInfo) => isiInfoPajak(k, tahun), [tahun]);

  const opsiMasa = useMemo(() => daftarMasa(getPeriodeLokalSekarang(), 12), []);
  const [akunList, setAkunList] = useState<SaldoAkunPajak[] | null>(null);
  const [akun, setAkun] = useState<SaldoAkunPajak | null>(null);
  const [masa, setMasa] = useState(prefill.masa && opsiMasa.includes(prefill.masa) ? prefill.masa : opsiMasa[1] ?? opsiMasa[0]);
  const [nominal, setNominal] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [ntpn, setNtpn] = useState('');
  const [catatan, setCatatan] = useState('');
  const [galat, setGalat] = useState<Record<string, string>>({});
  const [menyimpan, setMenyimpan] = useState(false);

  const pilih = (a: SaldoAkunPajak) => {
    setAkun(a);
    setNominal(a.saldo);
    setGalat((g) => ({ ...g, akun: '', nominal: '' }));
  };

  const muat = useCallback(async () => {
    const r = await getRingkasanPajak();
    const tersedia = r.utang.filter((u) => u.saldo > 0);
    setAkunList(tersedia);
    setAkun((lama) => {
      const cocok = tersedia.find((u) => u.accountId === lama?.accountId) ?? tersedia.find((u) => u.kode === prefill.kodeAkun) ?? (tersedia.length === 1 ? tersedia[0] : null);
      if (cocok && cocok.accountId !== lama?.accountId) setNominal(cocok.saldo);
      return cocok ?? null;
    });
  }, [prefill.kodeAkun]);
  useFocusRefresh(muat, [muat]);

  const nominalAngka = typeof nominal === 'number' ? nominal : 0;
  const melebihi = !!akun && nominalAngka > akun.saldo;
  const sisa = akun ? akun.saldo - nominalAngka : 0;
  const ntpnBersih = normalisasiNtpn(ntpn);
  const ntpnSalah = validasiNtpn(ntpn);
  const totalUtang = (akunList ?? []).reduce((t, a) => t + a.saldo, 0);
  const siapRingkasan = !!akun && nominalAngka > 0 && !melebihi && !!rekening;

  const validasi = (): boolean => {
    const e: Record<string, string> = {};
    if (!akun) e.akun = 'Pilih utang pajak yang disetor.';
    if (nominal === '' || nominal <= 0) e.nominal = 'Nominal setoran harus lebih dari 0.';
    else if (akun && nominal > akun.saldo) e.nominal = `Melebihi saldo utang (${formatRupiah(akun.saldo)}).`;
    if (!rekening) e.rekening = 'Pilih rekening pembayaran.';
    if (ntpnSalah) e.ntpn = ntpnSalah;
    setGalat(e);
    return Object.keys(e).length === 0;
  };

  const simpan = async () => {
    if (!validasi() || !akun || !rekening || !currentUser || nominal === '') return;
    setMenyimpan(true);
    try {
      await setorPajak({
        accountId: akun.accountId,
        masa,
        nominal,
        sumberDana: rekening.jenis === 'BANK' ? 'BANK' : 'KAS',
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        tanggal,
        ntpn,
        catatan,
        createdBy: currentUser.id,
      });
      notify(
        'Setoran tercatat',
        `${akun.jenis} masa ${labelMasa(masa)} sebesar ${formatRupiah(nominal)}.\nSisa utang: ${formatRupiah(akun.saldo - nominal)}.${ntpnBersih ? '' : '\nNTPN belum diisi — simpan bukti setornya.'}`,
        [
          { text: 'Lihat Riwayat', onPress: () => navigation.replace('RiwayatPajak') },
          { text: 'Selesai', onPress: () => navigation.goBack() },
        ]
      );
    } catch (e) {
      notify('Setoran gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpan(false);
    }
  };

  if (!akunList) return <Memuat />;

  if (akunList.length === 0) {
    return (
      <ScrollView {...PROP_SCROLL_FORM} style={ps.layar} contentContainerStyle={ps.isi}>
        <View style={st.kosong}>
          <View style={st.kosongIkon}>
            <Ionicons name="checkmark-done-outline" size={28} color={colors.success} />
          </View>
          <Text style={st.kosongJudul}>Tidak ada utang pajak</Text>
          <Text style={st.kosongTeks}>Semua pajak yang tercatat sudah disetor. Utang pajak baru muncul otomatis setelah PPh dihitung atau dipotong.</Text>
        </View>
        <TombolSimpan label="Lihat Riwayat Pajak" onPress={() => navigation.navigate('RiwayatPajak')} memproses={false} ikon="time-outline" />
      </ScrollView>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView style={ps.layar} contentContainerStyle={ps.isi} keyboardShouldPersistTaps="handled">
        {/* Ringkasan atas */}
        <View style={st.hero}>
          <View style={st.heroIkon}>
            <Ionicons name="receipt-outline" size={22} color={semantic.expenseIcon} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={st.heroKecil}>Utang pajak belum disetor</Text>
            <Text style={st.heroNilai}>{formatRupiah(totalUtang)}</Text>
            <Text style={st.heroSub}>{akunList.length} jenis · setor ke kas negara lalu catat NTPN-nya</Text>
          </View>
        </View>

        {/* ① Pilih utang pajak */}
        <JudulSeksi nomor={1} judul="Pilih utang pajak" sub="Satu jenis pajak per setoran, sesuai kode billing." info={info('jenisUtangPajak')} />
        <View accessibilityRole="radiogroup">
          {akunList.map((a) => {
            const aktif = akun?.accountId === a.accountId;
            const g = golonganAkun(a.kode);
            return (
              <TouchableOpacity
                key={a.accountId}
                style={[st.opsi, aktif && st.opsiAktif]}
                onPress={() => pilih(a)}
                accessibilityRole="radio"
                accessibilityState={{ selected: aktif }}
                accessibilityLabel={`${a.jenis}, saldo ${formatRupiah(a.saldo)}`}
                activeOpacity={0.8}
              >
                <Ionicons name={aktif ? 'radio-button-on' : 'radio-button-off'} size={22} color={aktif ? semantic.expenseIcon : colors.textFaint} />
                <View style={st.opsiTeks}>
                  <Text style={st.opsiJudul}>{a.jenis}</Text>
                  <Text style={st.opsiSub} numberOfLines={1}>
                    {a.kode} · {a.nama}
                  </Text>
                  <View style={{ marginTop: spacing.xs }}>
                    <Lencana teks={g.label} nada={g.nada} />
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={st.opsiKecil}>Saldo</Text>
                  <Text style={st.opsiNilai}>{formatRupiah(a.saldo)}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
        <PesanGalat teks={galat.akun} />

        {akun ? (
          <>
            {/* ② Rincian setoran */}
            <JudulSeksi nomor={2} judul="Rincian setoran" sub="Samakan dengan kode billing yang dibayar." />
            <Kartu>
              <PemilihMasa daftar={opsiMasa} nilai={masa} onChange={setMasa} label="Masa Pajak" />
              <View style={st.bantuan}>
                <LabelInfo label="Bulan pajak yang dilunasi, bukan tanggal bayar" info={info('masaSetor')} />
              </View>

              <View style={ps.field}>
                <View style={st.labelBarisAntara}>
                  <LabelInfo label="Nominal setoran *" info={info('setorSebagian')} />
                  {nominal !== akun.saldo ? (
                    <TouchableOpacity onPress={() => setNominal(akun.saldo)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button">
                      <Text style={st.tautan}>Setor penuh</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={st.chipPenuh}>Penuh</Text>
                  )}
                </View>
                <CurrencyInput value={nominal} onChangeValue={setNominal} error={galat.nominal || (melebihi ? `Melebihi saldo utang (${formatRupiah(akun.saldo)}).` : undefined)} />
                {!melebihi && nominalAngka > 0 ? (
                  <Text style={st.sisa}>
                    Sisa utang setelah setor: <Text style={st.sisaNilai}>{formatRupiah(sisa)}</Text>
                    {sisa === 0 ? '  · lunas' : ''}
                  </Text>
                ) : null}
              </View>

              <View style={ps.field}>
                <RekeningPicker label="Dibayar dari" value={rekening} onChange={setRekening} jenisDiizinkan={['KAS', 'BANK']} />
                <PesanGalat teks={galat.rekening} />
              </View>

              <View style={[ps.field, { marginBottom: 0 }]}>
                <Text style={ps.label}>Tanggal setor *</Text>
                <DatePicker value={tanggal} onChange={setTanggal} maximumDate={getWaktuSekarang()} />
              </View>
            </Kartu>

            {/* ③ Bukti setor */}
            <JudulSeksi nomor={3} judul="Bukti setor" sub="Dari Bukti Penerimaan Negara (BPN)." info={info('ntpn')} />
            <Kartu>
              <AppTextInput
                label="NTPN"
                inputType="code"
                autoCapitalize="characters"
                maxLength={19}
                placeholder="16 huruf/angka"
                value={ntpn}
                onChangeText={setNtpn}
                onBlur={() => setNtpn(normalisasiNtpn(ntpn))}
                error={galat.ntpn}
              />
              {ntpnBersih && !ntpnSalah ? (
                <View style={st.status}>
                  <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                  <Text style={[st.statusTeks, { color: colors.success }]}>Format NTPN valid</Text>
                </View>
              ) : !ntpnBersih ? (
                <View style={st.status}>
                  <Ionicons name="time-outline" size={16} color={colors.warning} />
                  <Text style={[st.statusTeks, { color: colors.warning }]}>Belum diisi — kosongkan hanya bila bukti setor belum terbit.</Text>
                </View>
              ) : null}
              <AppTextInput label="Catatan" inputType="multiline" multiline placeholder="Opsional, mis. nomor kode billing" value={catatan} onChangeText={setCatatan} />
            </Kartu>

            {/* Ringkasan */}
            {siapRingkasan && rekening ? (
              <View style={st.ringkasan}>
                <Text style={st.ringkasanJudul}>Ringkasan setoran</Text>
                <BarisR label="Jenis pajak" nilai={akun.jenis} />
                <BarisR label="Masa pajak" nilai={labelMasa(masa)} />
                <BarisR label="Saldo utang" nilai={formatRupiah(akun.saldo)} />
                <BarisR label="Disetor" nilai={formatRupiah(nominalAngka)} tebal />
                <BarisR label="Sisa utang" nilai={formatRupiah(sisa)} />
                <BarisR label="Dibayar dari" nilai={rekening.nama} />
                <BarisR label="Tanggal setor" nilai={tanggal} />
                <BarisR label="NTPN" nilai={ntpnBersih || 'Belum diisi'} />
              </View>
            ) : null}

            {akun && nominalAngka > 0 && !melebihi ? (
              <PratinjauJurnal
                baris={[
                  { akun: akun.nama, debit: nominalAngka, kredit: 0 },
                  { akun: rekening?.nama ?? 'Kas / Bank', debit: 0, kredit: nominalAngka },
                ]}
              />
            ) : null}

            <Catatan>Setoran ini memakai mesin Bayar Kewajiban yang sama dan otomatis tampil di Riwayat Pajak.</Catatan>

            <TombolSimpan label="Catat Setoran" onPress={simpan} memproses={menyimpan} nonaktif={!siapRingkasan} ikon="checkmark-done-outline" />
          </>
        ) : null}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function BarisR({ label, nilai, tebal }: { label: string; nilai: string; tebal?: boolean }) {
  return (
    <View style={st.rBaris}>
      <Text style={st.rLabel}>{label}</Text>
      <Text style={[st.rNilai, tebal && st.rTebal]} numberOfLines={2}>
        {nilai}
      </Text>
    </View>
  );
}

const st = StyleSheet.create({
  hero: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderLeftColor: semantic.expenseIcon,
    padding: spacing.lg,
  },
  heroIkon: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: semantic.expenseIconBackground, alignItems: 'center', justifyContent: 'center' },
  heroKecil: { fontSize: typography.caption, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  heroNilai: { fontSize: 22, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'], marginTop: 2 },
  heroSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },

  opsi: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  opsiAktif: { borderColor: semantic.expenseIcon, borderWidth: 1.5, backgroundColor: semantic.expenseIconBackground },
  opsiTeks: { flex: 1, minWidth: 0 },
  opsiJudul: { fontSize: typography.sectionTitle, fontWeight: '700', color: colors.text },
  opsiSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },
  opsiKecil: { fontSize: typography.caption, color: colors.textMuted },
  opsiNilai: { fontSize: typography.body, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },

  bantuan: { marginTop: -spacing.sm, marginBottom: spacing.md },
  labelBarisAntara: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  tautan: { fontSize: typography.subtitle, fontWeight: '700', color: semantic.expenseIcon },
  chipPenuh: { fontSize: typography.caption, fontWeight: '700', color: colors.textMuted },
  sisa: { fontSize: typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  sisaNilai: { fontWeight: '700', color: colors.text },

  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: -spacing.xs, marginBottom: spacing.md },
  statusTeks: { fontSize: typography.caption, fontWeight: '600', flexShrink: 1 },

  ringkasan: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  ringkasanJudul: { fontSize: typography.sectionTitle, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  rBaris: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 5 },
  rLabel: { fontSize: typography.subtitle, color: colors.textMuted },
  rNilai: { fontSize: typography.subtitle, color: colors.text, textAlign: 'right', flexShrink: 1, fontVariant: ['tabular-nums'] },
  rTebal: { fontWeight: '700' },

  kosong: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg },
  kosongIkon: { width: 56, height: 56, borderRadius: radius.pill, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  kosongJudul: { fontSize: typography.screenTitle, fontWeight: '700', color: colors.text },
  kosongTeks: { fontSize: typography.subtitle, color: colors.textMuted, textAlign: 'center', lineHeight: 19, marginTop: spacing.xs },
});
