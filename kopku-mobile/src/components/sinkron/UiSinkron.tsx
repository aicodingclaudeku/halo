import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { colors } from '@/theme/colors';
import { getDb } from '@/database/db';
import { useSyncStore, type StatusSinkron } from '@/sync/SyncStore';
import { daftarArsip } from '@/sync/SyncSnapshot';
import AnimasiTransfer, { type Aliran } from './AnimasiTransfer';
import { modeHpBacaSajaAktif } from '@/sync/SyncModeBacaSaja';
import type { BarisKonflik } from '@/sync/SyncEngine';

/** Komponen tampilan bersama layar Sinkron (HP & desktop). */

export const INFO_STATUS: Record<StatusSinkron, { judul: string; warna: string; latar: string; ikon: keyof typeof Ionicons.glyphMap }> = {
  BELUM_DIPASANGKAN: { judul: 'Belum terpasang', warna: '#6B756B', latar: '#F1F3F1', ikon: 'link-outline' },
  // RC-S133.5 — sinkron manual: terpasang = "Terhubung"; data dikirim atas perintah.
  PERLU_DATA_AWAL: { judul: 'Terhubung', warna: '#1B5E20', latar: '#E8F3E9', ikon: 'link' },
  SIAP: { judul: 'Terhubung', warna: '#1B5E20', latar: '#E8F3E9', ikon: 'checkmark-circle' },
  MENYINKRONKAN: { judul: 'Mengirim data…', warna: '#1565C0', latar: '#E8F0FB', ikon: 'sync' },
  TIDAK_TERHUBUNG: { judul: 'Tidak terhubung', warna: '#6B756B', latar: '#F1F3F1', ikon: 'cloud-offline-outline' },
  KONFLIK: { judul: 'Konflik data', warna: '#C62828', latar: '#FDECEC', ikon: 'alert-circle' },
  PERLU_SINKRON_ULANG: { judul: 'Perlu sinkron ulang', warna: '#C62828', latar: '#FDECEC', ikon: 'refresh-circle' },
  MENUNGGU_KONFIRMASI: { judul: 'Menunggu persetujuan', warna: '#8A6400', latar: colors.warningBg, ikon: 'hourglass-outline' },
  GALAT: { judul: 'Pengiriman gagal', warna: '#C62828', latar: '#FDECEC', ikon: 'warning' },
};

export function waktuLokal(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
}

export function Kartu({ judul, ikon, children, aksen }: { judul?: string; ikon?: keyof typeof Ionicons.glyphMap; children: React.ReactNode; aksen?: string }) {
  return (
    <View style={[u.kartu, aksen ? { borderLeftWidth: 4, borderLeftColor: aksen } : null]}>
      {!!judul && (
        <View style={u.kartuKepala}>
          {ikon && <Ionicons name={ikon} size={18} color={colors.primary} />}
          <Text style={u.kartuJudul}>{judul}</Text>
        </View>
      )}
      {children}
    </View>
  );
}

export function Tombol({
  teks,
  ikon,
  onPress,
  varian = 'utama',
  disabled,
  sibuk,
}: {
  teks: string;
  ikon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  varian?: 'utama' | 'sekunder' | 'bahaya';
  disabled?: boolean;
  sibuk?: boolean;
}) {
  const warnaTeks = varian === 'utama' ? '#fff' : varian === 'bahaya' ? colors.danger : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || sibuk}
      onPress={onPress}
      style={({ pressed }) => [u.tombol, u[`tombol_${varian}` as 'tombol_utama'], (disabled || sibuk) && { opacity: 0.45 }, pressed && { opacity: 0.8 }]}
    >
      {sibuk ? <ActivityIndicator size="small" color={warnaTeks} /> : ikon ? <Ionicons name={ikon} size={18} color={warnaTeks} /> : null}
      <Text style={[u.tombolTeks, { color: warnaTeks }]}>{teks}</Text>
    </Pressable>
  );
}

export function KartuStatus({ subjudul, tambahan, namaHp, namaDesktop }: { subjudul?: string; tambahan?: React.ReactNode; namaHp?: string; namaDesktop?: string }) {
  const { status, pesan, terakhirSinkron, tertunda, progres, aliran, persen } = useSyncStore();
  const i = INFO_STATUS[status];
  const aliranTerakhir = React.useRef<Aliran | null>(null);
  if (aliran) aliranTerakhir.current = aliran;
  return (
    <>
    <AnimasiTransfer
      aktif={!!aliran}
      aliran={aliran ?? aliranTerakhir.current}
      persen={persen}
      label={progres}
      gagal={status === 'GALAT' || status === 'TIDAK_TERHUBUNG' || status === 'PERLU_SINKRON_ULANG' || status === 'KONFLIK'}
      namaHp={namaHp}
      namaDesktop={namaDesktop}
    />
    <View style={[u.status, { backgroundColor: i.latar }]}>
      <View style={[u.statusIkon, { backgroundColor: '#fff' }]}>
        {status === 'MENYINKRONKAN' && !aliran ? <ActivityIndicator color={i.warna} /> : <Ionicons name={i.ikon} size={28} color={i.warna} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[u.statusJudul, { color: i.warna }]}>{i.judul}</Text>
        {!!subjudul && <Text style={u.statusSub}>{subjudul}</Text>}
        {/* Saat animasi transfer tampil, keterangan proses sudah ada di kartu animasi — jangan diulang. */}
        {/* RC-S133.5: pesan yang isinya sama dengan subjudul ("Terhubung dengan X.") tidak diulang. */}
        {(() => {
          const teksPesan = aliran ? pesan : progres ?? pesan;
          const ulang = !!teksPesan && !!subjudul && teksPesan.replace(/[.\s]+$/, '') === subjudul.replace(/[.\s]+$/, '');
          return teksPesan && !ulang ? <Text style={u.statusPesan}>{teksPesan}</Text> : null;
        })()}
        <View style={u.statusMeta}>
          <Text style={u.meta}>Terakhir kirim data: {waktuLokal(terakhirSinkron)}</Text>
          {modeHpBacaSajaAktif() ? <Text style={u.meta}>Mode cadangan: menerima data dari desktop</Text> : null}
          {tertunda > 0 ? <Text style={u.meta}>Menunggu dikirim: {tertunda} perubahan</Text> : null}
        </View>
        {tambahan}
      </View>
    </View>
    </>
  );
}

