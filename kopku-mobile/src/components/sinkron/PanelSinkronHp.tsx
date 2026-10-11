import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Modal, Pressable, StyleSheet, ScrollView } from 'react-native';
import FocusTextInput from '@/components/FocusTextInput';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { notify } from '@/store/useNotifyStore';
import { usePermission } from '@/hooks/usePermission';
import { useSyncStore } from '@/sync/SyncStore';
import { bacaPasangan, type DataPasangan } from '@/sync/SyncIdentitas';
import { sponsoriLisensiDesktop, pasangDenganKode, ambilDataDesktop, kirimDataHp, infoDesktop, putuskanPemasanganHp, segarkanStatusHp } from '@/sync/SyncKlien';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { Kartu, KartuStatus, Tombol, RiwayatDanArsip, waktuLokal, u } from './UiSinkron';
import KartuKirimData from './KartuKirimData';
import DialogPutuskan from './DialogPutuskan';

/**
 * PANEL SINKRON — HP (RC-S133.5: SINKRON MANUAL).
 *  Langkah 1 — Hubungkan: pindai QR KOPKU Desktop (hanya menghubungkan,
 *              tidak mengubah data apa pun).
 *  Langkah 2 — Kirim data: "Kirim data HP → PC" atau "Ambil data PC → HP".
 * Kedua perangkat tetap dapat dipakai; tidak ada sinkron otomatis.
 */
