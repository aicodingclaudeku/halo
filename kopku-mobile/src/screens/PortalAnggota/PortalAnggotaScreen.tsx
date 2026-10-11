import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { muatDataSaya, type DataSaya, type PinjamanSaya } from '@/services/PortalAnggotaService';
import { useAppStore } from '@/store/useAppStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing, typography } from '@/theme/colors';
import GantiPasswordScreen from '@/screens/Setup/GantiPasswordScreen';
import { useSyncStore } from '@/sync/SyncStore';

/**
 * RC-S133.5 — PORTAL ANGGOTA ("Data Saya").
 *
 * Satu-satunya tampilan untuk akun ber-role Anggota (app/index.tsx tidak
 * me-mount RootNavigator untuknya). Semua angka dibaca lewat
 * `muatDataSaya(userId)`, yang menentukan anggota dari akun sesi di
 * database — layar ini tidak pernah memilih anggota sendiri.
 */
type Tab = 'RINGKASAN' | 'SIMPANAN' | 'PINJAMAN' | 'RIWAYAT' | 'SHU';
const TAB: { kunci: Tab; label: string; ikon: keyof typeof Ionicons.glyphMap }[] = [
  { kunci: 'RINGKASAN', label: 'Ringkasan', ikon: 'home-outline' },
  { kunci: 'SIMPANAN', label: 'Simpanan', ikon: 'wallet-outline' },
  { kunci: 'PINJAMAN', label: 'Pinjaman', ikon: 'cash-outline' },
  { kunci: 'RIWAYAT', label: 'Riwayat', ikon: 'time-outline' },
  { kunci: 'SHU', label: 'SHU', ikon: 'gift-outline' },
];

const tgl = (s?: string | null) => {
  if (!s) return '-';
  const [y, m, d] = s.slice(0, 10).split('-');
  const bln = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'][Number(m) - 1];
  return bln ? `${Number(d)} ${bln} ${y}` : s;
};

