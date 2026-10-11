import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { notify } from '@/store/useNotifyStore';
import { useSyncStore } from '@/sync/SyncStore';
import { bacaPasangan, type DataPasangan } from '@/sync/SyncIdentitas';
import {
  mulaiPemasanganBaru,
  batalkanPemasangan,
  setKeputusan,
  putuskanPemasanganDesktop,
  segarkanStatusDesktop,
  mulaiServerSinkron,
} from '@/sync/SyncServer';
import KartuKoneksiDesktop from './KartuKoneksiDesktop';
import { bridge } from '@/desktop/bridge';
import { Kartu, KartuStatus, Tombol, RiwayatDanArsip, waktuLokal, u } from './UiSinkron';
import KartuKirimData from './KartuKirimData';
import DialogPutuskan from './DialogPutuskan';
import { usePermission } from '@/hooks/usePermission';

/**
 * PANEL SINKRON — DESKTOP (RC-S133.5: SINKRON MANUAL).
 *  Langkah 1 — Hubungkan HP: tampilkan QR (desktop = server), HP memindai.
 *  Langkah 2 — Kirim data: "Kirim data PC → HP" atau "Minta data HP → PC".
 *    Permintaan dari layar ini dijalankan HP setelah pemilik HP menyetujui
 *    (HP yang memulai koneksi; komputer tidak dapat menghubungi HP).
 * Kedua perangkat tetap dapat dipakai; tidak ada sinkron otomatis.
 */
