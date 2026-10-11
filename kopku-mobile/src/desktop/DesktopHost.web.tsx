import React, { useEffect, useState } from 'react';
import { Alert, Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { notify } from '@/store/useNotifyStore';
import { useAppStore } from '@/store/useAppStore';
import { evaluasiIzin } from '@/security/permissions';
import { useSyncStore } from '@/sync/SyncStore';
import { bridge } from './bridge';
import { bacaPasangan } from '@/sync/SyncIdentitas';
import { mulaiServerSinkron } from '@/sync/SyncServer';
import PanelSinkronDesktop from '@/components/sinkron/PanelSinkronDesktop';
import { INFO_STATUS } from '@/components/sinkron/UiSinkron';

/**
 * HOST DESKTOP — dipasang sekali di app/_layout.tsx (versi HP = null).
 *
 * 1. Penyesuaian platform yang dijalankan SAAT MODUL DIMUAT (sebelum
 *    layar mana pun dirender):
 *    - `fetch` ke HTTPS diteruskan lewat proses utama (server lisensi
 *      tidak mengirim header CORS; aplikasi HP pun tidak terkena CORS);
 *    - `Alert.alert` (no-op di react-native-web) dialihkan ke pop-up
 *      aplikasi `notify()` dengan tombol yang sama.
 * 2. Lembar aksi berkas — padanan share sheet HP untuk hasil ekspor
 *    (PDF/Excel/CSV/backup): Simpan Sebagai, Buka, Tampilkan di Folder, Cetak.
 * 3. Dialog persetujuan sinkron & pemberitahuan data baru dari HP.
 */

const b = bridge();

if (b && !(globalThis as any).__kopkuFetchDipasang) {
  (globalThis as any).__kopkuFetchDipasang = true;
  const asli = globalThis.fetch.bind(globalThis);
  const tanpaBadan = new Set([101, 204, 205, 304]);
  const dekode = (s: string) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!/^https:\/\//i.test(url)) return asli(input as RequestInfo, init);
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body == null ? null : typeof init.body === 'string' ? init.body : String(init.body);
    const sinyal = init?.signal;
    if (sinyal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const janji = b.http.fetch(url, { method: init?.method ?? 'GET', headers, body });
    const r = await (sinyal
      ? Promise.race([
          janji,
          new Promise<never>((_, tolak) => sinyal.addEventListener('abort', () => tolak(new DOMException('Aborted', 'AbortError')), { once: true })),
        ])
      : janji);
    return new Response(tanpaBadan.has(r.status) ? null : dekode(r.bodyB64), { status: r.status, statusText: r.statusText, headers: r.headers });
  }) as typeof fetch;

  (Alert as any).alert = (title: string, message?: string, buttons?: any[]) => notify(title, message, buttons as any);
}

type Lembar = { uri: string; nama: string; selesai: () => void } | null;