export default function PortalAnggotaScreen({ onKeluar }: { onKeluar: () => void }) {
  const user = useAppStore((s) => s.currentUser);
  const koperasi = useAppStore((s) => s.koperasi);
  const [data, setData] = useState<DataSaya | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [memuat, setMemuat] = useState(true);
  const [tab, setTab] = useState<Tab>('RINGKASAN');
  const [gantiPassword, setGantiPassword] = useState(false);
  const [pinjamanTerbuka, setPinjamanTerbuka] = useState<string | null>(null);

  const muat = useCallback(async () => {
    if (!user) return;
    setMemuat(true);
    setGalat(null);
    try {
      setData(await muatDataSaya(user.id));
    } catch (e) {
      setGalat(e instanceof Error ? e.message : 'Gagal memuat data.');
    } finally {
      setMemuat(false);
    }
  }, [user]);

  useEffect(() => {
    void muat();
  }, [muat]);

  // Desktop: portal memakai lebar jendela penuh (bingkai layar masuk dilepas).
  useEffect(() => {
    useSyncStore.getState().setLayarPenuh(true);
    return () => useSyncStore.getState().setLayarPenuh(false);
  }, []);

  if (gantiPassword && user) {
    return <GantiPasswordScreen userId={user.id} onSelesai={() => setGantiPassword(false)} onKeluar={() => setGantiPassword(false)} />;
  }

  return (
    <View style={st.akar} testID="portal-anggota">
      <View style={st.kepala}>
        <View style={st.lebar}>
        <View style={st.kepalaBaris}>
          <View style={st.avatar}>
            <Text style={st.avatarTeks}>{(data?.anggota.namaLengkap ?? user?.nama ?? '?').slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={st.kepalaKecil}>{koperasi?.nama ?? 'KOPKU'}</Text>
            <Text style={st.kepalaNama} numberOfLines={1}>
              {data?.anggota.namaLengkap ?? user?.nama ?? ''}
            </Text>
            {data ? (
              <Text style={st.kepalaKecil}>
                No. {data.anggota.nomorAnggota} · Anggota sejak {tgl(data.anggota.tanggalBergabung)}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity onPress={muat} style={st.ikonTombol} accessibilityLabel="Muat ulang">
            <Ionicons name="refresh" size={20} color={colors.white} />
          </TouchableOpacity>
        </View>
        <View style={st.tabBaris}>
          {TAB.map((t) => (
            <TouchableOpacity
              key={t.kunci}
              onPress={() => setTab(t.kunci)}
              style={[st.tab, tab === t.kunci && st.tabAktif]}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === t.kunci }}
              testID={`portal-tab-${t.kunci.toLowerCase()}`}
            >
              <Ionicons name={t.ikon} size={16} color={tab === t.kunci ? colors.primary : 'rgba(255,255,255,0.85)'} />
              <Text style={[st.tabTeks, tab === t.kunci && st.tabTeksAktif]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        </View>
      </View>

      <ScrollView contentContainerStyle={[st.isi, st.lebar]}>
        {memuat && !data ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
        ) : galat ? (
          <View style={st.kartuGalat}>
            <Ionicons name="alert-circle-outline" size={22} color={colors.danger} />
            <Text style={st.galatTeks}>{galat}</Text>
          </View>
        ) : data ? (
          <>
            {tab === 'RINGKASAN' ? <Ringkasan d={data} keTab={setTab} /> : null}
            {tab === 'SIMPANAN' ? <Simpanan d={data} /> : null}
            {tab === 'PINJAMAN' ? (
              <Pinjaman d={data} terbuka={pinjamanTerbuka} setTerbuka={setPinjamanTerbuka} />
            ) : null}
            {tab === 'RIWAYAT' ? <Riwayat d={data} /> : null}
            {tab === 'SHU' ? <Shu d={data} /> : null}
          </>
        ) : null}

        <View style={st.kartu}>
          <Text style={st.judulKartu}>Akun</Text>
          <Text style={st.ket}>
            Masuk sebagai <Text style={st.tebal}>{user?.nama}</Text>. Akun anggota hanya dapat melihat data Anda sendiri.
          </Text>
          <View style={st.barisTombol}>
            <TouchableOpacity style={st.tombolGaris} onPress={() => setGantiPassword(true)} accessibilityRole="button">
              <Ionicons name="key-outline" size={16} color={colors.primary} />
              <Text style={st.tombolGarisTeks}>Ganti password</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[st.tombolGaris, st.tombolBahaya]} onPress={onKeluar} accessibilityRole="button" accessibilityLabel="Keluar dari akun">
              <Ionicons name="log-out-outline" size={16} color={colors.danger} />
              <Text style={[st.tombolGarisTeks, { color: colors.danger }]}>Keluar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function Angka({ label, nilai, ikon, nada }: { label: string; nilai: string; ikon: keyof typeof Ionicons.glyphMap; nada?: 'utama' | 'bahaya' }) {
  return (
    <View style={st.angka}>
      <View style={[st.angkaIkon, nada === 'bahaya' && { backgroundColor: colors.dangerBg }]}>
        <Ionicons name={ikon} size={18} color={nada === 'bahaya' ? colors.danger : colors.primary} />
      </View>
      <Text style={st.angkaLabel}>{label}</Text>
      <Text style={[st.angkaNilai, nada === 'bahaya' && { color: colors.danger }]}>{nilai}</Text>
    </View>
  );
}

function Baris({ kiri, kanan, tebal }: { kiri: string; kanan: string; tebal?: boolean }) {
  return (
    <View style={st.baris}>
      <Text style={[st.barisKiri, tebal && st.tebal]}>{kiri}</Text>
      <Text style={[st.barisKanan, tebal && st.tebal]}>{kanan}</Text>
    </View>
  );
}

function Ringkasan({ d, keTab }: { d: DataSaya; keTab: (t: Tab) => void }) {
  const berikut = d.pinjaman.map((p) => p.angsuranBerikutnya).filter(Boolean)[0] ?? null;
  return (
    <>
      <View style={st.grid}>
        <Angka label="Total simpanan" nilai={formatRupiah(d.simpanan.total)} ikon="wallet-outline" />
        <Angka label="Sisa pinjaman (pokok)" nilai={formatRupiah(d.ringkasanPinjaman.sisaPokok)} ikon="cash-outline" />
        <Angka
          label="Tunggakan"
          nilai={d.ringkasanPinjaman.hariTunggakan > 0 ? `${d.ringkasanPinjaman.hariTunggakan} hari` : 'Tidak ada'}
          ikon="alert-circle-outline"
          nada={d.ringkasanPinjaman.hariTunggakan > 0 ? 'bahaya' : 'utama'}
        />
        <Angka label="SHU terakhir" nilai={d.shu[0] ? formatRupiah(d.shu[0].total) : '-'} ikon="gift-outline" />
      </View>
      {berikut ? (
        <View style={st.kartuSorot}>
          <Ionicons name="calendar-outline" size={20} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={st.tebal}>Angsuran berikutnya: {formatRupiah(berikut.total - berikut.pokokTerbayar - berikut.jasaTerbayar)}</Text>
            <Text style={st.ket}>
              Ke-{berikut.nomorAngsuran}, jatuh tempo {tgl(berikut.tanggalJatuhTempo)}
            </Text>
          </View>
        </View>
      ) : null}
      <View style={st.kartu}>
        <Text style={st.judulKartu}>Simpanan</Text>
        <Baris kiri="Simpanan pokok" kanan={formatRupiah(d.simpanan.pokok)} />
        <Baris kiri="Simpanan wajib" kanan={formatRupiah(d.simpanan.wajib)} />
        <Baris kiri="Simpanan sukarela" kanan={formatRupiah(d.simpanan.sukarela)} />
        <Baris kiri="Total" kanan={formatRupiah(d.simpanan.total)} tebal />
        <TouchableOpacity onPress={() => keTab('SIMPANAN')} style={st.tautan}>
          <Text style={st.tautanTeks}>Lihat rincian</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.primary} />
        </TouchableOpacity>
      </View>
      <View style={st.kartu}>
        <Text style={st.judulKartu}>Pinjaman aktif</Text>
        {d.ringkasanPinjaman.jumlahAktif === 0 ? (
          <Text style={st.ket}>Tidak ada pinjaman aktif.</Text>
        ) : (
          <>
            <Baris kiri="Jumlah pinjaman aktif" kanan={String(d.ringkasanPinjaman.jumlahAktif)} />
            <Baris kiri="Sisa pokok" kanan={formatRupiah(d.ringkasanPinjaman.sisaPokok)} />
            <Baris kiri="Sisa jasa terjadwal" kanan={formatRupiah(d.ringkasanPinjaman.sisaJasa)} />
            {d.ringkasanPinjaman.kolektibilitas ? <Baris kiri="Kolektibilitas" kanan={d.ringkasanPinjaman.kolektibilitas} /> : null}
          </>
        )}
        <TouchableOpacity onPress={() => keTab('PINJAMAN')} style={st.tautan}>
          <Text style={st.tautanTeks}>Lihat jadwal angsuran</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.primary} />
        </TouchableOpacity>
      </View>
    </>
  );
}

function Simpanan({ d }: { d: DataSaya }) {
  return (
    <>
      <View style={st.kartu}>
        <Text style={st.judulKartu}>Saldo simpanan</Text>
        <Baris kiri="Simpanan pokok" kanan={formatRupiah(d.simpanan.pokok)} />
        <Baris kiri="Simpanan wajib" kanan={formatRupiah(d.simpanan.wajib)} />
        <Baris kiri="Simpanan sukarela" kanan={formatRupiah(d.simpanan.sukarela)} />
        <Baris kiri="Total" kanan={formatRupiah(d.simpanan.total)} tebal />
      </View>
      <View style={st.kartu}>
        <Text style={st.judulKartu}>Simpanan berjangka</Text>
        {d.simpananBerjangka.length === 0 ? (
          <Text style={st.ket}>Tidak ada simpanan berjangka.</Text>
        ) : (
          d.simpananBerjangka.map((k) => (
            <View key={k.id} style={st.item}>
              <View style={{ flex: 1 }}>
                <Text style={st.tebal}>{k.nomorTransaksi}</Text>
                <Text style={st.ket}>
                  {tgl(k.tanggalMulai)} – {tgl(k.tanggalJatuhTempo)} · {k.tenorBulan} bln · {k.sukuBungaPerTahun}%/thn
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={st.tebal}>{formatRupiah(k.nominal)}</Text>
                <Text style={st.lencana}>{k.status}</Text>
              </View>
            </View>
          ))
        )}
      </View>
    </>
  );
}

function Pinjaman({ d, terbuka, setTerbuka }: { d: DataSaya; terbuka: string | null; setTerbuka: (id: string | null) => void }) {
  if (d.pinjaman.length === 0) {
    return (
      <View style={st.kartu}>
        <Text style={st.ket}>Anda belum memiliki pinjaman.</Text>
      </View>
    );
  }
  return (
    <>
      {d.pinjaman.map((p: PinjamanSaya) => {
        const buka = terbuka === p.id;
        return (
          <View key={p.id} style={st.kartu}>
            <TouchableOpacity onPress={() => setTerbuka(buka ? null : p.id)} style={st.item} accessibilityRole="button">
              <View style={{ flex: 1 }}>
                <Text style={st.tebal}>{p.nomorPinjaman}</Text>
                <Text style={st.ket}>
                  Plafon {formatRupiah(p.jumlahPinjaman)} · {p.tenor} {p.satuanTenor === 'MINGGU' ? 'minggu' : p.satuanTenor === 'HARI' ? 'hari' : 'bulan'}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={st.lencana}>{p.status}</Text>
                <Ionicons name={buka ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
              </View>
            </TouchableOpacity>
            {p.status === 'AKTIF' ? (
              <>
                <Baris kiri="Sisa pokok" kanan={formatRupiah(p.sisaPokok)} />
                <Baris kiri="Sisa jasa terjadwal" kanan={formatRupiah(p.sisaJasa)} />
              </>
            ) : null}
            {buka ? (
              <View style={st.jadwal}>
                <View style={[st.jadwalBaris, st.jadwalKepala]}>
                  <Text style={[st.jK, st.jNo]}>Ke</Text>
                  <Text style={[st.jK, st.jTgl]}>Jatuh tempo</Text>
                  <Text style={[st.jK, st.jNom]}>Angsuran</Text>
                  <Text style={[st.jK, st.jSt]}>Status</Text>
                </View>
                {p.jadwal.map((j) => {
                  const lunas = j.status === 'LUNAS' || j.pokokTerbayar + j.jasaTerbayar >= j.total;
                  return (
                    <View key={j.id} style={st.jadwalBaris}>
                      <Text style={[st.jT, st.jNo]}>{j.nomorAngsuran}</Text>
                      <Text style={[st.jT, st.jTgl]}>{tgl(j.tanggalJatuhTempo)}</Text>
                      <Text style={[st.jT, st.jNom]}>{formatRupiah(j.total)}</Text>
                      <Text style={[st.jT, st.jSt, { color: lunas ? colors.success : colors.textMuted }]}>{lunas ? 'Lunas' : 'Belum'}</Text>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
    </>
  );
}

function Riwayat({ d }: { d: DataSaya }) {
  return (
    <View style={st.kartu}>
      <Text style={st.judulKartu}>Transaksi terakhir</Text>
      {d.transaksi.length === 0 ? (
        <Text style={st.ket}>Belum ada transaksi.</Text>
      ) : (
        d.transaksi.map((t) => (
          <View key={t.id} style={st.item}>
            <View style={{ flex: 1 }}>
              <Text style={st.tebal}>{t.jenis}</Text>
              <Text style={st.ket}>
                {tgl(t.tanggal)} · {t.tipe}
                {t.nomorReferensi ? ` · ${t.nomorReferensi}` : ''}
              </Text>
            </View>
            <Text style={st.tebal}>{formatRupiah(t.nominal)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

function Shu({ d }: { d: DataSaya }) {
  return (
    <View style={st.kartu}>
      <Text style={st.judulKartu}>Sisa Hasil Usaha (SHU)</Text>
      {d.shu.length === 0 ? (
        <Text style={st.ket}>Belum ada SHU yang disahkan RAT untuk Anda.</Text>
      ) : (
        d.shu.map((s) => (
          <View key={s.tahunBuku} style={st.shuBlok}>
            <Baris kiri={`Tahun buku ${s.tahunBuku}`} kanan={formatRupiah(s.total)} tebal />
            <Baris kiri="Jasa modal" kanan={formatRupiah(s.jasaModal)} />
            <Baris kiri="Jasa usaha" kanan={formatRupiah(s.jasaUsaha)} />
            <Text style={st.ket}>{s.status === 'DIBAGIKAN' ? 'Sudah dibagikan' : 'Disahkan RAT'}</Text>
          </View>
        ))
      )}
    </View>
  );
}

const st = StyleSheet.create({
  akar: { flex: 1, backgroundColor: colors.background },
  /** Isi dibatasi 960 px & di tengah — di jendela desktop lebar tetap enak dibaca; di HP tidak berpengaruh. */
  lebar: { width: '100%', maxWidth: 960, alignSelf: 'center' },
  kepala: { backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.sm },
  kepalaBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  avatarTeks: { color: colors.white, fontWeight: '800', fontSize: 20 },
  kepalaKecil: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
  kepalaNama: { color: colors.white, fontSize: 18, fontWeight: '800', marginVertical: 1 },
  ikonTombol: { padding: 8, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.15)' },
  tabBaris: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.md },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill },
  tabAktif: { backgroundColor: colors.white },
  tabTeks: { color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: '600' },
  tabTeksAktif: { color: colors.primary },
  isi: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  angka: { flexGrow: 1, flexBasis: 150, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  angkaIkon: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  angkaLabel: { fontSize: 12, color: colors.textMuted },
  angkaNilai: { fontSize: 17, fontWeight: '800', color: colors.text, marginTop: 2 },
  kartu: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: 6 },
  kartuSorot: { flexDirection: 'row', gap: spacing.md, alignItems: 'center', backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.md },
  kartuGalat: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', backgroundColor: colors.dangerBg, borderRadius: radius.md, padding: spacing.md },
  galatTeks: { flex: 1, color: colors.danger, fontSize: 13 },
  judulKartu: { fontSize: typography.sectionTitle, fontWeight: '800', color: colors.text, marginBottom: 4 },
  ket: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  tebal: { fontWeight: '700', color: colors.text },
  baris: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  barisKiri: { fontSize: 13, color: colors.textMuted },
  barisKanan: { fontSize: 13, color: colors.text },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  lencana: { fontSize: 11, fontWeight: '700', color: colors.primary, backgroundColor: colors.primaryLight, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden', marginBottom: 2 },
  tautan: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', marginTop: 4 },
  tautanTeks: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  jadwal: { marginTop: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden' },
  jadwalBaris: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  jadwalKepala: { backgroundColor: colors.background },
  jK: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  jT: { fontSize: 12, color: colors.text },
  jNo: { width: 28 },
  jTgl: { flex: 1 },
  jNom: { width: 110, textAlign: 'right' },
  jSt: { width: 52, textAlign: 'right' },
  shuBlok: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  barisTombol: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: 6 },
  tombolGaris: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 9 },
  tombolBahaya: { borderColor: colors.danger },
  tombolGarisTeks: { color: colors.primary, fontWeight: '700', fontSize: 13 },
});
