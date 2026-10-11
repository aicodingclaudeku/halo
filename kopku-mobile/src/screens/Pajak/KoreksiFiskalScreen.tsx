import React, { useCallback, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import AppTextInput from '@/components/AppTextInput';
import CurrencyInput from '@/components/CurrencyInput';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  hapusKoreksiFiskal,
  hitungPphBadanTahun,
  JenisKoreksiFiskal,
  KoreksiFiskal,
  listKoreksiFiskal,
  nyatakanRekonsiliasiFiskal,
  PerhitunganPphBadan,
  tambahKoreksiFiskal,
} from '@/services/PajakBadanService';
import { BarisNilai, Catatan, Kartu, LabelGrup, Memuat, Segmen, TombolSimpan, pajakStyles as ps } from './PajakUi';

/**
 * RC-S87 — Koreksi fiskal sebagai DATA yang diaudit (uraian, nilai
 * komersial & fiskal, alasan, referensi aturan, user, waktu). Aplikasi
 * TIDAK mengarang koreksi. Selisih dihitung service dari dua nilai; setiap
 * perubahan membatalkan pernyataan "rekonsiliasi lengkap" sebelumnya.
 */
export default function KoreksiFiskalScreen() {
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const tahun: number = route.params?.tahun ?? Number(getTanggalLokalHariIni().slice(0, 4)) - 1;
  const [daftar, setDaftar] = useState<KoreksiFiskal[] | null>(null);
  const [hitung, setHitung] = useState<PerhitunganPphBadan | null>(null);
  const [jenis, setJenis] = useState<JenisKoreksiFiskal | null>(null);
  const [uraian, setUraian] = useState('');
  const [komersial, setKomersial] = useState<number | ''>('');
  const [fiskal, setFiskal] = useState<number | ''>('');
  const [alasan, setAlasan] = useState('');
  const [referensi, setReferensi] = useState('');
  const [dipilih, setDipilih] = useState<KoreksiFiskal | null>(null);
  const [alasanHapus, setAlasanHapus] = useState('');
  const [memproses, setMemproses] = useState(false);

  const muat = useCallback(async () => {
    try {
      const [d, h] = await Promise.all([listKoreksiFiskal(tahun), hitungPphBadanTahun(tahun)]);
      setDaftar(d);
      setHitung(h);
    } catch (e) {
      setDaftar([]);
      notify('Gagal memuat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  }, [tahun]);
  useFocusRefresh(muat, [muat]);

  const jalankan = async (aksi: () => Promise<unknown>, pesan: string) => {
    setMemproses(true);
    try {
      await aksi();
      notify('Tersimpan', pesan);
      muat();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemproses(false);
    }
  };

  const tambah = () =>
    currentUser && jenis
      ? jalankan(async () => {
          await tambahKoreksiFiskal({
            tahunPajak: tahun,
            jenis,
            uraian,
            nilaiKomersial: komersial === '' ? 0 : komersial,
            nilaiFiskal: fiskal === '' ? 0 : fiskal,
            alasan,
            referensiAturan: referensi,
            userId: currentUser.id,
          });
          setUraian('');
          setKomersial('');
          setFiskal('');
          setAlasan('');
          setReferensi('');
        }, 'Koreksi fiskal ditambahkan.')
      : undefined;

  const hapus = () =>
    currentUser && dipilih
      ? jalankan(async () => {
          await hapusKoreksiFiskal({ id: dipilih.id, alasan: alasanHapus, userId: currentUser.id });
          setDipilih(null);
          setAlasanHapus('');
        }, 'Koreksi fiskal dihapus (tercatat).')
      : undefined;

  const lengkap = () =>
    currentUser ? jalankan(() => nyatakanRekonsiliasiFiskal({ tahun, lengkap: true, userId: currentUser.id }), 'Rekonsiliasi fiskal dinyatakan lengkap.') : undefined;

  if (!daftar || !hitung) return <Memuat />;
  const terkunci = hitung.status === 'TERKUNCI';

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView style={ps.layar} contentContainerStyle={ps.isi} keyboardShouldPersistTaps="handled">
        <Text style={ps.intro}>Koreksi fiskal tahun pajak {tahun}. Positif menambah PKP, negatif mengurangi PKP.</Text>

        <Kartu judul="Ringkasan">
          <BarisNilai label="Laba komersial" nilai={formatRupiah(hitung.labaKomersial)} />
          <BarisNilai label="Koreksi positif" nilai={formatRupiah(hitung.koreksiPositif)} redam />
          <BarisNilai label="Koreksi negatif" nilai={`(${formatRupiah(hitung.koreksiNegatif)})`} redam />
          <BarisNilai label="Status rekonsiliasi" nilai={hitung.rekonsiliasi.lengkap ? 'Lengkap' : 'Belum lengkap'} tebal garisAtas />
        </Kartu>

        {terkunci ? <Catatan nada="peringatan">Perhitungan tahun ini sudah dikunci. Batalkan perhitungan di PPh Badan sebelum mengubah koreksi.</Catatan> : null}

        <LabelGrup>Daftar koreksi</LabelGrup>
        {daftar.length === 0 ? <Catatan>Belum ada koreksi fiskal. Bila memang tidak ada, nyatakan rekonsiliasi lengkap.</Catatan> : null}
        {daftar.map((k) => (
          <TouchableOpacity key={k.id} onPress={() => setDipilih(k)} accessibilityRole="button" activeOpacity={0.7}>
            <Kartu judul={`${k.jenis === 'POSITIF' ? '+' : '−'} ${k.uraian}`}>
              <BarisNilai label="Nilai komersial" nilai={formatRupiah(k.nilaiKomersial)} redam />
              <BarisNilai label="Nilai fiskal" nilai={formatRupiah(k.nilaiFiskal)} redam />
              <BarisNilai label="Koreksi" nilai={formatRupiah(k.nilaiKoreksi)} tebal />
              <Text style={ps.hint}>
                {k.alasan} · {k.referensiAturan} · {k.createdBy} · {k.createdAt.slice(0, 10)}
              </Text>
            </Kartu>
          </TouchableOpacity>
        ))}

        {dipilih && !terkunci ? (
          <Kartu judul={`Hapus: ${dipilih.uraian}`}>
            <AppTextInput label="Alasan penghapusan" required inputType="multiline" multiline value={alasanHapus} onChangeText={setAlasanHapus} />
            <TombolSimpan label="Hapus Koreksi" onPress={() => hapus()} memproses={memproses} nonaktif={!alasanHapus.trim()} ikon="trash-outline" />
          </Kartu>
        ) : null}

        {!terkunci ? (
          <>
            <LabelGrup>Tambah koreksi</LabelGrup>
            <View style={ps.field}>
              <Text style={ps.label}>Jenis *</Text>
              <Segmen<JenisKoreksiFiskal>
                opsi={[
                  { nilai: 'POSITIF', label: 'Positif (+PKP)' },
                  { nilai: 'NEGATIF', label: 'Negatif (−PKP)' },
                ]}
                nilai={jenis}
                onChange={setJenis}
              />
            </View>
            <AppTextInput label="Uraian" required value={uraian} onChangeText={setUraian} placeholder="Mis. sumbangan, natura, penghasilan final" />
            <View style={ps.field}>
              <Text style={ps.label}>Nilai komersial *</Text>
              <CurrencyInput value={komersial} onChangeValue={setKomersial} />
            </View>
            <View style={ps.field}>
              <Text style={ps.label}>Nilai fiskal *</Text>
              <CurrencyInput value={fiskal} onChangeValue={setFiskal} />
            </View>
            <AppTextInput label="Alasan" required inputType="multiline" multiline value={alasan} onChangeText={setAlasan} />
            <AppTextInput label="Referensi aturan" required value={referensi} onChangeText={setReferensi} placeholder="Mis. UU PPh Pasal 9 ayat (1)" />
            <TombolSimpan label="Tambah Koreksi" onPress={() => tambah()} memproses={memproses} nonaktif={!jenis} ikon="add-circle-outline" />

            <View style={{ marginTop: 16 }}>
              <TombolSimpan label="Nyatakan Rekonsiliasi Lengkap" onPress={() => lengkap()} memproses={memproses} ikon="checkmark-done-outline" />
            </View>
          </>
        ) : null}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}
