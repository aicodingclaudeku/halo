import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import AppTextInput from '@/components/AppTextInput';
import { RekeningItem } from '@/services/KasBankService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { getPeriodeLokalSekarang, getTanggalLokalHariIni } from '@/utils/tanggal';
import { catatAngsuranPph25 } from '@/services/PajakService';
import {
  bayarAngsuranPph25Terjadwal,
  DasarPph25,
  getDasarPph25,
  getJadwalPph25,
  getUsulanDasarPph25,
  JadwalPph25,
  tetapkanDasarPph25,
  tetapkanDasarPph25Otomatis,
  UsulanDasarPph25,
} from '@/services/PajakBadanService';
import { daftarMasa, LABEL_SUMBER_DASAR_PPH25, labelMasa, normalisasiNtpn, SumberDasarPph25, validasiNtpn } from '@/config/pajakPolicy';
import { BarisNilai, Catatan, Kartu, KartuRincian, Lencana, PemilihMasa, PesanGalat, PratinjauJurnal, Segmen, TombolSimpan, pajakStyles as ps } from './PajakUi';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * RC-S87 — Nominal angsuran diambil dari DASAR ANGSURAN yang ditetapkan
 * untuk tahun pajak (SPT/SKP/keputusan DJP + nomor & tanggal referensi).
 * Operator hanya mengisi sumber dana, tanggal setor, dan NTPN. Bila dasar
 * belum ada, form lama tetap bisa dipakai sebagai fallback dengan alasan
 * wajib di catatan.
 *
 * RC-S84 — Angsuran PPh Pasal 25 (skema tarif umum).
 * Dr Pajak Dibayar Dimuka / Kr Kas-Bank lewat catatPengeluaran(); satu
 * angsuran per masa (kunci idempotensi PAJAK:PPH25:<masa>). Nominal diisi
 * pengguna dari STP/SPT — aplikasi tidak menghitung angsuran PPh 25.
 */
