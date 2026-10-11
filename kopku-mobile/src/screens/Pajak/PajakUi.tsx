import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, FlatList, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, semantic, spacing, typography, iconSize, elevation, touchTarget } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';
import { formatRupiah, Rupiah } from '@/utils/money';
import { labelMasa } from '@/config/pajakPolicy';
import type { LangkahPerhitungan, RincianPerhitungan } from '@/config/pajakPolicy';
import type { IsiInfo } from './infoPajak';

/**
 * RC-S84 — BAHASA VISUAL MENU PAJAK.
 *
 * Tidak ada token warna baru. Semua nilai dari theme/colors, theme/form,
 * theme/ui. Menu Pajak adalah bagian Pengeluaran, jadi aksen ikonnya
 * memakai merah Pengeluaran (`semantic.expenseIcon`) — sama dengan
 * seluruh sub-menu Pengeluaran lain (RC-S70.1).
 *
 * Komponen di sini MURNI PRESENTASI: tidak memanggil service, tidak
 * menghitung pajak. Angka yang ditampilkan datang dari pemanggil.
 */

// ---------------------------------------------------------------------------
// Blok kartu dengan judul
// ---------------------------------------------------------------------------

export function Kartu({ judul, children, aksi }: { judul?: string; children: React.ReactNode; aksi?: React.ReactNode }) {
  return (
    <View style={s.kartu}>
      {judul ? (
        <View style={s.kartuHeader}>
          <Text style={s.kartuJudul}>{judul}</Text>
          {aksi}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function LabelGrup({ children }: { children: string }) {
  return (
    <Text style={s.labelGrup} accessibilityRole="header">
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Baris nilai (label kiri, nominal kanan)
// ---------------------------------------------------------------------------

export function BarisNilai({ label, nilai, tebal, redam, garisAtas }: { label: string; nilai: string; tebal?: boolean; redam?: boolean; garisAtas?: boolean }) {
  return (
    <View style={[s.baris, garisAtas && s.barisGaris]}>
      <Text style={[s.barisLabel, redam && s.teksRedam, tebal && s.teksTebal]} numberOfLines={2}>
        {label}
      </Text>
      <Text style={[s.barisNilai, redam && s.teksRedam, tebal && s.teksTebal]}>{nilai}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Catatan (info netral / peringatan / galat)
// ---------------------------------------------------------------------------

type NadaCatatan = 'info' | 'peringatan' | 'galat' | 'sukses';

const NADA: Record<NadaCatatan, { ikon: keyof typeof Ionicons.glyphMap; warna: string; latar: string; garis: string }> = {
  info: { ikon: 'information-circle-outline', warna: colors.textMuted, latar: colors.surface, garis: colors.border },
  peringatan: { ikon: 'alert-circle-outline', warna: colors.warning, latar: colors.warningBg, garis: colors.warningBorder },
  galat: { ikon: 'close-circle-outline', warna: colors.danger, latar: colors.dangerBg, garis: colors.dangerBg },
  sukses: { ikon: 'checkmark-circle-outline', warna: colors.success, latar: colors.primaryLight, garis: colors.primaryLight },
};

export function Catatan({ nada = 'info', children }: { nada?: NadaCatatan; children: React.ReactNode }) {
  const n = NADA[nada];
  return (
    <View style={[s.catatan, { backgroundColor: n.latar, borderColor: n.garis }]}>
      <Ionicons name={n.ikon} size={iconSize.md} color={n.warna} style={s.catatanIkon} />
      <Text style={s.catatanTeks}>{children}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pilihan segmen (2–3 opsi)
// ---------------------------------------------------------------------------

export function Segmen<T extends string>({ opsi, nilai, onChange }: { opsi: { nilai: T; label: string }[]; nilai: T | null; onChange: (v: T) => void }) {
  return (
    <View style={s.segmen} accessibilityRole="radiogroup">
      {opsi.map((o) => {
        const aktif = o.nilai === nilai;
        return (
          <TouchableOpacity
            key={o.nilai}
            accessibilityRole="radio"
            accessibilityState={{ selected: aktif }}
            style={[s.segmenItem, aktif && s.segmenAktif]}
            onPress={() => onChange(o.nilai)}
            activeOpacity={0.7}
          >
            <Text style={[s.segmenTeks, aktif && s.segmenTeksAktif]} numberOfLines={1}>
              {o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pemilih masa pajak (select + modal)
// ---------------------------------------------------------------------------

export function PemilihMasa({ daftar, nilai, onChange, label = 'Masa Pajak' }: { daftar: string[]; nilai: string; onChange: (m: string) => void; label?: string }) {
  const [buka, setBuka] = useState(false);
  return (
    <View style={formUi.field}>
      <Text style={formUi.label}>{label} *</Text>
      <TouchableOpacity style={s.selector} onPress={() => setBuka(true)} accessibilityRole="button" accessibilityLabel={`${label}: ${labelMasa(nilai)}`}>
        <Ionicons name="calendar-outline" size={18} color={colors.textMuted} style={formUi.inputIcon} />
        <Text style={s.selectorTeks}>{labelMasa(nilai)}</Text>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </TouchableOpacity>
      <Modal visible={buka} animationType="slide" onRequestClose={() => setBuka(false)}>
        <SafeAreaView style={s.modal} edges={['top', 'bottom']}>
          <View style={s.modalHeader}>
            <Text style={modalUi.title}>Pilih {label}</Text>
            <TouchableOpacity style={modalUi.closeIcon} onPress={() => setBuka(false)} accessibilityLabel="Tutup">
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <FlatList
            keyboardShouldPersistTaps="handled"
            data={daftar}
            keyExtractor={(m) => m}
            contentContainerStyle={{ padding: spacing.lg }}
            renderItem={({ item }) => {
              const aktif = item === nilai;
              return (
                <TouchableOpacity
                  style={[s.opsiBaris, aktif && s.opsiAktif]}
                  onPress={() => {
                    onChange(item);
                    setBuka(false);
                  }}
                >
                  <Text style={s.opsiTeks}>{labelMasa(item)}</Text>
                  {aktif && <Ionicons name="checkmark-circle" size={20} color={semantic.expenseIcon} />}
                </TouchableOpacity>
              );
            }}
          />
        </SafeAreaView>
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pratinjau jurnal
// ---------------------------------------------------------------------------

export interface BarisJurnal {
  akun: string;
  debit: Rupiah;
  kredit: Rupiah;
}

/**
 * Menunjukkan jurnal yang AKAN dibuat sebelum pengguna menekan simpan.
 * Membantu bendahara memeriksa akun tanpa membuka Buku Besar.
 */
export function PratinjauJurnal({ baris }: { baris: BarisJurnal[] }) {
  if (baris.length === 0) return null;
  return (
    <Kartu judul="Jurnal yang akan dibuat">
      {baris.map((b, i) => (
        <View key={`${b.akun}-${i}`} style={[s.jurnalBaris, i > 0 && s.barisGaris]}>
          <Text style={[s.jurnalAkun, b.kredit > 0 && s.jurnalAkunKredit]} numberOfLines={2}>
            {b.akun}
          </Text>
          <Text style={s.jurnalSisi}>{b.debit > 0 ? 'Debit' : 'Kredit'}</Text>
          <Text style={s.jurnalNilai}>{formatRupiah(b.debit > 0 ? b.debit : b.kredit)}</Text>
        </View>
      ))}
    </Kartu>
  );
}

// ---------------------------------------------------------------------------
// Tombol simpan
// ---------------------------------------------------------------------------

export function TombolSimpan({ label, onPress, memproses, nonaktif, ikon = 'save-outline' }: { label: string; onPress: () => void; memproses: boolean; nonaktif?: boolean; ikon?: keyof typeof Ionicons.glyphMap }) {
  const mati = memproses || !!nonaktif;
  return (
    <TouchableOpacity
      style={[s.tombol, mati && s.tombolMati]}
      onPress={onPress}
      disabled={mati}
      accessibilityRole="button"
      accessibilityState={{ disabled: mati, busy: memproses }}
    >
      {memproses ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <>
          <Ionicons name={ikon} size={18} color={colors.white} />
          <Text style={s.tombolTeks}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

export function Memuat() {
  return (
    <View style={s.memuat}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export function PesanGalat({ teks }: { teks?: string }) {
  if (!teks) return null;
  return (
    <View style={formUi.errorRow}>
      <Ionicons name="alert-circle" size={14} color={colors.danger} />
      <Text style={formUi.errorText}>{teks}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Gaya
// ---------------------------------------------------------------------------

export const pajakStyles = StyleSheet.create({
  layar: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xxl },
  intro: { fontSize: typography.subtitle, lineHeight: 18, color: colors.textMuted, marginBottom: spacing.lg },
  field: { ...formUi.field },
  label: { ...formUi.label },
  hint: { ...formUi.hint },
});

const s = StyleSheet.create({
  kartu: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  kartuHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  kartuJudul: { fontSize: typography.body, fontWeight: '700', color: colors.text },
  labelGrup: { ...formUi.groupLabel, marginTop: spacing.md },

  baris: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 6 },
  barisGaris: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.xs, paddingTop: spacing.sm },
  barisLabel: { flex: 1, minWidth: 0, fontSize: typography.body, color: colors.text },
  barisNilai: { fontSize: typography.body, color: colors.text, fontVariant: ['tabular-nums'] },
  teksRedam: { color: colors.textMuted },
  teksTebal: { fontWeight: '700' },

  catatan: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, borderWidth: 1, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  catatanIkon: { marginTop: 1, flexShrink: 0 },
  catatanTeks: { flex: 1, minWidth: 0, fontSize: typography.caption, lineHeight: 17, color: colors.text },

  segmen: { flexDirection: 'row', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 3, gap: 3 },
  segmenItem: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm - 2, paddingHorizontal: spacing.sm },
  segmenAktif: { backgroundColor: colors.surface, ...elevation.card },
  segmenTeks: { fontSize: typography.subtitle, color: colors.textMuted, fontWeight: '600' },
  segmenTeksAktif: { color: colors.text },

  selector: { ...formUi.inputWrap },
  selectorTeks: { flex: 1, fontSize: 15, color: colors.text, fontWeight: '600' },
  modal: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  opsiBaris: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingHorizontal: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  opsiAktif: { backgroundColor: colors.primaryLight, borderRadius: radius.sm, borderBottomColor: 'transparent' },
  opsiTeks: { fontSize: 15, fontWeight: '600', color: colors.text },

  jurnalBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  jurnalAkun: { flex: 1, minWidth: 0, fontSize: typography.subtitle, color: colors.text },
  jurnalAkunKredit: { paddingLeft: spacing.lg },
  jurnalSisi: { width: 52, fontSize: typography.caption, color: colors.textMuted },
  jurnalNilai: { fontSize: typography.subtitle, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },

  tombol: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  tombolMati: { opacity: 0.6 },
  tombolTeks: { color: colors.white, fontWeight: '700', fontSize: 15 },
  memuat: { paddingVertical: spacing.xl, alignItems: 'center' },
});

// ---------------------------------------------------------------------------
// RC-S87.1 — Penjelasan kontekstual (ikon tanda seru -> lembar info)
// ---------------------------------------------------------------------------

/**
 * Ikon tanda seru kecil di samping judul/angka. Ditekan -> lembar
 * penjelasan dari bawah layar. Area sentuh diperluas (hitSlop) supaya
 * mudah ditekan walau ikonnya kecil.
 */
export function TombolInfo({ isi }: { isi: IsiInfo }) {
  const [buka, setBuka] = useState(false);
  return (
    <>
      <TouchableOpacity
        onPress={() => setBuka(true)}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel={`Penjelasan: ${isi.judul}`}
        style={si.tombolInfo}
      >
        <Ionicons name="alert-circle-outline" size={18} color={colors.primary} />
      </TouchableOpacity>
      <LembarInfo isi={isi} buka={buka} onTutup={() => setBuka(false)} />
    </>
  );
}

export function LembarInfo({ isi, buka, onTutup }: { isi: IsiInfo; buka: boolean; onTutup: () => void }) {
  return (
    <Modal visible={buka} transparent animationType="slide" onRequestClose={onTutup} statusBarTranslucent>
      <View style={si.lembarBackdrop}>
        <Pressable style={si.lembarLuar} onPress={onTutup} accessibilityLabel="Tutup penjelasan" />
        <SafeAreaView edges={['bottom']} style={si.lembar}>
          <View style={si.pegangan} />
          <View style={modalUi.headerRow}>
            <View style={si.lembarJudulBaris}>
              <View style={si.lembarIkon}>
                <Ionicons name="alert-circle" size={20} color={colors.primary} />
              </View>
              <Text style={modalUi.title}>{isi.judul}</Text>
            </View>
            <TouchableOpacity style={modalUi.closeIcon} onPress={onTutup} accessibilityLabel="Tutup">
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={si.lembarIsi} contentContainerStyle={{ paddingBottom: spacing.md }}>
            <Text style={si.ringkas}>{isi.ringkas}</Text>
            {isi.poin?.map((p, i) => (
              <View key={i} style={si.poin}>
                <View style={si.titik} />
                <Text style={si.poinTeks}>{p}</Text>
              </View>
            ))}
            {isi.contoh ? (
              <View style={si.contoh}>
                <Text style={si.contohJudul}>{isi.contoh.judul}</Text>
                {isi.contoh.baris.map((b, i) => (
                  <View key={i} style={[si.contohBaris, b.tebal && si.contohTotal]}>
                    <Text style={[si.contohLabel, b.tebal && s.teksTebal]}>{b.label}</Text>
                    <Text style={[si.contohNilai, b.tebal && s.teksTebal]}>{b.nilai}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            {isi.dasar ? (
              <View style={si.dasar}>
                <Ionicons name="book-outline" size={14} color={colors.textMuted} />
                <Text style={si.dasarTeks}>Dasar: {isi.dasar}</Text>
              </View>
            ) : null}
          </ScrollView>
          <View style={modalUi.actions}>
            <TouchableOpacity style={modalUi.primaryButton} onPress={onTutup} accessibilityRole="button">
              <Text style={modalUi.primaryText}>Mengerti</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/** Judul seksi bernomor (alur langkah) dengan ikon info opsional. */
export function JudulSeksi({ nomor, judul, sub, info }: { nomor?: number; judul: string; sub?: string; info?: IsiInfo }) {
  return (
    <View style={si.seksi}>
      <View style={si.seksiBaris}>
        {nomor !== undefined ? (
          <View style={si.nomor}>
            <Text style={si.nomorTeks}>{nomor}</Text>
          </View>
        ) : null}
        <Text style={si.seksiJudul} accessibilityRole="header">
          {judul}
        </Text>
        {info ? <TombolInfo isi={info} /> : null}
      </View>
      {sub ? <Text style={si.seksiSub}>{sub}</Text> : null}
    </View>
  );
}

/** Label kecil + ikon info (untuk baris angka). */
export function LabelInfo({ label, info }: { label: string; info?: IsiInfo }) {
  return (
    <View style={si.labelInfo}>
      <Text style={si.labelInfoTeks}>{label}</Text>
      {info ? <TombolInfo isi={info} /> : null}
    </View>
  );
}

/**
 * Bilah perbandingan nilai terhadap batas. Hijau < 80%, kuning 80–100%,
 * merah > 100%. Teks selalu menyertakan angka — warna bukan satu-satunya
 * penanda.
 */
export function BilahBatas({ label, nilai, batas, info, catatan }: { label: string; nilai: Rupiah; batas: Rupiah; info?: IsiInfo; catatan?: string }) {
  const rasio = batas > 0 ? nilai / batas : 0;
  const warna = rasio > 1 ? colors.danger : rasio >= 0.8 ? colors.warning : colors.primary;
  const persen = Math.round(rasio * 100);
  return (
    <View style={si.bilah}>
      <LabelInfo label={label} info={info} />
      <View style={si.bilahAngka}>
        <Text style={si.bilahNilai}>{formatRupiah(nilai)}</Text>
        <Text style={si.bilahBatas}>dari {formatRupiah(batas)}</Text>
      </View>
      <View style={si.bilahJalur} accessibilityLabel={`${label}: ${persen} persen dari batas`}>
        <View style={[si.bilahIsi, { width: `${Math.min(100, Math.max(rasio > 0 ? 2 : 0, rasio * 100))}%`, backgroundColor: warna }]} />
      </View>
      <Text style={[si.bilahKet, { color: warna }]}>
        {rasio > 1 ? `Melewati batas (${persen}%)` : `${persen}% dari batas`}
        {catatan ? ` · ${catatan}` : ''}
      </Text>
    </View>
  );
}

/** Kartu pilihan (radio) dengan judul & deskripsi — pengganti segmen untuk pilihan yang perlu dijelaskan. */
export function KartuPilihan<T extends string>({
  opsi,
  nilai,
  onChange,
}: {
  opsi: { nilai: T; judul: string; deskripsi: string; ikon: keyof typeof Ionicons.glyphMap }[];
  nilai: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <View style={{ gap: spacing.sm }} accessibilityRole="radiogroup">
      {opsi.map((o) => {
        const aktif = o.nilai === nilai;
        return (
          <TouchableOpacity
            key={o.nilai}
            style={[si.pilihan, aktif && si.pilihanAktif]}
            onPress={() => onChange(o.nilai)}
            accessibilityRole="radio"
            accessibilityState={{ selected: aktif }}
            activeOpacity={0.8}
          >
            <View style={[si.pilihanIkon, aktif && si.pilihanIkonAktif]}>
              <Ionicons name={o.ikon} size={20} color={aktif ? colors.white : colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={si.pilihanJudul}>{o.judul}</Text>
              <Text style={si.pilihanDesk}>{o.deskripsi}</Text>
            </View>
            <Ionicons name={aktif ? 'radio-button-on' : 'radio-button-off'} size={22} color={aktif ? colors.primary : colors.textFaint} />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** Lencana status kecil. */
export function Lencana({ teks, nada = 'netral' }: { teks: string; nada?: 'netral' | 'sukses' | 'peringatan' }) {
  const gaya = nada === 'sukses' ? si.lencanaSukses : nada === 'peringatan' ? si.lencanaPeringatan : si.lencanaNetral;
  const warna = nada === 'sukses' ? colors.primary : nada === 'peringatan' ? colors.warning : colors.textMuted;
  return (
    <View style={[si.lencana, gaya]}>
      <Text style={[si.lencanaTeks, { color: warna }]}>{teks}</Text>
    </View>
  );
}

const si = StyleSheet.create({
  tombolInfo: { marginLeft: spacing.xs, padding: 2 },

  lembarBackdrop: { ...modalUi.backdrop, justifyContent: 'flex-end' },
  lembarLuar: { flex: 1 },
  lembar: { ...modalUi.sheet, paddingTop: spacing.sm },
  pegangan: { alignSelf: 'center', width: 40, height: 4, borderRadius: radius.pill, backgroundColor: colors.border, marginBottom: spacing.md },
  lembarJudulBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1, minWidth: 0 },
  lembarIkon: { width: 32, height: 32, borderRadius: radius.pill, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  lembarIsi: { marginTop: spacing.md },
  ringkas: { fontSize: typography.body, lineHeight: 21, color: colors.text, marginBottom: spacing.md },
  poin: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm, paddingRight: spacing.sm },
  titik: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary, marginTop: 7 },
  poinTeks: { flex: 1, fontSize: typography.subtitle, lineHeight: 20, color: colors.text },
  contoh: { marginTop: spacing.sm, backgroundColor: colors.background, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  contohJudul: { fontSize: typography.caption, fontWeight: '700', color: colors.textMuted, marginBottom: spacing.sm, textTransform: 'uppercase', letterSpacing: 0.4 },
  contohBaris: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 4 },
  contohTotal: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.xs, paddingTop: spacing.sm },
  contohLabel: { flex: 1, fontSize: typography.subtitle, color: colors.text },
  contohNilai: { fontSize: typography.subtitle, color: colors.text, fontVariant: ['tabular-nums'] },
  dasar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.md },
  dasarTeks: { fontSize: typography.caption, color: colors.textMuted },

  seksi: { marginTop: spacing.lg, marginBottom: spacing.sm },
  seksiBaris: { flexDirection: 'row', alignItems: 'center' },
  nomor: { width: 22, height: 22, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginRight: spacing.sm },
  nomorTeks: { color: colors.white, fontSize: typography.caption, fontWeight: '700' },
  seksiJudul: { fontSize: typography.sectionTitle, fontWeight: '700', color: colors.text, flexShrink: 1 },
  seksiSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2, lineHeight: 17 },

  labelInfo: { flexDirection: 'row', alignItems: 'center' },
  labelInfoTeks: { fontSize: typography.subtitle, color: colors.textMuted, flexShrink: 1 },

  bilah: { paddingVertical: spacing.sm },
  bilahAngka: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: spacing.xs, marginTop: 2 },
  bilahNilai: { fontSize: typography.sectionTitle, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  bilahBatas: { fontSize: typography.caption, color: colors.textMuted },
  bilahJalur: { height: 8, borderRadius: radius.pill, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', marginTop: spacing.sm },
  bilahIsi: { height: '100%', borderRadius: radius.pill },
  bilahKet: { fontSize: typography.caption, marginTop: spacing.xs, fontWeight: '600' },

  pilihan: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, minHeight: touchTarget, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  pilihanAktif: { borderColor: colors.primary, backgroundColor: colors.focusBg },
  pilihanIkon: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  pilihanIkonAktif: { backgroundColor: colors.primary },
  pilihanJudul: { fontSize: typography.body, fontWeight: '700', color: colors.text },
  pilihanDesk: { fontSize: typography.caption, color: colors.textMuted, lineHeight: 17, marginTop: 2 },

  lencana: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1 },
  lencanaNetral: { backgroundColor: colors.background, borderColor: colors.border },
  lencanaSukses: { backgroundColor: colors.primaryLight, borderColor: colors.primaryLight },
  lencanaPeringatan: { backgroundColor: colors.warningBg, borderColor: colors.warningBorder },
  lencanaTeks: { fontSize: typography.caption, fontWeight: '700' },
});

// ---------------------------------------------------------------------------
// RC-S87.3 — Rincian perhitungan (SATU tampilan untuk semua jenis pajak)
// ---------------------------------------------------------------------------

const TANDA: Record<LangkahPerhitungan['jenis'], string> = {
  nilai: '',
  tambah: '+',
  kurang: '−',
  dikecualikan: '',
  subtotal: '=',
  tarif: '×',
  hasil: '=',
};

/**
 * Menampilkan `RincianPerhitungan` dari policy apa adanya: tanda operasi di
 * kiri, label + rumus + sumber di tengah, nominal di kanan. Subtotal dan
 * hasil diberi garis & tebal; baris yang dikecualikan dicoret. Tidak ada
 * perhitungan di komponen ini.
 */
export function KartuRincian({ rincian, ringkas = false }: { rincian: RincianPerhitungan; ringkas?: boolean }) {
  const [buka, setBuka] = useState(!ringkas);
  const hasil = rincian.langkah.filter((l) => l.jenis === 'hasil').slice(-1)[0];
  return (
    <View style={s.kartu}>
      <TouchableOpacity
        style={sr.header}
        onPress={() => setBuka((b) => !b)}
        accessibilityRole="button"
        accessibilityState={{ expanded: buka }}
        activeOpacity={0.7}
      >
        <View style={sr.headerIkon}>
          <Ionicons name="calculator-outline" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={sr.judul}>{rincian.judul}</Text>
          {hasil ? (
            <Text style={sr.subjudul}>
              {hasil.label}: <Text style={sr.subjudulNilai}>{hasil.nilai !== null ? formatRupiah(hasil.nilai) : hasil.teks}</Text>
            </Text>
          ) : null}
        </View>
        <Text style={sr.toggle}>{buka ? 'Tutup' : 'Rincian'}</Text>
        <Ionicons name={buka ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>

      {buka ? (
        <View style={sr.isi}>
          {rincian.langkah.map((l, i) => {
            const garis = l.jenis === 'subtotal' || l.jenis === 'hasil';
            const coret = l.jenis === 'dikecualikan';
            return (
              <View key={i} style={[sr.baris, garis && sr.barisGaris, l.jenis === 'hasil' && sr.barisHasil]}>
                <Text style={[sr.tanda, l.jenis === 'kurang' && { color: colors.danger }]}>{TANDA[l.jenis]}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[sr.label, garis && sr.tebal, coret && sr.coret]}>{l.label}</Text>
                  {l.rumus ? <Text style={sr.rumus}>{l.rumus}</Text> : null}
                  {l.sumber ? (
                    <View style={sr.sumber}>
                      <Ionicons name="link-outline" size={11} color={colors.textFaint} />
                      <Text style={sr.sumberTeks}>{l.sumber}</Text>
                    </View>
                  ) : null}
                </View>
                <Text
                  style={[sr.nilai, garis && sr.tebal, l.jenis === 'hasil' && sr.nilaiHasil, coret && sr.coret, l.jenis === 'kurang' && { color: colors.danger }]}
                >
                  {l.nilai !== null ? (l.jenis === 'kurang' ? `(${formatRupiah(l.nilai)})` : formatRupiah(l.nilai)) : l.teks ?? ''}
                </Text>
              </View>
            );
          })}
          {rincian.catatan.length > 0 ? (
            <View style={sr.catatan}>
              {rincian.catatan.map((c, i) => (
                <Text key={i} style={sr.catatanTeks}>
                  {c}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const sr = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerIkon: { width: 32, height: 32, borderRadius: radius.pill, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  judul: { fontSize: typography.body, fontWeight: '700', color: colors.text },
  subjudul: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },
  subjudulNilai: { fontWeight: '700', color: colors.text },
  toggle: { fontSize: typography.caption, fontWeight: '700', color: colors.primary },
  isi: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  baris: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: 6 },
  barisGaris: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 2, paddingTop: spacing.sm },
  barisHasil: { backgroundColor: colors.focusBg, borderRadius: radius.sm, paddingHorizontal: spacing.xs, borderTopColor: colors.primaryLight },
  tanda: { width: 14, fontSize: typography.body, fontWeight: '700', color: colors.textMuted, textAlign: 'center' },
  label: { fontSize: typography.subtitle, color: colors.text, lineHeight: 18 },
  rumus: { fontSize: typography.caption, color: colors.textMuted, lineHeight: 16, marginTop: 1 },
  sumber: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  sumberTeks: { fontSize: 11, color: colors.textFaint },
  nilai: { fontSize: typography.subtitle, color: colors.text, fontVariant: ['tabular-nums'], textAlign: 'right', maxWidth: '45%' },
  nilaiHasil: { color: colors.primary, fontSize: typography.body },
  tebal: { fontWeight: '700' },
  coret: { textDecorationLine: 'line-through', color: colors.textFaint },
  catatan: { marginTop: spacing.sm, gap: 2 },
  catatanTeks: { fontSize: typography.caption, color: colors.textMuted, lineHeight: 17 },
});