export default function DesktopHost(): React.ReactElement | null {
  const [lembar, setLembar] = useState<Lembar>(null);
  const [pesanAksi, setPesanAksi] = useState<string | null>(null);
  const konfirmasi = useSyncStore((s) => s.konfirmasi);
  const versiData = useSyncStore((s) => s.versiData);
  const [dataBaru, setDataBaru] = useState(false);
  const [terpasang, setTerpasang] = useState(false);
  const [panelSinkron, setPanelSinkron] = useState(false);
  const sidebarAktif = useSyncStore((s) => s.sidebarAktif);
  const statusSinkron = useSyncStore((s) => s.status);
  const permissions = useAppStore((s) => s.permissions);
  const koperasi = useAppStore((s) => s.koperasi);

  useEffect(() => {
    (globalThis as any).__kopkuLembarBerkas = (uri: string) =>
      new Promise<void>((selesai) => {
        setPesanAksi(null);
        setLembar({ uri, nama: decodeURI(uri.split('/').pop() || 'berkas'), selesai });
      });
    return () => {
      delete (globalThis as any).__kopkuLembarBerkas;
    };
  }, []);

  useEffect(() => {
    if (versiData > 0) setDataBaru(true);
  }, [versiData]);

  // Server sinkron HP dinyalakan DI LUAR gerbang lisensi & login: HP tetap
  // dapat menyelesaikan pengiriman data (mis. tepat setelah data awal
  // terpasang, desktop berpindah ke layar aktivasi lisensi).
  useEffect(() => {
    void bacaPasangan().then((p) => {
      setTerpasang(!!p);
      if (p) void mulaiServerSinkron().catch(() => undefined);
    });
  }, [statusSinkron]);

  if (!b) return null;

  const tutup = () => {
    lembar?.selesai();
    setLembar(null);
  };
  const aksi = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = await fn();
      if (r !== null) setPesanAksi(ok + (typeof r === 'string' ? `\n${r}` : ''));
    } catch (e) {
      setPesanAksi(`Gagal: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const bisaCetak = !!lembar && /\.(pdf|html?)$/i.test(lembar.nama);
  const ikonBerkas = lembar && /\.pdf$/i.test(lembar.nama) ? 'document-text' : lembar && /\.(xlsx|csv)$/i.test(lembar.nama) ? 'grid' : 'document';

  const bolehSetujui = !koperasi || (permissions ? evaluasiIzin(permissions.backup, 'approve') : false);

  return (
    <>
      <Modal transparent visible={!!lembar} animationType="fade" onRequestClose={tutup}>
        <Pressable style={st.latar} onPress={tutup}>
          <Pressable style={st.kartu} onPress={() => undefined}>
            <View style={st.kepala}>
              <View style={st.ikonBesar}>
                <Ionicons name={ikonBerkas as any} size={26} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.judul}>Berkas siap</Text>
                <Text style={st.nama} numberOfLines={2}>
                  {lembar?.nama}
                </Text>
              </View>
            </View>
            <View style={st.grid}>
              <Tombol ikon="download-outline" teks="Simpan Sebagai…" utama onPress={() => aksi(() => b.dialog.saveFile(lembar!.uri, lembar!.nama), 'Tersimpan di:')} />
              <Tombol ikon="open-outline" teks="Buka" onPress={() => aksi(() => b.shell.openPath(lembar!.uri).then(() => null), '')} />
              <Tombol ikon="folder-open-outline" teks="Tampilkan di Folder" onPress={() => aksi(() => b.shell.showItem(lembar!.uri).then(() => null), '')} />
              {bisaCetak && <Tombol ikon="print-outline" teks="Cetak…" onPress={() => aksi(() => b.print.printFile(lembar!.uri).then(() => null), '')} />}
            </View>
            {!!pesanAksi && <Text style={st.pesan}>{pesanAksi}</Text>}
            <Pressable style={st.tutup} onPress={tutup}>
              <Text style={st.tutupTeks}>Selesai</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal transparent visible={!!konfirmasi} animationType="fade">
        <View style={st.latar}>
          <View style={st.kartu}>
            <View style={st.kepala}>
              <View style={[st.ikonBesar, { backgroundColor: colors.warningBg }]}>
                <Ionicons name="phone-portrait-outline" size={26} color={colors.warning} />
              </View>
              <Text style={[st.judul, { flex: 1 }]}>{konfirmasi?.judul}</Text>
            </View>
            <Text style={st.isi}>{konfirmasi?.pesan}</Text>
            {!bolehSetujui && (
              <Text style={[st.pesan, { color: colors.danger }]}>
                Masuk sebagai pengguna dengan izin Backup › Setujui (mis. Admin) untuk menyetujui permintaan ini.
              </Text>
            )}
            <View style={st.barisAksi}>
              <Pressable style={st.btnSek} onPress={() => konfirmasi?.tolak()}>
                <Text style={st.btnSekTeks}>Tolak</Text>
              </Pressable>
              <Pressable style={[st.btn, !bolehSetujui && { opacity: 0.4 }]} disabled={!bolehSetujui} onPress={() => konfirmasi?.setujui()}>
                <Text style={st.btnTeks}>Setujui & Ganti Data</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Akses Sinkron HP saat sidebar aplikasi belum tampil (layar lisensi / login). */}
      {terpasang && !sidebarAktif && (
        <Pressable style={st.pil} onPress={() => setPanelSinkron(true)}>
          <Ionicons name={INFO_STATUS[statusSinkron].ikon} size={18} color={INFO_STATUS[statusSinkron].warna} />
          <Text style={st.pilTeks}>Sinkron HP · {INFO_STATUS[statusSinkron].judul}</Text>
        </Pressable>
      )}
      <Modal transparent visible={panelSinkron} animationType="fade" onRequestClose={() => setPanelSinkron(false)}>
        <View style={st.latar}>
          <View style={st.panel}>
            <View style={st.panelKepala}>
              <Text style={st.judul}>Sinkron HP</Text>
              <Pressable onPress={() => setPanelSinkron(false)}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </Pressable>
            </View>
            <PanelSinkronDesktop />
          </View>
        </View>
      </Modal>

      {dataBaru && sidebarAktif && (
        <View style={st.toast} pointerEvents="box-none">
          <Ionicons name="sync-circle" size={22} color="#fff" />
          <Text style={st.toastTeks}>Data baru dari HP sudah diterima.</Text>
          <Pressable onPress={() => window.location.reload()} style={st.toastBtn}>
            <Text style={st.toastBtnTeks}>Muat ulang tampilan</Text>
          </Pressable>
          <Pressable onPress={() => setDataBaru(false)}>
            <Ionicons name="close" size={18} color="#fff" />
          </Pressable>
        </View>
      )}
    </>
  );
}

function Tombol({ ikon, teks, onPress, utama }: { ikon: string; teks: string; onPress: () => void; utama?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered }: any) => [st.tombol, utama && st.tombolUtama, hovered && { opacity: 0.85 }]}
    >
      <Ionicons name={ikon as any} size={20} color={utama ? '#fff' : colors.primary} />
      <Text style={[st.tombolTeks, utama && { color: '#fff' }]}>{teks}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  latar: { flex: 1, backgroundColor: 'rgba(16,24,16,0.45)', alignItems: 'center', justifyContent: 'center' },
  kartu: { width: 460, maxWidth: '92%', backgroundColor: '#fff', borderRadius: 18, padding: 22, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 28 },
  kepala: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 },
  ikonBesar: { width: 52, height: 52, borderRadius: 14, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  judul: { fontSize: 18, fontWeight: '800', color: colors.text },
  nama: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  isi: { fontSize: 14, lineHeight: 21, color: '#3A433A', marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tombol: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, flexGrow: 1, flexBasis: '45%' },
  tombolUtama: { backgroundColor: colors.primary, borderColor: colors.primary },
  tombolTeks: { fontSize: 14, fontWeight: '700', color: colors.primary },
  pesan: { marginTop: 12, fontSize: 13, color: colors.textMuted },
  tutup: { alignSelf: 'flex-end', marginTop: 16, paddingVertical: 8, paddingHorizontal: 12 },
  tutupTeks: { color: colors.textMuted, fontWeight: '700' },
  barisAksi: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  btn: { backgroundColor: colors.primary, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 10 },
  btnTeks: { color: '#fff', fontWeight: '800' },
  btnSek: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  btnSekTeks: { color: colors.text, fontWeight: '700' },
  pil: { position: 'absolute', right: 20, top: 16, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 999, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12 },
  pilTeks: { fontSize: 13, fontWeight: '700', color: colors.text },
  panel: { width: 900, maxWidth: '94%', height: '90%', backgroundColor: colors.background, borderRadius: 18, overflow: 'hidden' },
  panelKepala: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16 },
  toast: { position: 'absolute', right: 24, bottom: 24, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#1C2B1D', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 18 },
  toastTeks: { color: '#fff', fontSize: 13, fontWeight: '600' },
  toastBtn: { backgroundColor: 'rgba(255,255,255,0.14)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  toastBtnTeks: { color: '#fff', fontWeight: '700', fontSize: 12 },
});