export default function PanelSinkronHp() {
  const sync = useSyncStore();
  const { can } = usePermission();
  const bolehKelola = can('backup', 'approve');
  const [pasangan, setPasangan] = useState<DataPasangan | null>(null);
  const [pindai, setPindai] = useState(false);
  const [manual, setManual] = useState(false);
  const [kode, setKode] = useState('');
  const [sibuk, setSibuk] = useState<string | null>(null);
  const [infoPc, setInfoPc] = useState<any>(null);
  const [dialogPutus, setDialogPutus] = useState(false);
  const [izin, mintaIzin] = useCameraPermissions();
  const sudahPindai = useRef(false);

  const muat = useCallback(async () => {
    const p = await bacaPasangan();
    setPasangan(p);
    await segarkanStatusHp();
    if (p) setInfoPc(await infoDesktop().catch(() => null));
  }, []);

  useEffect(() => {
    void muat();
  }, [muat, sync.status]);

  const jalankan = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setSibuk(label);
    try {
      await fn();
      return true;
    } catch (e) {
      notify('Sinkron', e instanceof Error ? e.message : String(e), undefined, 'error');
      return false;
    } finally {
      setSibuk(null);
      await muat();
    }
  };

  // RC-S133.5 — memindai QR HANYA menghubungkan (langkah 1).
  const prosesKode = async (teks: string) => {
    setPindai(false);
    setManual(false);
    await jalankan('pasang', async () => {
      const r = await pasangDenganKode(teks);
      notify(
        'Terhubung',
        `HP ini terhubung dengan ${r.desktopNama}. Belum ada data yang dikirim — pilih arah kirim data di langkah 2.`,
        undefined,
        'success'
      );
    });
  };

  const bukaKamera = async () => {
    if (!izin?.granted) {
      const r = await mintaIzin();
      if (!r.granted) return notify('Izin kamera', 'Izin kamera diperlukan untuk memindai QR. Anda juga dapat memasukkan kode secara manual.', undefined, 'warning');
    }
    sudahPindai.current = false;
    setPindai(true);
  };

  const bukaPemindai = () => void bukaKamera();
  const bukaManual = () => setManual(true);

  const ringkasPc = infoPc
    ? infoPc.setupSelesai
      ? ` Komputer berisi data “${infoPc.namaKoperasi}” (${infoPc.jumlahAnggota} anggota, ${infoPc.jumlahJurnal} jurnal).`
      : ' Komputer masih kosong.'
    : '';

  const kirimKePc = () =>
    notify(
      'Kirim data HP → PC?',
      'Data di komputer akan DIGANTI dengan data HP ini.' + ringkasPc + ' Komputer membuat backup pengaman otomatis dan meminta persetujuan di layarnya bila sudah berisi data. Data HP tidak berubah.',
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Kirim', onPress: () => void jalankan('kirim', () => kirimDataHp('MANUAL')) },
      ]
    );

  const ambilDariPc = () =>
    notify(
      'Ambil data PC → HP?',
      'Data di HP ini akan DIGANTI dengan data komputer.' + ringkasPc + ' HP membuat backup pengaman otomatis lebih dulu (Backup & Restore). Data komputer tidak berubah.',
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Ganti data HP', style: 'destructive', onPress: () => void jalankan('ambil', () => ambilDataDesktop('MANUAL')) },
      ]
    );

  const putuskan = () => setDialogPutus(true);

  return (
    <ScrollView contentContainerStyle={st.isi} keyboardShouldPersistTaps="handled">
      <KartuStatus
        namaHp="HP ini"
        namaDesktop="Desktop"
        subjudul={pasangan ? `Terhubung dengan ${pasangan.peerNama}` : 'HP belum terhubung dengan komputer'}
      />

      {!pasangan && (
        <Kartu judul="Langkah 1 — Hubungkan dengan KOPKU Desktop" ikon="qr-code-outline">
          {[
            'Sambungkan HP dan komputer ke Wi-Fi atau hotspot yang sama. Internet tidak diperlukan.',
            'Di komputer buka KOPKU Desktop › Sinkron HP › Tampilkan QR.',
            'Ketuk tombol di bawah dan arahkan kamera ke QR. Ini hanya menghubungkan — belum ada data yang dikirim.',
          ].map((t, i) => (
            <View key={i} style={u.langkah}>
              <View style={u.nomor}>
                <Text style={u.nomorTeks}>{i + 1}</Text>
              </View>
              <Text style={u.teks}>{t}</Text>
            </View>
          ))}
          <View style={{ gap: 10, marginTop: 6 }}>
            <Tombol teks="Pindai QR Desktop" ikon="scan-outline" onPress={bukaPemindai} sibuk={sibuk === 'pasang'} disabled={!bolehKelola} />
            <Tombol teks="Masukkan kode manual" ikon="keypad-outline" varian="sekunder" onPress={bukaManual} disabled={!bolehKelola} />
          </View>
          {!bolehKelola && <Text style={[u.meta, { marginTop: 8 }]}>Hanya pengguna dengan izin Backup › Setujui (mis. Admin) yang dapat menghubungkan perangkat.</Text>}
        </Kartu>
      )}

      {pasangan?.diputusDesktop && (
        <Kartu judul="Diputus dari KOPKU Desktop" ikon="unlink-outline" aksen={colors.danger}>
          <Text style={u.teks}>Komputer telah memutus hubungan dengan HP ini. Data di HP tidak berubah dan HP tetap dapat dipakai.</Text>
          <View style={{ gap: 10, marginTop: 12 }}>
            <Tombol teks="Pindai QR desktop lagi" ikon="scan-outline" onPress={bukaPemindai} sibuk={sibuk === 'pasang'} disabled={!bolehKelola || !!sibuk} />
            <Tombol teks="Hapus hubungan di HP" ikon="unlink-outline" varian="bahaya" onPress={putuskan} disabled={!bolehKelola || !!sibuk} />
          </View>
        </Kartu>
      )}

      {pasangan && !pasangan.diputusDesktop && (
        <>
          <Kartu judul="Langkah 1 — Terhubung" ikon="link-outline" aksen={colors.success}>
            <Text style={u.teks}>
              HP ini terhubung dengan <Text style={{ fontWeight: '800' }}>{pasangan.peerNama}</Text>.{ringkasPc}
            </Text>
            <Text style={u.meta}>
              Alamat komputer: {pasangan.alamat.join(', ')}:{pasangan.port} · dihubungkan {waktuLokal(pasangan.dipasangPada)}
            </Text>
            <Text style={u.meta}>Hanya dengan komputer yang memakai lisensi KOPKU yang SAMA.</Text>
            <View style={{ marginTop: 10 }}>
              <Tombol teks="Pindai ulang QR (alamat komputer berubah)" ikon="scan-outline" varian="sekunder" onPress={bukaPemindai} disabled={!bolehKelola || !!sibuk} />
            </View>
          </Kartu>
          <KartuKirimData
            disabled={!bolehKelola || !!sibuk}
            pilihan={[
              {
                kunci: 'hp-ke-pc',
                judul: 'Kirim data HP → PC',
                dari: 'HP',
                ke: 'PC',
                keterangan: 'Data komputer diganti dengan data HP ini.',
                onPress: kirimKePc,
                sibuk: sibuk === 'kirim',
              },
              {
                kunci: 'pc-ke-hp',
                judul: 'Ambil data PC → HP',
                dari: 'PC',
                ke: 'HP',
                keterangan: 'Data HP ini diganti dengan data komputer.',
                onPress: ambilDariPc,
                sibuk: sibuk === 'ambil',
              },
            ]}
            catatan={
              (bolehKelola ? '' : 'Hanya pengguna dengan izin Backup › Setujui (mis. Admin) yang dapat mengirim data. ') +
              'Permintaan yang dibuat di layar komputer juga muncul di HP ini untuk disetujui selama KOPKU terbuka.'
            }
          />
        </>
      )}

      {pasangan && !pasangan.diputusDesktop && infoPc?.perluLisensi && (
        <Kartu judul="Lisensi desktop" ikon="key-outline" aksen={colors.warning}>
          <Text style={u.teks}>
            Desktop belum berlisensi. HP ini dapat mengaktifkannya otomatis memakai lisensi HP (1 lisensi = 1 HP + 1 Laptop/PC). Komputer perlu tersambung internet
            sekali; License Key tidak perlu diketik.
          </Text>
          <View style={{ marginTop: 12 }}>
            <Tombol
              teks="Aktifkan lisensi desktop dari HP"
              ikon="key-outline"
              sibuk={sibuk === 'lisensi'}
              disabled={!!sibuk}
              onPress={() =>
                void jalankan('lisensi', async () => {
                  const r = await sponsoriLisensiDesktop(true);
                  if (r.dikirim || r.pesan) notify('Lisensi desktop', r.pesan ?? 'Selesai.', undefined, r.ok ? 'success' : 'error');
                })
              }
            />
          </View>
        </Kartu>
      )}

      {pasangan && <RiwayatDanArsip />}

      {pasangan && (
        <View style={{ marginBottom: 30 }}>
          <Tombol teks="Putuskan hubungan" ikon="unlink-outline" varian="bahaya" onPress={putuskan} disabled={!bolehKelola} />
        </View>
      )}

      <DialogPutuskan
        terlihat={dialogPutus}
        judul="Putuskan hubungan dengan komputer?"
        namaPerangkat={pasangan?.peerNama}
        onBatal={() => setDialogPutus(false)}
        onPutuskan={async () => {
          setDialogPutus(false);
          if (await jalankan('putus', putuskanPemasanganHp))
            notify('Hubungan diputus', 'Data di HP tetap ada. Pindai QR komputer untuk menghubungkan lagi.', undefined, 'success');
        }}
        akibat={[
          { ikon: 'unlink-outline', teks: 'Hubungan HP dengan komputer dilepas (di komputer juga, bila terjangkau).' },
          { ikon: 'albums-outline', teks: 'Data di HP dan di komputer TIDAK dihapus dan tidak berubah.' },
          { ikon: 'scan-outline', teks: 'Untuk menghubungkan lagi, pindai QR di layar Sinkron HP komputer.' },
        ]}
      />

      <Modal visible={pindai} animationType="slide" onRequestClose={() => setPindai(false)}>
        <View style={st.kamera}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }: { data: string }) => {
              if (sudahPindai.current || !data?.startsWith('KOPKU1:')) return;
              sudahPindai.current = true;
              void prosesKode(data);
            }}
          />
          <View style={st.bingkaiPindai} />
          <View style={st.kameraBawah}>
            <Text style={st.kameraTeks}>Arahkan kamera ke QR di layar KOPKU Desktop</Text>
            <Pressable style={st.kameraTutup} onPress={() => setPindai(false)}>
              <Ionicons name="close" size={22} color="#fff" />
              <Text style={st.kameraTeks}>Tutup</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={manual} transparent animationType="fade" onRequestClose={() => setManual(false)}>
        <AreaAmanKeyboard varian="dialog" style={st.latar}>
          <ScrollView contentContainerStyle={st.latarIsi} keyboardShouldPersistTaps="handled">
          <View style={st.dialog}>
            <Text style={u.kartuJudul}>Kode pemasangan</Text>
            <Text style={[u.meta, { marginVertical: 8 }]}>Tempel teks kode yang diawali “KOPKU1:” (dapat disalin dari desktop).</Text>
            <FocusTextInput value={kode} onChangeText={setKode} multiline placeholder="KOPKU1:..." style={st.input} autoCapitalize="none" autoCorrect={false} />
            <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
              <Tombol teks="Batal" varian="sekunder" onPress={() => setManual(false)} />
              <Tombol teks="Pasangkan" onPress={() => void prosesKode(kode)} disabled={!kode.trim()} />
            </View>
          </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  isi: { padding: 16, paddingBottom: 40 },
  kamera: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  bingkaiPindai: { width: 250, height: 250, borderWidth: 3, borderColor: '#fff', borderRadius: 24 },
  kameraBawah: { position: 'absolute', bottom: 48, left: 24, right: 24, alignItems: 'center', gap: 16 },
  kameraTeks: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center' },
  kameraTutup: { flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.18)', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 24 },
  latar: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  latarIsi: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  dialog: { backgroundColor: '#fff', borderRadius: 16, padding: 18 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, minHeight: 90, padding: 10, fontSize: 13, textAlignVertical: 'top' },
});
