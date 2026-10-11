import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { notify } from '@/store/useNotifyStore';
import { useSyncStore } from '@/sync/SyncStore';
import { bridge, type StatusFirewall } from '@/desktop/bridge';
import { Kartu, Tombol, waktuLokal, u } from './UiSinkron';

/**
 * KONEKSI & FIREWALL (desktop).
 *
 * Gejala di HP: "Tidak dapat menghubungi desktop … Aborted" = permintaan
 * HP tidak pernah dijawab. Penyebab tersering, berurutan:
 *   1. Windows Firewall memblokir KOPKU Desktop (dialog izin ditutup /
 *      jaringan Publik) → tombol "Izinkan di Firewall" memperbaikinya.
 *   2. Wi-Fi memakai isolasi klien (Wi-Fi kantor/tamu) → pakai hotspot HP.
 *   3. Wi-Fi tanpa internet + data seluler HP menyala → Android mengirim
 *      lewat data seluler → matikan data seluler sementara.
 * Kartu ini juga memberi alamat uji yang dapat dibuka di browser HP; saat
 * dibuka, desktop langsung menampilkan "HP berhasil menjangkau desktop".
 */
let tawaranFirewallSudahTampil = false;

export default function KartuKoneksiDesktop({ ringkas = false, alamat, port }: { ringkas?: boolean; alamat: string[]; port: number }) {
  const b = bridge();
  const [fw, setFw] = useState<StatusFirewall | null>(null);
  const [memeriksa, setMemeriksa] = useState(false);
  const [memperbaiki, setMemperbaiki] = useState(false);
  const [ping, setPing] = useState<{ ip: string; waktu: string } | null>(null);
  const setHpTerlihat = useSyncStore((s) => s.setHpTerlihat);
  const hidup = useRef(true);

  const periksa = useCallback(async () => {
    if (!b) return;
    setMemeriksa(true);
    try {
      const st = await b.firewall.status();
      if (hidup.current) setFw(st);
      return st;
    } catch {
      return null;
    } finally {
      if (hidup.current) setMemeriksa(false);
    }
  }, [b]);

  const perbaiki = useCallback(async () => {
    if (!b) return;
    setMemperbaiki(true);
    try {
      const r = await b.firewall.perbaiki();
      if (r.ok) {
        if (r.status) setFw(r.status);
        else await periksa();
        notify('Firewall diizinkan', 'KOPKU Desktop kini dapat menerima sinkron dari HP di jaringan lokal. Pindai ulang QR di HP.', undefined, 'success');
      } else {
        notify('Firewall belum diubah', r.pesan ?? 'Persetujuan Administrator diperlukan.', undefined, r.dibatalkan ? 'warning' : 'error');
      }
    } catch (e) {
      notify('Firewall', e instanceof Error ? e.message : String(e), undefined, 'error');
    } finally {
      setMemperbaiki(false);
    }
  }, [b, periksa]);

  useEffect(() => {
    hidup.current = true;
    if (!b) return;
    const lepas = b.lan.onPing((info) => {
      setPing(info);
      setHpTerlihat(info.waktu);
    });
    void periksa().then((st) => {
      // Tawarkan sekali per sesi bila firewall jelas perlu diperbaiki.
      if (st?.didukung && st.perluPerbaikan && !st.tidakDiketahui && !tawaranFirewallSudahTampil) {
        tawaranFirewallSudahTampil = true;
        notify(
          'Izinkan sinkron di Windows Firewall?',
          (st.aturanBlokir ?? 0) > 0
            ? 'Windows Firewall sedang MEMBLOKIR KOPKU Desktop, sehingga HP tidak dapat terhubung ("Aborted"). Windows akan meminta persetujuan Administrator untuk memperbaikinya.'
            : 'Agar HP dapat terhubung, KOPKU Desktop perlu diizinkan menerima koneksi dari jaringan lokal. Windows akan meminta persetujuan Administrator.',
          [
            { text: 'Nanti', style: 'cancel' },
            { text: 'Izinkan sekarang', onPress: () => void perbaiki() },
          ],
          'warning'
        );
      }
    });
    return () => {
      hidup.current = false;
      lepas?.();
    };
  }, [b, periksa, perbaiki, setHpTerlihat]);

  if (!b) return null;

  const windows = fw?.didukung;
  const publik = (fw?.profil ?? []).filter((p) => /public/i.test(p.kategori));
  const bermasalah = !!fw?.didukung && !!fw.perluPerbaikan;
  const urlUji = alamat.map((a) => `http://${a}:${port}/kopku/v1/ping`);

  const barisFirewall = windows ? (
    <View style={[st.baris, { backgroundColor: bermasalah ? colors.dangerBg : colors.primaryLight }]}>
      {memeriksa && !fw ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        <Ionicons name={bermasalah ? 'shield-outline' : 'shield-checkmark'} size={22} color={bermasalah ? colors.danger : colors.primary} />
      )}
      <View style={{ flex: 1 }}>
        <Text style={[st.judul, { color: bermasalah ? colors.danger : colors.primary }]}>
          {!fw
            ? 'Memeriksa Windows Firewall…'
            : fw.tidakDiketahui
              ? 'Status Windows Firewall tidak dapat dibaca'
              : (fw.aturanBlokir ?? 0) > 0
                ? 'Windows Firewall MEMBLOKIR KOPKU Desktop'
                : bermasalah
                  ? 'KOPKU Desktop belum diizinkan di Windows Firewall'
                  : 'Windows Firewall mengizinkan sinkron HP'}
        </Text>
        <Text style={u.meta}>
          {bermasalah
            ? 'Inilah penyebab HP menampilkan "Tidak dapat menghubungi desktop … Aborted". Klik tombol di samping lalu setujui dialog Windows.'
            : 'Port 47821–47840 terbuka hanya untuk perangkat di jaringan lokal yang sama.'}
          {publik.length > 0 ? ` Jaringan ${publik.map((p) => p.nama).join(', ')} ditandai Publik — aturan KOPKU tetap berlaku.` : ''}
        </Text>
      </View>
      {bermasalah && <Tombol teks="Izinkan di Firewall" ikon="shield-checkmark-outline" onPress={() => void perbaiki()} sibuk={memperbaiki} />}
      {!bermasalah && fw && <Tombol teks="Periksa ulang" varian="sekunder" onPress={() => void periksa()} sibuk={memeriksa} />}
    </View>
  ) : null;

  const barisPing = (
    <View style={[st.baris, { backgroundColor: ping ? colors.primaryLight : '#F4F6F4' }]}>
      <Ionicons name={ping ? 'checkmark-circle' : 'globe-outline'} size={22} color={ping ? colors.primary : colors.textMuted} />
      <View style={{ flex: 1 }}>
        <Text style={[st.judul, { color: ping ? colors.primary : colors.text }]}>
          {ping ? `HP (${ping.ip}) berhasil menjangkau desktop · ${waktuLokal(ping.waktu)}` : 'Uji koneksi dari HP'}
        </Text>
        <Text style={u.meta}>Buka alamat ini di browser HP (Chrome). Bila muncul tulisan “kopku”, jaringan sudah tembus:</Text>
        {urlUji.map((x) => (
          <Text key={x} selectable style={st.url}>
            {x}
          </Text>
        ))}
      </View>
    </View>
  );

  if (ringkas) {
    return (
      <View style={{ marginBottom: 12 }}>
        {barisFirewall}
        {barisPing}
      </View>
    );
  }

  return (
    <Kartu judul="Koneksi & firewall" ikon="wifi-outline" aksen={bermasalah ? colors.danger : undefined}>
      {barisFirewall}
      {barisPing}
      <Text style={[u.kartuJudul, { fontSize: 13, marginTop: 6, marginBottom: 6 }]}>Masih "Aborted" / tidak terhubung?</Text>
      {[
        'Pastikan HP dan komputer tersambung ke Wi-Fi yang SAMA (alamat HP dan komputer biasanya sama-sama diawali 192.168.x).',
        'Wi-Fi kantor/tamu sering memakai isolasi klien sehingga perangkat tidak bisa saling terhubung — nyalakan hotspot di HP lalu sambungkan komputer ke hotspot itu.',
        'Bila Wi-Fi tidak punya internet, matikan data seluler HP sementara; Android kadang mengirim lewat data seluler, bukan Wi-Fi.',
        'Antivirus pihak ketiga (mis. ESET, Avast) memiliki firewall sendiri — izinkan "KOPKU Desktop" di sana juga.',
      ].map((t, i) => (
        <View key={i} style={u.langkah}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={u.teks}>{t}</Text>
        </View>
      ))}
    </Kartu>
  );
}

const st = StyleSheet.create({
  baris: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, marginBottom: 10, flexWrap: 'wrap' },
  judul: { fontSize: 14, fontWeight: '800', marginBottom: 2 },
  url: { fontSize: 13, fontWeight: '700', color: colors.text, fontFamily: 'monospace', marginTop: 2 },
});