export function DaftarKonflik({ konflik }: { konflik: BarisKonflik[] }) {
  if (konflik.length === 0) return null;
  return (
    <View style={{ marginTop: 8 }}>
      {konflik.slice(0, 30).map((k, i) => (
        <View key={`${k.tbl}-${k.pk}-${i}`} style={u.konflik}>
          <Ionicons name="git-compare-outline" size={16} color={colors.danger} />
          <Text style={u.konflikTeks} numberOfLines={2}>
            {k.label}
          </Text>
        </View>
      ))}
      {konflik.length > 30 && <Text style={u.meta}>…dan {konflik.length - 30} lainnya</Text>}
    </View>
  );
}

export function RiwayatDanArsip() {
  const [riwayat, setRiwayat] = useState<any[]>([]);
  const [arsip, setArsip] = useState<{ nama: string; uri: string }[]>([]);
  const versi = useSyncStore((s) => s.versiData);
  const status = useSyncStore((s) => s.status);
  const muat = useCallback(async () => {
    try {
      const db = await getDb();
      setRiwayat(await db.getAllAsync('SELECT * FROM sync_riwayat ORDER BY id DESC LIMIT 12'));
    } catch {
      setRiwayat([]);
    }
    setArsip(await daftarArsip());
  }, []);
  useEffect(() => {
    void muat();
  }, [muat, versi, status]);
  const label: Record<string, string> = { DUA_ARAH: 'Sinkron dua arah', MASUK: 'Terima', KELUAR: 'Kirim', SNAPSHOT_MASUK: 'Data diterima (diganti)', SNAPSHOT_KELUAR: 'Data dikirim' };
  return (
    <>
      <Kartu judul="Riwayat kirim data" ikon="time-outline">
        {riwayat.length === 0 && <Text style={u.meta}>Belum ada riwayat.</Text>}
        {riwayat.map((r) => (
          <View key={r.id} style={u.barisRiwayat}>
            <Ionicons name={r.hasil === 'OK' ? 'checkmark-circle' : 'alert-circle'} size={16} color={r.hasil === 'OK' ? colors.success : colors.danger} />
            <View style={{ flex: 1 }}>
              <Text style={u.riwayatJudul}>
                {label[r.arah] ?? r.arah} · {r.hasil}
              </Text>
              <Text style={u.meta} numberOfLines={2}>
                {waktuLokal(r.waktu)} · kirim {r.jumlah_kirim} · terima {r.jumlah_terima}
                {r.pesan ? ` · ${r.pesan}` : ''}
              </Text>
            </View>
          </View>
        ))}
      </Kartu>
      {arsip.length > 0 && (
        <Kartu judul="Arsip perubahan yang tidak dipakai" ikon="archive-outline">
          <Text style={u.meta}>
            Perubahan yang belum terkirim sebelum data diganti disimpan di sini (JSON) agar dapat ditinjau dan dimasukkan ulang bila perlu.
          </Text>
          {arsip.map((a) => (
            <Pressable key={a.uri} style={u.barisRiwayat} onPress={() => Sharing.shareAsync(a.uri, { mimeType: 'application/json' }).catch(() => undefined)}>
              <Ionicons name="document-text-outline" size={16} color={colors.primary} />
              <Text style={[u.riwayatJudul, { flex: 1 }]}>{a.nama}</Text>
              <Ionicons name="share-outline" size={16} color={colors.textMuted} />
            </Pressable>
          ))}
        </Kartu>
      )}
    </>
  );
}

export const u = StyleSheet.create({
  kartu: { backgroundColor: '#fff', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border, marginBottom: 14 },
  kartuKepala: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  kartuJudul: { fontSize: 15, fontWeight: '800', color: colors.text },
  tombol: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, minHeight: 46 },
  tombol_utama: { backgroundColor: colors.primary },
  tombol_sekunder: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.primary },
  tombol_bahaya: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.danger },
  tombolTeks: { fontSize: 14, fontWeight: '800' },
  status: { flexDirection: 'row', gap: 14, padding: 16, borderRadius: 16, marginBottom: 14 },
  statusIkon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  statusJudul: { fontSize: 18, fontWeight: '800' },
  statusSub: { fontSize: 13, color: colors.text, marginTop: 2, fontWeight: '600' },
  statusPesan: { fontSize: 13, color: '#3A433A', marginTop: 6, lineHeight: 19 },
  statusMeta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, marginTop: 8 },
  meta: { fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  konflik: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F3E3E3' },
  konflikTeks: { flex: 1, fontSize: 13, color: colors.text },
  barisRiwayat: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F0F2F0' },
  riwayatJudul: { fontSize: 13, fontWeight: '700', color: colors.text },
  langkah: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 10 },
  nomor: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  nomorTeks: { fontSize: 12, fontWeight: '800', color: colors.primary },
  teks: { fontSize: 14, color: '#2F382F', lineHeight: 21, flex: 1 },
});