export default function AngsuranPph25FormScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const opsiMasa = useMemo(() => daftarMasa(getPeriodeLokalSekarang(), 12), []);
  const [masa, setMasa] = useState(opsiMasa[0]);
  const [nominal, setNominal] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [ntpn, setNtpn] = useState('');
  const [catatan, setCatatan] = useState('');
  const [galat, setGalat] = useState<Record<string, string>>({});
  const [menyimpan, setMenyimpan] = useState(false);
  const tahunMasa = Number(masa.slice(0, 4));
  const [dasar, setDasar] = useState<DasarPph25 | null | undefined>(undefined);
  const [dAngsuran, setDAngsuran] = useState<number | ''>('');
  const [dSumber, setDSumber] = useState<SumberDasarPph25 | null>('SPT_TAHUNAN');
  const [dNomor, setDNomor] = useState('');
  const [dTanggal, setDTanggal] = useState(getTanggalLokalHariIni());

  const [usulan, setUsulan] = useState<UsulanDasarPph25 | null>(null);
  const [jadwal, setJadwal] = useState<JadwalPph25 | null>(null);
  const [manualDasar, setManualDasar] = useState(false);
  const [sudahPilihOtomatis, setSudahPilihOtomatis] = useState(false);

  const muatDasar = useCallback(async () => {
    setDasar(undefined);
    try {
      const d = await getDasarPph25(tahunMasa);
      setDasar(d);
      setUsulan(d ? null : await getUsulanDasarPph25(tahunMasa));
      setJadwal(d ? await getJadwalPph25(tahunMasa) : null);
    } catch {
      setDasar(null);
    }
  }, [tahunMasa]);

  // RC-S87.3 — pilih otomatis masa tertua yang belum dibayar (sekali per buka layar).
  useEffect(() => {
    if (!jadwal || sudahPilihOtomatis) return;
    const belum = jadwal.masa.find((m) => (m.status === 'TERLAMBAT' || m.status === 'JATUH_TEMPO') && opsiMasa.includes(m.masa));
    if (belum && belum.masa !== masa) setMasa(belum.masa);
    setSudahPilihOtomatis(true);
  }, [jadwal, sudahPilihOtomatis, opsiMasa, masa]);

  const pakaiOtomatis = async () => {
    if (!currentUser) return;
    setMenyimpan(true);
    try {
      const h = await tetapkanDasarPph25Otomatis({ tahunPajak: tahunMasa, userId: currentUser.id });
      notify('Dasar angsuran ditetapkan', `PPh 25 tahun ${tahunMasa}: ${formatRupiah(h.angsuranBulanan)} per bulan (otomatis).`);
      muatDasar();
    } catch (e) {
      notify('Gagal menetapkan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpan(false);
    }
  };
  useEffect(() => {
    muatDasar();
  }, [muatDasar]);

  const simpanDasar = async () => {
    if (!currentUser || !dSumber || dAngsuran === '') return;
    setMenyimpan(true);
    try {
      await tetapkanDasarPph25({
        tahunPajak: tahunMasa,
        angsuranBulanan: dAngsuran,
        sumber: dSumber,
        tahunSumber: tahunMasa - 1,
        nomorReferensi: dNomor,
        tanggalReferensi: dTanggal,
        userId: currentUser.id,
      });
      notify('Dasar angsuran ditetapkan', `PPh 25 tahun ${tahunMasa}: ${formatRupiah(dAngsuran)} per bulan.`);
      muatDasar();
    } catch (e) {
      notify('Gagal menyimpan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpan(false);
    }
  };

  const nominalEfektif: number | '' = dasar ? dasar.angsuranBulanan : nominal;

  const validasi = () => {
    const e: Record<string, string> = {};
    if (!dasar && (nominal === '' || nominal <= 0)) e.nominal = 'Nominal angsuran harus lebih dari 0.';
    if (!dasar && !catatan.trim()) e.catatan = 'Tanpa dasar angsuran, tulis alasan dan dokumen sumber nominal ini.';
    if (!rekening) e.rekening = 'Pilih rekening pembayaran.';
    const n = validasiNtpn(ntpn);
    if (n) e.ntpn = n;
    setGalat(e);
    return Object.keys(e).length === 0;
  };

  const simpan = async () => {
    if (!validasi() || !rekening || !currentUser || nominalEfektif === '') return;
    setMenyimpan(true);
    try {
      if (dasar) {
        const h = await bayarAngsuranPph25Terjadwal({
          masa,
          jenisRekening: rekening.jenis,
          bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
          tanggal,
          ntpn,
          catatan,
          createdBy: currentUser.id,
        });
        notify('Angsuran tercatat', `PPh 25 masa ${labelMasa(masa)} sebesar ${formatRupiah(h.nominal)}.`, [{ text: 'OK', onPress: () => navigation.goBack() }]);
        return;
      }
      if (nominal === '') return;
      await catatAngsuranPph25({
        masa,
        nominal,
        jenisRekening: rekening.jenis,
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        tanggal,
        ntpn,
        catatan,
        createdBy: currentUser.id,
      });
      notify('Angsuran tercatat', `PPh 25 masa ${labelMasa(masa)} sebesar ${formatRupiah(nominal)}.`, [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal mencatat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpan(false);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView style={ps.layar} contentContainerStyle={ps.isi} keyboardShouldPersistTaps="handled">
        <Text style={ps.intro}>Angsuran PPh 25 dicatat sebagai kredit pajak dan diperhitungkan saat PPh Badan akhir tahun.</Text>

        <PemilihMasa daftar={opsiMasa} nilai={masa} onChange={setMasa} />

        {dasar === undefined ? null : dasar ? (
          <>
            <Kartu judul={`Dasar angsuran ${tahunMasa}`}>
              <BarisNilai label="Angsuran per bulan" nilai={formatRupiah(dasar.angsuranBulanan)} tebal />
              <BarisNilai label="Sumber" nilai={LABEL_SUMBER_DASAR_PPH25[dasar.sumber]} redam />
              <BarisNilai label="Referensi" nilai={`${dasar.nomorReferensi} · ${dasar.tanggalReferensi}`} redam />
            </Kartu>
            {jadwal && jadwal.masa.length > 0 ? (
              <Kartu judul={`Jadwal ${tahunMasa} · dibayar ${formatRupiah(jadwal.totalDibayar)} dari ${formatRupiah(jadwal.totalTerjadwal)}`}>
                {jadwal.masa.map((m) => (
                  <TouchableOpacity
                    key={m.masa}
                    onPress={() => opsiMasa.includes(m.masa) && m.status !== 'LUNAS' && setMasa(m.masa)}
                    accessibilityRole="button"
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, opacity: m.masa === masa ? 1 : 0.92 }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[ps.label, { marginBottom: 0 }, m.masa === masa && { textDecorationLine: 'underline' }]}>{m.label}</Text>
                      <Text style={ps.hint}>{m.pembayaran ? `${m.pembayaran.nomorJurnal}${m.pembayaran.ntpn ? ` · NTPN ${m.pembayaran.ntpn}` : ''}` : `Jatuh tempo ${m.jatuhTempo}`}</Text>
                    </View>
                    <Lencana
                      teks={m.status === 'LUNAS' ? 'Lunas' : m.status === 'TERLAMBAT' ? 'Terlambat' : m.status === 'JATUH_TEMPO' ? 'Perlu dibayar' : 'Belum jatuh tempo'}
                      nada={m.status === 'LUNAS' ? 'sukses' : m.status === 'BELUM_JATUH_TEMPO' ? 'netral' : 'peringatan'}
                    />
                  </TouchableOpacity>
                ))}
              </Kartu>
            ) : null}
          </>
        ) : (
          <>
            {usulan?.tersedia && usulan.rincian ? (
              <>
                <KartuRincian rincian={usulan.rincian} />
                <TombolSimpan label="Gunakan Perhitungan Otomatis" onPress={pakaiOtomatis} memproses={menyimpan} ikon="flash-outline" />
              </>
            ) : usulan ? (
              <Catatan>Belum ada usulan otomatis: {usulan.alasan} Tetapkan dasar dari SPT/dokumen DJP di bawah.</Catatan>
            ) : null}

            <TouchableOpacity
              onPress={() => setManualDasar((b) => !b)}
              accessibilityRole="button"
              accessibilityState={{ expanded: manualDasar || !usulan?.tersedia }}
              style={{ paddingVertical: 10 }}
            >
              <Text style={[ps.label, { marginBottom: 0 }]}>
                {usulan?.tersedia ? (manualDasar ? '▾ ' : '▸ ') : ''}Tetapkan dari dokumen (SPT / SKP / keputusan DJP)
              </Text>
            </TouchableOpacity>
            {manualDasar || !usulan?.tersedia ? (
            <Kartu judul={`Tetapkan dasar angsuran ${tahunMasa}`}>
              <Catatan>Angsuran PPh 25 berasal dari SPT tahun sebelumnya atau ketetapan DJP — tidak ditebak dari laba bulanan.</Catatan>
              <View style={ps.field}>
                <Text style={ps.label}>Angsuran per bulan *</Text>
                <CurrencyInput value={dAngsuran} onChangeValue={setDAngsuran} />
              </View>
              <View style={ps.field}>
                <Text style={ps.label}>Sumber *</Text>
                <Segmen<SumberDasarPph25>
                  opsi={[
                    { nilai: 'SPT_TAHUNAN', label: 'SPT' },
                    { nilai: 'SKP', label: 'SKP' },
                    { nilai: 'KEPUTUSAN_DJP', label: 'Kep. DJP' },
                    { nilai: 'LAINNYA', label: 'Lainnya' },
                  ]}
                  nilai={dSumber}
                  onChange={setDSumber}
                />
              </View>
              <AppTextInput label="Nomor SPT / dokumen" required value={dNomor} onChangeText={setDNomor} />
              <View style={ps.field}>
                <Text style={ps.label}>Tanggal dokumen *</Text>
                <DatePicker value={dTanggal} onChange={setDTanggal} maximumDate={getWaktuSekarang()} />
              </View>
              <TombolSimpan label="Tetapkan Dasar" onPress={simpanDasar} memproses={menyimpan} nonaktif={dAngsuran === '' || !dNomor.trim()} ikon="document-text-outline" />
            </Kartu>
            ) : null}
            <Catatan nada="peringatan">Fallback: tanpa dasar angsuran, nominal diketik manual dan alasan wajib ditulis di catatan.</Catatan>
            <View style={ps.field}>
              <Text style={ps.label}>Nominal Angsuran *</Text>
              <CurrencyInput value={nominal} onChangeValue={setNominal} error={galat.nominal} />
            </View>
          </>
        )}

        <View style={ps.field}>
          <RekeningPicker label="Rekening Pembayaran" value={rekening} onChange={setRekening} />
          <PesanGalat teks={galat.rekening} />
        </View>

        <View style={ps.field}>
          <Text style={ps.label}>Tanggal Bayar *</Text>
          <DatePicker value={tanggal} onChange={setTanggal} maximumDate={getWaktuSekarang()} />
        </View>

        <AppTextInput
          label="NTPN"
          inputType="code"
          autoCapitalize="characters"
          maxLength={19}
          placeholder="16 huruf/angka dari bukti setor"
          value={ntpn}
          onChangeText={setNtpn}
          onBlur={() => setNtpn(normalisasiNtpn(ntpn))}
          error={galat.ntpn}
          hint="Boleh dikosongkan bila bukti setor belum terbit."
        />
        <AppTextInput
          label="Catatan"
          inputType="multiline"
          multiline
          placeholder={dasar ? 'Opsional' : 'Wajib: alasan & dokumen sumber nominal'}
          value={catatan}
          onChangeText={setCatatan}
          error={galat.catatan}
        />

        {typeof nominalEfektif === 'number' && nominalEfektif > 0 ? (
          <PratinjauJurnal
            baris={[
              { akun: 'Pajak Dibayar Dimuka (PPh 25)', debit: nominalEfektif, kredit: 0 },
              { akun: rekening?.nama ?? 'Kas / Bank', debit: 0, kredit: nominalEfektif },
            ]}
          />
        ) : null}

        <Catatan>Satu masa hanya bisa dicatat sekali. Koreksi angsuran dilakukan lewat History Transaksi.</Catatan>

        <TombolSimpan label="Catat Angsuran" onPress={simpan} memproses={menyimpan} ikon="checkmark-done-outline" />
      </ScrollView>
    </AreaAmanKeyboard>
  );
}