export default function PanelSinkronDesktop({ ringkas = false }: { ringkas?: boolean }) {
  const sync = useSyncStore();
  const [pasangan, setPasangan] = useState<DataPasangan | null>(null);
  const [qr, setQr] = useState<{ url: string; teks: string; kedaluwarsa: number; alamat: string[]; port: number } | null>(null);
  const [sisa, setSisa] = useState(0);
  const [sibuk, setSibuk] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);
  const [lan, setLan] = useState<{ alamat: string[]; port: number }>({ alamat: [], port: 47821 });
  const [dialogPutus, setDialogPutus] = useState(false);
  const { can } = usePermission();
  const bolehKelola = can('backup', 'approve');

  const muat = useCallback(async () => {
    setPasangan(await bacaPasangan());
    await segarkanStatusDesktop().catch(() => undefined);
  }, []);

  useEffect(() => {
    void muat();
    void mulaiServerSinkron()
      .then(() => bridge()?.lan.info())
      .then((i) => i && setLan({ alamat: i.addresses, port: i.port || 47821 }))
      .catch(() => undefined);
  }, [muat, sync.status, sync.hpTerakhirTerlihat]);

  useEffect(() => {
    if (!qr) return;
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((qr.kedaluwarsa - Date.now()) / 1000));
      setSisa(s);
      if (s === 0) setQr(null);
    }, 1000);
    return () => clearInterval(t);
  }, [qr]);

  useEffect(() => {
    // QR hilang begitu HP berhasil terpasang.
    if (qr && pasangan && pasangan.dipasangPada && new Date(pasangan.dipasangPada).getTime() > qr.kedaluwarsa - 10 * 60 * 1000) setQr(null);
  }, [pasangan, qr]);

  const tampilkanQr = async () => {
    setGalat(null);
    setSibuk(true);
    try {
      const r = await mulaiPemasanganBaru();
      setQr({ url: r.qrDataUrl, teks: r.teksQr, kedaluwarsa: r.kedaluwarsa, alamat: r.alamat, port: r.port });
    } catch (e) {
      setGalat(e instanceof Error ? e.message : String(e));
    } finally {
      setSibuk(false);
    }
  };

  const putuskan = () => {
    if (!bolehKelola) return notify('Akses dibatasi', 'Hanya pengguna dengan izin Backup › Setujui (mis. Admin) yang dapat memutus sinkronisasi.', undefined, 'warning');
    setDialogPutus(true);
  };

  const minta = (k: 'PAKAI_DESKTOP' | 'PAKAI_HP') =>
    notify(
      k === 'PAKAI_DESKTOP' ? 'Kirim data PC → HP?' : 'Minta data HP → PC?',
      k === 'PAKAI_DESKTOP'
        ? `Data di ${pasangan?.peerNama ?? 'HP'} akan DIGANTI dengan data komputer ini (HP membuat backup pengaman otomatis). Permintaan muncul di HP untuk disetujui — buka KOPKU di HP pada Wi-Fi yang sama.`
        : `Data di komputer ini akan DIGANTI dengan data ${pasangan?.peerNama ?? 'HP'} (backup pengaman komputer dibuat otomatis). Permintaan muncul di HP untuk disetujui — buka KOPKU di HP pada Wi-Fi yang sama.`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Kirim permintaan', style: k === 'PAKAI_HP' ? 'destructive' : 'default', onPress: () => void setKeputusan(k).then(muat) },
      ]
    );

  const kartuQr = (
    <Kartu judul={pasangan ? 'Hubungkan HP lain / hubungkan ulang' : 'Langkah 1 — Hubungkan HP dengan QR'} ikon="qr-code-outline">
      <View style={st.qrBaris}>
        <View style={st.qrKotak}>
          {qr ? (
            <Image source={{ uri: qr.url }} style={st.qr} />
          ) : (
            <Pressable onPress={tampilkanQr} style={st.qrKosong}>
              <Ionicons name="qr-code" size={64} color={colors.textFaint} />
              <Text style={u.meta}>Klik untuk menampilkan QR</Text>
            </Pressable>
          )}
        </View>
        <View style={{ flex: 1, minWidth: 260 }}>
          {[
            'Sambungkan HP dan komputer ini ke Wi-Fi atau hotspot yang SAMA (internet tidak diperlukan).',
            'Di HP buka KOPKU › Pengaturan › Sinkron Desktop, lalu ketuk “Pindai QR Desktop”.',
            'Arahkan kamera ke QR ini. Ini hanya menghubungkan — data dikirim di langkah 2.',
          ].map((t, i) => (
            <View key={i} style={u.langkah}>
              <View style={u.nomor}>
                <Text style={u.nomorTeks}>{i + 1}</Text>
              </View>
              <Text style={u.teks}>{t}</Text>
            </View>
          ))}
          {qr && (
            <Text style={u.meta}>
              Berlaku {Math.floor(sisa / 60)}:{String(sisa % 60).padStart(2, '0')} · sekali pakai · alamat {qr.alamat.join(', ')} port {qr.port}
            </Text>
          )}
          {!!galat && <Text style={[u.meta, { color: colors.danger, marginTop: 6 }]}>{galat}</Text>}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <Tombol teks={qr ? 'Buat QR baru' : 'Tampilkan QR'} ikon="qr-code-outline" onPress={tampilkanQr} sibuk={sibuk} />
            {qr && (
              <Tombol
                teks="Salin kode"
                ikon="copy-outline"
                varian="sekunder"
                onPress={() =>
                  void (globalThis as any).navigator?.clipboard
                    ?.writeText(qr.teks)
                    .then(() => notify('Kode disalin', 'Tempel di HP: Sinkron Desktop › Masukkan kode manual.', undefined, 'success'))
                }
              />
            )}
            {qr && <Tombol teks="Sembunyikan" varian="sekunder" onPress={() => (batalkanPemasangan(), setQr(null))} />}
          </View>
          <Text style={[u.meta, { marginTop: 10 }]}>
            QR hanya untuk memasangkan perangkat — tidak berisi lisensi maupun data koperasi. Lisensi desktop diverifikasi terpisah oleh server lisensi.
          </Text>
        </View>
      </View>
    </Kartu>
  );

  const kartuKoneksi = <KartuKoneksiDesktop ringkas={ringkas} alamat={qr?.alamat ?? lan.alamat} port={qr?.port ?? lan.port} />;

  if (ringkas)
    return (
      <>
        {kartuQr}
        {kartuKoneksi}
      </>
    );

  return (
    <ScrollView contentContainerStyle={st.isi}>
      <KartuStatus
        namaHp="HP"
        namaDesktop="Komputer ini"
        subjudul={pasangan ? `Terhubung dengan ${pasangan.peerNama}` : 'Belum ada HP yang terhubung'}
        tambahan={
          pasangan ? (
            <Text style={u.meta}>
              Dihubungkan {waktuLokal(pasangan.dipasangPada)} · HP terakhir terlihat {waktuLokal(sync.hpTerakhirTerlihat)}
            </Text>
          ) : null
        }
      />

      {pasangan ? (
        <>
          {pasangan.keputusan ? (
            <Kartu judul="Menunggu HP" ikon="hourglass-outline" aksen={colors.warning}>
              <Text style={u.teks}>
                {pasangan.keputusan === 'PAKAI_DESKTOP'
                  ? `Permintaan "Kirim data PC → HP" menunggu persetujuan di ${pasangan.peerNama}.`
                  : `Permintaan "Minta data HP → PC" menunggu persetujuan di ${pasangan.peerNama}.`}{' '}
                Buka KOPKU di HP (Wi-Fi/hotspot yang sama); permintaan muncul otomatis dalam beberapa detik.
              </Text>
              <View style={{ flexDirection: 'row', marginTop: 12 }}>
                <Tombol teks="Batalkan permintaan" ikon="close-circle-outline" varian="sekunder" onPress={() => void setKeputusan(null).then(muat)} />
              </View>
            </Kartu>
          ) : null}
          <KartuKirimData
            disabled={!bolehKelola || !!pasangan.keputusan || sync.status === 'MENYINKRONKAN'}
            pilihan={[
              {
                kunci: 'pc-ke-hp',
                judul: 'Kirim data PC → HP',
                dari: 'PC',
                ke: 'HP',
                keterangan: `Data ${pasangan.peerNama} diganti dengan data komputer ini.`,
                onPress: () => minta('PAKAI_DESKTOP'),
              },
              {
                kunci: 'hp-ke-pc',
                judul: 'Minta data HP → PC',
                dari: 'HP',
                ke: 'PC',
                keterangan: 'Data komputer ini diganti dengan data HP.',
                onPress: () => minta('PAKAI_HP'),
              },
            ]}
            catatan={
              (bolehKelola ? '' : 'Hanya pengguna dengan izin Backup › Setujui (mis. Admin) yang dapat mengirim data. ') +
              'HP juga dapat memulai pengiriman dari menu Pengaturan › Sinkron Desktop di HP. Hanya HP dengan lisensi KOPKU yang SAMA.'
            }
          />
        </>
      ) : null}

      {kartuQr}

      {kartuKoneksi}

      <RiwayatDanArsip />

      <Kartu judul="Cara kerja & keamanan" ikon="shield-checkmark-outline">
        {[
          'Semua data tersimpan lokal di komputer ini; aplikasi berjalan penuh tanpa internet.',
          'Langkah 1 hanya MENGHUBUNGKAN HP dan komputer lewat Wi-Fi lokal/hotspot. Tidak ada data yang berubah.',
          'Langkah 2 mengirim SALINAN UTUH data ke arah yang Anda pilih. Data di perangkat penerima diganti seluruhnya; tidak ada penggabungan otomatis.',
          'Kedua perangkat tetap dapat dipakai. Agar tidak ada transaksi yang hilang, catat transaksi di satu perangkat saja, lalu kirim ke perangkat lain.',
          'Sebelum data diganti, backup pengaman dibuat otomatis di perangkat penerima (menu Backup & Restore).',
          'Hanya HP berlisensi SAMA. Lalu lintas dienkripsi XChaCha20-Poly1305 dengan kunci yang dibuat saat memindai QR.',
        ].map((t, i) => (
          <View key={i} style={u.langkah}>
            <Ionicons name="checkmark" size={16} color={colors.primary} />
            <Text style={u.teks}>{t}</Text>
          </View>
        ))}
      </Kartu>

      {pasangan && (
        <View style={{ alignItems: 'flex-start', marginBottom: 30 }}>
          <Tombol teks="Putuskan hubungan HP" ikon="unlink-outline" varian="bahaya" onPress={putuskan} disabled={!bolehKelola} />
          {!bolehKelola && <Text style={[u.meta, { marginTop: 6 }]}>Hanya pengguna dengan izin Backup › Setujui (mis. Admin) yang dapat memutus sinkronisasi.</Text>}
        </View>
      )}

      <DialogPutuskan
        terlihat={dialogPutus}
        judul="Putuskan hubungan dengan HP?"
        namaPerangkat={pasangan?.peerNama}
        onBatal={() => setDialogPutus(false)}
        onPutuskan={async () => {
          try {
            await putuskanPemasanganDesktop();
            setDialogPutus(false);
            await muat();
            notify('Hubungan diputus', 'Tampilkan QR dan pindai dari HP untuk menghubungkan lagi. Data tidak berubah.', undefined, 'success');
          } catch (e) {
            setDialogPutus(false);
            notify('Gagal memutus', e instanceof Error ? e.message : String(e), undefined, 'error');
          }
        }}
        akibat={[
          { ikon: 'unlink-outline', teks: 'HP tidak dapat lagi mengirim/menerima data dari komputer ini sampai dihubungkan ulang.' },
          { ikon: 'albums-outline', teks: 'Data di komputer ini dan di HP tidak dihapus dan tidak berubah.' },
          { ikon: 'qr-code-outline', teks: 'Untuk menghubungkan lagi: Tampilkan QR di sini lalu pindai dari HP.' },
        ]}
      />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  isi: { padding: 20, paddingBottom: 40 },
  qrBaris: { flexDirection: 'row', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' },
  qrKotak: { width: 260, height: 260, borderRadius: 16, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', padding: 10 },
  qr: { width: 240, height: 240 },
  qrKosong: { alignItems: 'center', gap: 8 },
});
