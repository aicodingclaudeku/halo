import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Switch, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { colors, radius, spacing, typography } from '@/theme/colors';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  catatPphFinal,
  catatPphFinalOtomatis,
  getDaftarMasaPphFinal,
  getOmzetMasa,
  getRincianPphFinal,
  MasaPphFinal,
  OmzetAkun,
  RincianPphFinalMasa,
  StatusMasaPphFinal,
} from '@/services/PajakService';
import { KODE_UTANG_PPH_FINAL, labelMasa } from '@/config/pajakPolicy';
import { Catatan, JudulSeksi, Kartu, KartuRincian, Lencana, Memuat, PratinjauJurnal, TombolSimpan, pajakStyles as ps } from './PajakUi';

/**
 * RC-S87.3 — PPh Final UMKM 0,5% OTOMATIS.
 *
 * Aplikasi menghitung sendiri 12 masa terakhir dari buku besar dan
 * menandai masa yang perlu dicatat. Satu tombol mencatat semuanya
 * (`catatPphFinalOtomatis`, tiap masa lewat `catatPphFinal` existing).
 * Rincian tiap masa dari `getRincianPphFinal` — angka layar = angka jurnal,
 * layar tidak menghitung pajak. Pengecualian akun sekali pakai tetap ada
 * sebagai opsi lanjutan (fitur RC-S84 dipertahankan).
 */

const STATUS: Record<StatusMasaPphFinal, { teks: string; nada: 'netral' | 'sukses' | 'peringatan' }> = {
  DICATAT: { teks: 'Dicatat', nada: 'sukses' },
  PERLU_DICATAT: { teks: 'Perlu dicatat', nada: 'peringatan' },
  NIHIL: { teks: 'Nihil', nada: 'netral' },
  BERJALAN: { teks: 'Masa berjalan', nada: 'netral' },
  BUKAN_REZIM_FINAL: { teks: 'Bukan PPh Final', nada: 'netral' },
};

