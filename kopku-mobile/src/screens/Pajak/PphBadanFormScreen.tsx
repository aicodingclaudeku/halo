import React, { useCallback, useMemo, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { ScrollView, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import AppTextInput from '@/components/AppTextInput';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  batalkanPerhitunganPphBadan,
  hitungPphBadanTahun,
  kunciPerhitunganPphBadan,
  LABEL_STATUS_PPH_BADAN,
  PerhitunganPphBadan,
} from '@/services/PajakBadanService';
import { KODE_UTANG_PPH_29, LABEL_REZIM } from '@/config/pajakPolicy';
import { BarisJurnal, BarisNilai, Catatan, Kartu, KartuRincian, Memuat, PratinjauJurnal, Segmen, TombolSimpan, pajakStyles as ps } from './PajakUi';

/**
 * RC-S87 — PPh Badan akhir tahun dari TAX ENGINE.
 *
 * Tidak ada lagi field "PPh terutang". Seluruh angka dihitung service:
 * Omzet → Laba komersial → Koreksi fiskal → PKP → PKP fasilitas Pasal 31E
 * (11%) → PKP non-fasilitas (22%) → Total PPh Badan → Kredit → PPh 29.
 * Layar hanya menampilkan dan meminta konfirmasi (Review → Kunci). Jalur
 * input manual lama (`catatPphBadan`) tetap ada di service untuk
 * kompatibilitas, tidak ditawarkan di layar.
 */
export default function PphBadanFormScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const hariIni = getTanggalLokalHariIni();
  const tahunIni = Number(hariIni.slice(0, 4));
  const opsiTahun = useMemo(() => [tahunIni - 2, tahunIni - 1, tahunIni].map(String), [tahunIni]);
  const [tahun, setTahun] = useState(String(tahunIni - 1));
  const [data, setData] = useState<PerhitunganPphBadan | null>(null);
  const [review, setReview] = useState(false);
  const [memproses, setMemproses] = useState(false);
  const [alasanBatal, setAlasanBatal] = useState('');

  const muat = useCallback(async () => {
    setData(null);
    setReview(false);
    try {
      setData(await hitungPphBadanTahun(Number(tahun)));
    } catch (e) {
      notify('Gagal menghitung', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  }, [tahun]);
  useFocusRefresh(muat, [muat]);

  const kunci = async () => {
    if (!currentUser || !data) return;
    setMemproses(true);
    try {
      const h = await kunciPerhitunganPphBadan({ tahun: Number(tahun), createdBy: currentUser.id });
      const tombol =
        h.hasil.pph29 > 0
          ? [
              { text: 'Nanti', style: 'cancel' as const, onPress: () => muat() },
              { text: 'Setor PPh 29', onPress: () => navigation.replace('SetorPajakForm', { kodeAkun: KODE_UTANG_PPH_29 }) },
            ]
          : [{ text: 'OK', onPress: () => muat() }];
      notify('Perhitungan dikunci', `PPh Badan ${tahun}: ${formatRupiah(h.hasil.totalPphBadan)}. PPh 29: ${formatRupiah(h.hasil.pph29)}.`, tombol);
    } catch (e) {
      notify('Gagal mengunci', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemproses(false);
    }
  };

  const batal = async () => {
    if (!currentUser) return;
    setMemproses(true);
    try {
      await batalkanPerhitunganPphBadan({ tahun: Number(tahun), alasan: alasanBatal, userId: currentUser.id });
      setAlasanBatal('');
      notify('Perhitungan dibatalkan', 'Jurnal pembalik dibuat; snapshot lama tetap tersimpan sebagai jejak audit.');
      muat();
    } catch (e) {
      notify('Gagal membatalkan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemproses(false);
    }
  };

  const h = data?.snapshot?.hasil ?? data?.hasil ?? null;
  const nada = data?.status === 'SIAP_DIKUNCI' || data?.status === 'TERKUNCI' ? 'sukses' : data?.status === 'TAHUN_PAJAK_BELUM_BERAKHIR' ? 'peringatan' : 'galat';

  const barisJurnal: BarisJurnal[] = [];
  if (h && data?.status === 'SIAP_DIKUNCI' && h.totalPphBadan > 0) {
    barisJurnal.push({ akun: 'Beban Pajak Penghasilan', debit: h.totalPphBadan, kredit: 0 });
    if (h.kredit.pph25 > 0) barisJurnal.push({ akun: 'Pajak Dibayar Dimuka (PPh 25)', debit: 0, kredit: h.kredit.pph25 });
    const lain = h.kredit.pph22 + h.kredit.pph23 + h.kredit.pph24;
    if (lain > 0) barisJurnal.push({ akun: 'Pajak Dibayar Dimuka (PPh 22/23/24)', debit: 0, kredit: lain });
    if (h.pph29 > 0) barisJurnal.push({ akun: 'Utang PPh Pasal 29', debit: 0, kredit: h.pph29 });
  }

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView style={ps.layar} contentContainerStyle={ps.isi} keyboardShouldPersistTaps="handled">
        <Text style={ps.intro}>PPh Badan dihitung otomatis dari buku besar, koreksi fiskal, dan kredit pajak yang sah.</Text>

        <View style={ps.field}>
          <Text style={ps.label}>Tahun Pajak *</Text>
          <Segmen<string> opsi={opsiTahun.map((t) => ({ nilai: t, label: t }))} nilai={tahun} onChange={setTahun} />
        </View>

        {!data ? (
          <Memuat />
        ) : (
          <>
            <Catatan nada={nada}>{LABEL_STATUS_PPH_BADAN[data.status]}</Catatan>
            {data.pesan.map((p, i) => (
              <Catatan key={i} nada="info">
                {p}
              </Catatan>
            ))}
            {data.rezim.rezim ? (
              <Kartu judul="Rezim pajak">
                <BarisNilai label={LABEL_REZIM[data.rezim.rezim]} nilai={data.rezim.sumber === 'OVERRIDE' ? 'Manual' : 'Otomatis'} tebal />
                <BarisNilai label="Versi kebijakan" nilai={data.kebijakan.versi} redam />
              </Kartu>
            ) : null}

            {h ? (
              <>
                {data.rincian ? <KartuRincian rincian={data.rincian} /> : null}
                <TombolSimpan label={`Koreksi Fiskal (${data.koreksi.length})`} onPress={() => navigation.navigate('KoreksiFiskal', { tahun: Number(tahun) })} memproses={false} ikon="list-outline" />
                {h.lebihBayar > 0 ? <Catatan nada="galat">Lebih bayar {formatRupiah(h.lebihBayar)} — perlakuannya belum ditetapkan kebijakan.</Catatan> : null}
              </>
            ) : null}

            {data.status === 'TERKUNCI' && data.snapshot ? (
              <Kartu judul="Snapshot terkunci">
                <BarisNilai label="Dikunci pada" nilai={data.snapshot.createdAt.slice(0, 10)} redam />
                <BarisNilai label="Jurnal" nilai={data.snapshot.nomorJurnal ?? 'Tanpa jurnal (PPh nihil)'} redam />
                <AppTextInput label="Alasan pembatalan" inputType="multiline" multiline value={alasanBatal} onChangeText={setAlasanBatal} placeholder="Mis. koreksi fiskal terlewat" />
                <TombolSimpan label="Batalkan Perhitungan" onPress={batal} memproses={memproses} ikon="arrow-undo-outline" nonaktif={!alasanBatal.trim()} />
              </Kartu>
            ) : null}

            {data.status === 'SIAP_DIKUNCI' ? (
              review ? (
                <>
                  <PratinjauJurnal baris={barisJurnal} />
                  <Catatan nada="peringatan">Setelah dikunci, hasil tidak dapat diubah kecuali dibatalkan lewat reversal yang tercatat.</Catatan>
                  <TombolSimpan label="Kunci Perhitungan" onPress={kunci} memproses={memproses} ikon="lock-closed-outline" />
                </>
              ) : (
                <TombolSimpan label="Review" onPress={() => setReview(true)} memproses={false} ikon="eye-outline" />
              )
            ) : null}
            <View style={{ marginTop: 8 }}>
              <TombolSimpan label="Hitung Ulang" onPress={muat} memproses={false} ikon="refresh-outline" />
            </View>
          </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}