export default function PphFinalFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const hariIni = getTanggalLokalHariIni();

  const [daftar, setDaftar] = useState<MasaPphFinal[] | null>(null);
  const [masa, setMasa] = useState<string | null>(route.params?.masa ?? null);
  const [rincian, setRincian] = useState<RincianPphFinalMasa | null>(null);
  const [akun, setAkun] = useState<OmzetAkun[]>([]);
  const [kecuali, setKecuali] = useState<string[]>([]);
  const [lanjutan, setLanjutan] = useState(false);
  const [memproses, setMemproses] = useState(false);

  const muat = useCallback(async () => {
    try {
      const d = await getDaftarMasaPphFinal(hariIni);
      setDaftar(d);
      setMasa((m) => m ?? d.find((x) => x.status === 'PERLU_DICATAT')?.masa ?? d.find((x) => x.status !== 'BERJALAN')?.masa ?? d[0]?.masa ?? null);
    } catch (e) {
      setDaftar([]);
      notify('Gagal memuat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  }, [hariIni]);
  useFocusRefresh(muat, [muat]);

  useEffect(() => {
    setKecuali([]);
    setLanjutan(false);
  }, [masa]);

  useEffect(() => {
    if (!masa) return;
    let batal = false;
    setRincian(null);
    Promise.all([getRincianPphFinal(masa, kecuali), getOmzetMasa(masa)])
      .then(([r, a]) => {
        if (batal) return;
        setRincian(r);
        setAkun(a);
      })
      .catch((e) => notify('Gagal menghitung', e instanceof Error ? e.message : 'Terjadi kesalahan.'));
    return () => {
      batal = true;
    };
  }, [masa, kecuali]);

  const perlu = (daftar ?? []).filter((m) => m.status === 'PERLU_DICATAT');
  const totalPerlu = perlu.reduce((t, m) => t + m.pajak, 0);
  const dipilih = daftar?.find((m) => m.masa === masa) ?? null;

  const catatSemua = async () => {
    if (!currentUser) return;
    setMemproses(true);
    try {
      const h = await catatPphFinalOtomatis({ createdBy: currentUser.id, hariIni });
      const baris = h.dicatat.map((d) => `• ${labelMasa(d.masa)}: ${formatRupiah(d.nominal)}`).join('\n');
      const gagal = h.gagal.map((g) => `• ${labelMasa(g.masa)}: ${g.pesan}`).join('\n');
      notify(
        h.gagal.length ? 'Sebagian tercatat' : 'PPh Final tercatat',
        `${h.dicatat.length} masa dicatat otomatis.${baris ? `\n${baris}` : ''}${gagal ? `\n\nGagal:\n${gagal}` : ''}`,
        h.dicatat.length
          ? [
              { text: 'Nanti', style: 'cancel' as const },
              { text: 'Setor sekarang', onPress: () => navigation.navigate('SetorPajakForm', { kodeAkun: KODE_UTANG_PPH_FINAL }) },
            ]
          : undefined
      );
      await muat();
    } catch (e) {
      notify('Gagal mencatat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemproses(false);
    }
  };

  const catatSatu = async () => {
    if (!currentUser || !masa) return;
    setMemproses(true);
    try {
      const h = await catatPphFinal({ masa, akunDikecualikan: kecuali, createdBy: currentUser.id });
      notify('PPh Final tercatat', `${formatRupiah(h.nominal)} untuk masa ${labelMasa(masa)} (${h.nomorJurnal}).`, [
        { text: 'Nanti', style: 'cancel' },
        { text: 'Setor sekarang', onPress: () => navigation.navigate('SetorPajakForm', { kodeAkun: KODE_UTANG_PPH_FINAL, masa }) },
      ]);
      await muat();
    } catch (e) {
      notify('Gagal mencatat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemproses(false);
    }
  };

  if (!daftar) return <Memuat />;
  const semuaBukanFinal = daftar.length > 0 && daftar.every((m) => m.status === 'BUKAN_REZIM_FINAL');

  return (
    <ScrollView style={ps.layar} contentContainerStyle={ps.isi} keyboardShouldPersistTaps="handled">
      {semuaBukanFinal ? (
        <Catatan nada="galat">Koperasi tidak berada pada rezim PPh Final UMKM ({daftar[0].alasan}). Lihat Pengaturan Pajak.</Catatan>
      ) : null}

      {/* Ringkasan otomatis */}
      <View style={st.hero}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={st.heroKecil}>Dihitung otomatis dari buku besar</Text>
          <Text style={st.heroNilai}>{perlu.length > 0 ? formatRupiah(totalPerlu) : 'Semua masa beres'}</Text>
          <Text style={st.heroSub}>
            {perlu.length > 0 ? `${perlu.length} masa perlu dicatat${perlu.some((m) => m.terlambat) ? ' · ada yang lewat jatuh tempo' : ''}` : 'Tidak ada masa selesai yang belum dicatat.'}
          </Text>
        </View>
        <Ionicons name={perlu.length > 0 ? 'time-outline' : 'checkmark-done-circle-outline'} size={32} color={perlu.length > 0 ? colors.warning : colors.success} />
      </View>
      {perlu.length > 0 ? (
        <TombolSimpan label={`Catat Otomatis ${perlu.length} Masa`} onPress={catatSemua} memproses={memproses} ikon="flash-outline" />
      ) : null}

      {/* Daftar masa */}
      <JudulSeksi judul="Masa pajak" sub="Ketuk masa untuk melihat rincian perhitungannya." />
      <View style={st.daftar}>
        {daftar.map((m, i) => {
          const aktif = m.masa === masa;
          const s = STATUS[m.status];
          return (
            <TouchableOpacity
              key={m.masa}
              style={[st.baris, i > 0 && st.barisGaris, aktif && st.barisAktif]}
              onPress={() => setMasa(m.masa)}
              accessibilityRole="button"
              accessibilityState={{ selected: aktif }}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.barisJudul}>{m.label}</Text>
                <Text style={[st.barisSub, m.terlambat && { color: colors.danger }]}>
                  {m.status === 'DICATAT' ? m.nomorJurnal : m.status === 'PERLU_DICATAT' ? `Jatuh tempo ${m.jatuhTempo}${m.terlambat ? ' · terlambat' : ''}` : `Bruto ${formatRupiah(m.dasar)}`}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={st.barisNilai}>{m.status === 'BUKAN_REZIM_FINAL' ? '—' : formatRupiah(m.pajak)}</Text>
                <Lencana teks={s.teks} nada={s.nada} />
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Rincian masa terpilih */}
      {masa && dipilih ? (
        <>
          <JudulSeksi judul={`Rincian ${labelMasa(masa)}`} />
          {dipilih.status === 'BERJALAN' ? <Catatan nada="peringatan">Masa ini masih berjalan — angka dapat bertambah sampai akhir bulan.</Catatan> : null}
          {dipilih.status === 'BUKAN_REZIM_FINAL' ? <Catatan nada="galat">Tahun ini memakai {dipilih.alasan}; PPh Final tidak berlaku.</Catatan> : null}
          {!rincian ? <Memuat /> : <KartuRincian rincian={rincian} />}

          {rincian && dipilih.status !== 'DICATAT' && dipilih.status !== 'BUKAN_REZIM_FINAL' && akun.length > 0 ? (
            <>
              <TouchableOpacity style={st.lipat} onPress={() => setLanjutan((b) => !b)} accessibilityRole="button" accessibilityState={{ expanded: lanjutan }}>
                <Ionicons name="options-outline" size={16} color={colors.textMuted} />
                <Text style={st.lipatTeks}>Pengecualian sekali pakai (lanjutan)</Text>
                <Ionicons name={lanjutan ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
              </TouchableOpacity>
              {lanjutan ? (
                <Kartu>
                  <Catatan>Untuk pengecualian tetap, gunakan pengecualian terkonfigurasi (beralasan & tercatat). Opsi ini hanya berlaku untuk pencatatan masa ini.</Catatan>
                  {akun.map((a) => {
                    const off = kecuali.includes(a.accountId);
                    return (
                      <View key={a.accountId} style={st.akun}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[st.akunNama, off && st.coret]}>{a.nama}</Text>
                          <Text style={st.akunKode}>
                            {a.kode} · {formatRupiah(a.nilai)}
                          </Text>
                        </View>
                        <Switch
                          value={!off}
                          onValueChange={(v) => setKecuali((k) => (v ? k.filter((x) => x !== a.accountId) : [...k, a.accountId]))}
                          accessibilityLabel={`Ikutkan ${a.nama}`}
                        />
                      </View>
                    );
                  })}
                </Kartu>
              ) : null}
            </>
          ) : null}

          {rincian && dipilih.status === 'PERLU_DICATAT' && rincian.pajak > 0 ? (
            <>
              <PratinjauJurnal
                baris={[
                  { akun: 'Beban Pajak Penghasilan', debit: rincian.pajak, kredit: 0 },
                  { akun: 'Utang PPh Final', debit: 0, kredit: rincian.pajak },
                ]}
              />
              <TombolSimpan label={`Catat ${labelMasa(masa)}`} onPress={catatSatu} memproses={memproses} ikon="checkmark-done-outline" />
            </>
          ) : null}
          {dipilih.status === 'DICATAT' ? (
            <TombolSimpan label="Setor PPh Final" onPress={() => navigation.navigate('SetorPajakForm', { kodeAkun: KODE_UTANG_PPH_FINAL, masa })} memproses={false} ikon="card-outline" />
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  heroKecil: { fontSize: typography.caption, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  heroNilai: { fontSize: 22, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'], marginTop: 2 },
  heroSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },

  daftar: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  baris: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  barisGaris: { borderTopWidth: 1, borderTopColor: colors.border },
  barisAktif: { backgroundColor: colors.focusBg },
  barisJudul: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  barisSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },
  barisNilai: { fontSize: typography.body, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },

  lipat: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, marginBottom: spacing.sm },
  lipatTeks: { flex: 1, fontSize: typography.subtitle, fontWeight: '600', color: colors.textMuted },
  akun: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  akunNama: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  akunKode: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },
  coret: { textDecorationLine: 'line-through', color: colors.textFaint },
});
