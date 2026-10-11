import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  simpanDraftNilaiWajar,
  listPenilaianNilaiWajar,
  listObjekNilaiWajarEligible,
  previewPenilaian,
  previewPostingNilaiWajar,
  postingNilaiWajar,
  batalkanPenilaianNilaiWajar,
  getRingkasanNilaiWajar,
  LABEL_OBJEK_NILAI_WAJAR,
  PERLAKUAN_NILAI_WAJAR,
  type ArahPerubahanNilai,
  type NilaiWajarRow,
  type ObjekNilaiWajar,
  type ObjekNilaiWajarEligible,
  type RencanaPostingNilaiWajar,
  type RingkasanNilaiWajar,
  type StatusPenilaianNilaiWajar,
} from '@/services/PenyesuaianNilaiWajarService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, elevation, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import DatePicker from '@/components/DatePicker';
import CurrencyInput from '@/components/CurrencyInput';
import FocusTextInput from '@/components/FocusTextInput';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * PENYESUAIAN NILAI WAJAR & REVALUASI (RC-S88 — rekomendasi SAK EP).
 *
 * Dua objek pengukuran dalam satu layar:
 *   - Properti Investasi → model nilai wajar, selisih ke laba rugi;
 *   - Aset Tetap         → model revaluasi, kenaikan ke penghasilan
 *                          komprehensif lain (surplus revaluasi).
 *
 * Alur maker–checker: penilaian disimpan sebagai DRAFT beserta buktinya,
 * lalu DIPOSTING lewat lembar konfirmasi yang menampilkan jurnal persis
 * seperti yang akan dibentuk. Layar ini TIDAK menghitung apa pun: nilai
 * tercatat, selisih, pembagian laba rugi/OCI, baris jurnal, dan hambatan
 * posting seluruhnya berasal dari service (`previewPenilaian`,
 * `previewPostingNilaiWajar`) — penyusun yang sama dengan eksekusi.
 */

const LABEL_ARAH: Record<ArahPerubahanNilai, string> = {
  KENAIKAN: 'Kenaikan',
  PENURUNAN: 'Penurunan',
  TIDAK_BERUBAH: 'Tidak berubah',
};

const GAYA_STATUS: Record<StatusPenilaianNilaiWajar, { label: string; bg: string; fg: string; ikon: keyof typeof Ionicons.glyphMap }> = {
  DRAFT: { label: 'Draft', bg: colors.warningBg, fg: colors.warning, ikon: 'create-outline' },
  DIPOSTING: { label: 'Diposting', bg: colors.primaryLight, fg: colors.primary, ikon: 'checkmark-circle' },
  DIBATALKAN: { label: 'Dibatalkan', bg: colors.background, fg: colors.textMuted, ikon: 'close-circle-outline' },
};

type FilterStatus = 'SEMUA' | StatusPenilaianNilaiWajar;
const FILTER: { nilai: FilterStatus; label: string }[] = [
  { nilai: 'SEMUA', label: 'Semua' },
  { nilai: 'DRAFT', label: 'Draft' },
  { nilai: 'DIPOSTING', label: 'Diposting' },
  { nilai: 'DIBATALKAN', label: 'Dibatalkan' },
];

function rupiahBertanda(n: number): string {
  if (n > 0) return `+${formatRupiah(n)}`;
  return formatRupiah(n);
}

function warnaSelisih(n: number): string {
  if (n > 0) return colors.success;
  if (n < 0) return colors.danger;
  return colors.textMuted;
}

function waktuSingkat(iso: string | null): string {
  if (!iso) return '-';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export default function PenyesuaianNilaiWajarScreen() {
  const currentUser = useAppStore((s) => s.currentUser);

  const [objek, setObjek] = useState<ObjekNilaiWajar>('PROPERTI_INVESTASI');
  const [daftarObjek, setDaftarObjek] = useState<ObjekNilaiWajarEligible[]>([]);
  const [daftar, setDaftar] = useState<NilaiWajarRow[]>([]);
  const [ringkasan, setRingkasan] = useState<RingkasanNilaiWajar | null>(null);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);
  const [filter, setFilter] = useState<FilterStatus>('SEMUA');

  // Formulir penilaian baru.
  const [objekId, setObjekId] = useState<string | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [nilaiWajar, setNilaiWajar] = useState<number | ''>('');
  const [dasarPenilaian, setDasarPenilaian] = useState('');
  const [referensiBukti, setReferensiBukti] = useState('');
  const [penilai, setPenilai] = useState('');
  const [catatan, setCatatan] = useState('');
  const [preview, setPreview] = useState<RencanaPostingNilaiWajar | null>(null);
  const [galatPreview, setGalatPreview] = useState<string | null>(null);
  const [galatForm, setGalatForm] = useState<Record<string, string>>({});

  // Pembatalan & posting.
  const [batalId, setBatalId] = useState<string | null>(null);
  const [alasanBatal, setAlasanBatal] = useState('');
  const [membatalkan, setMembatalkan] = useState(false);
  const [lembarPosting, setLembarPosting] = useState<{ row: NilaiWajarRow; rencana: RencanaPostingNilaiWajar } | null>(null);
  const [memuatPosting, setMemuatPosting] = useState<string | null>(null);
  const [memposting, setMemposting] = useState(false);
  const [terbuka, setTerbuka] = useState<string | null>(null);

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(null);
    try {
      const [obj, semua, ring] = await Promise.all([
        listObjekNilaiWajarEligible(objek),
        listPenilaianNilaiWajar(),
        getRingkasanNilaiWajar(),
      ]);
      // Eligibility ditentukan service — satu sumber.
      setDaftarObjek(obj);
      setDaftar(semua);
      setRingkasan(ring);
    } catch (e) {
      setGalat(e instanceof Error ? e.message : 'Data penyesuaian nilai wajar gagal dimuat.');
    } finally {
      setMemuat(false);
    }
  }, [objek]);

  useEffect(() => {
    void muat();
  }, [muat]);

  const gantiObjek = (o: ObjekNilaiWajar) => {
    if (o === objek) return;
    setObjek(o);
    setObjekId(null);
    setPreview(null);
    setGalatForm({});
  };

  // Pratinjau dibaca ULANG dari service; layar tidak menghitung sendiri.
  useEffect(() => {
    let batal = false;
    setGalatPreview(null);
    if (!objekId || nilaiWajar === '') {
      setPreview(null);
      return;
    }
    previewPenilaian({ objek, objekId, nilaiWajar, tanggal })
      .then((p) => {
        if (!batal) setPreview(p);
      })
      .catch((e) => {
        if (batal) return;
        setPreview(null);
        setGalatPreview(e instanceof Error ? e.message : 'Pratinjau gagal dihitung.');
      });
    return () => {
      batal = true;
    };
  }, [objek, objekId, nilaiWajar, tanggal]);

  const resetForm = () => {
    setNilaiWajar('');
    setDasarPenilaian('');
    setReferensiBukti('');
    setPenilai('');
    setCatatan('');
    setObjekId(null);
    setPreview(null);
    setGalatForm({});
  };

  const simpan = async () => {
    const g: Record<string, string> = {};
    if (!objekId) g.objek = objek === 'ASET_TETAP' ? 'Pilih aset tetap yang dinilai.' : 'Pilih properti investasi yang dinilai.';
    if (nilaiWajar === '' || nilaiWajar < 0) g.nilai = 'Nilai wajar wajib diisi dan tidak boleh negatif.';
    if (dasarPenilaian.trim() === '') g.dasar = 'Dasar penilaian wajib diisi.';
    if (referensiBukti.trim() === '') g.referensi = 'Referensi bukti wajib diisi.';
    setGalatForm(g);
    if (Object.keys(g).length > 0) {
      notify('Belum lengkap', 'Lengkapi isian yang ditandai sebelum menyimpan.');
      return;
    }
    if (!currentUser || !objekId || nilaiWajar === '') return;
    setMenyimpan(true);
    try {
      await simpanDraftNilaiWajar({
        objek,
        investasiId: objek === 'PROPERTI_INVESTASI' ? objekId : undefined,
        asetTetapId: objek === 'ASET_TETAP' ? objekId : undefined,
        tanggal,
        nilaiWajar,
        dasarPenilaian: dasarPenilaian.trim(),
        referensiBukti: referensiBukti.trim(),
        penilai: penilai.trim() === '' ? undefined : penilai.trim(),
        catatan: catatan.trim() === '' ? undefined : catatan.trim(),
        createdBy: currentUser.id,
      });
      notify('Draft penilaian tersimpan', 'Tinjau lalu posting dari daftar Riwayat Penilaian.');
      resetForm();
      setFilter('DRAFT');
      await muat();
    } catch (e) {
      notify('Gagal menyimpan', e instanceof Error ? e.message : 'Draft gagal disimpan.');
    } finally {
      setMenyimpan(false);
    }
  };

  const bukaPosting = async (row: NilaiWajarRow) => {
    setMemuatPosting(row.id);
    try {
      const rencana = await previewPostingNilaiWajar(row.id);
      setLembarPosting({ row, rencana });
    } catch (e) {
      notify('Tidak dapat dipratinjau', e instanceof Error ? e.message : 'Pratinjau posting gagal.');
    } finally {
      setMemuatPosting(null);
    }
  };

  const konfirmasiPosting = async () => {
    if (!lembarPosting || !currentUser) return;
    setMemposting(true);
    try {
      const hasil = await postingNilaiWajar(lembarPosting.row.id, { userId: currentUser.id });
      notify(
        'Penilaian diposting',
        hasil.journalId ? `Jurnal ${hasil.row.nomorJurnal ?? ''} terbentuk.` : 'Tidak ada selisih — penilaian dicatat tanpa jurnal.'
      );
      setLembarPosting(null);
      setFilter('DIPOSTING');
      await muat();
    } catch (e) {
      notify('Gagal memposting', e instanceof Error ? e.message : 'Posting gagal.');
    } finally {
      setMemposting(false);
    }
  };

  const batalkan = async (id: string) => {
    if (alasanBatal.trim() === '') {
      notify('Tidak dapat dibatalkan', 'Alasan pembatalan wajib diisi.');
      return;
    }
    if (!currentUser) return;
    setMembatalkan(true);
    try {
      await batalkanPenilaianNilaiWajar(id, { alasan: alasanBatal.trim(), userId: currentUser.id });
      notify('Draft dibatalkan', 'Histori penilaian tetap tersimpan.');
      setBatalId(null);
      setAlasanBatal('');
      await muat();
    } catch (e) {
      notify('Gagal membatalkan', e instanceof Error ? e.message : 'Draft gagal dibatalkan.');
    } finally {
      setMembatalkan(false);
    }
  };

  const perlakuan = PERLAKUAN_NILAI_WAJAR[objek];
  const daftarTersaring = useMemo(
    () => daftar.filter((d) => d.objek === objek && (filter === 'SEMUA' || d.status === filter)),
    [daftar, objek, filter]
  );

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <View style={styles.container}>
        <ScrollView style={styles.container} contentContainerStyle={styles.isi} keyboardShouldPersistTaps="handled">
          {/* ============ OBJEK PENGUKURAN ============ */}
          <View style={styles.segmen} accessibilityRole="tablist">
            {(['PROPERTI_INVESTASI', 'ASET_TETAP'] as ObjekNilaiWajar[]).map((o) => {
              const aktif = objek === o;
              return (
                <TouchableOpacity
                  key={o}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: aktif }}
                  style={[styles.segmenItem, aktif && styles.segmenItemAktif]}
                  onPress={() => gantiObjek(o)}
                >
                  <Ionicons
                    name={o === 'ASET_TETAP' ? 'business-outline' : 'home-outline'}
                    size={16}
                    color={aktif ? colors.white : colors.textMuted}
                  />
                  <Text style={[styles.segmenText, aktif && styles.segmenTextAktif]}>{LABEL_OBJEK_NILAI_WAJAR[o]}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* ============ KEBIJAKAN ============ */}
          <View style={styles.kebijakan}>
            <View style={styles.kebijakanIkon}>
              <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.kebijakanJudulRow}>
                <Text style={styles.kebijakanJudul}>{perlakuan.model}</Text>
                <Text style={styles.kebijakanDasar}>{perlakuan.dasar}</Text>
              </View>
              <Text style={styles.kebijakanText}>{perlakuan.ringkas}</Text>
            </View>
          </View>

          {/* ============ RINGKASAN ============ */}
          {ringkasan ? (
            <View style={styles.statRow}>
              <Stat label="Draft" nilai={String(ringkasan.jumlahDraft)} />
              <Stat label="Diposting" nilai={String(ringkasan.jumlahDiposting)} />
              <Stat label="Ke Laba Rugi" nilai={rupiahBertanda(ringkasan.totalLabaRugi)} warna={warnaSelisih(ringkasan.totalLabaRugi)} />
              <Stat label="Ke OCI" nilai={rupiahBertanda(ringkasan.totalOci)} warna={warnaSelisih(ringkasan.totalOci)} />
            </View>
          ) : null}

          {/* ============ PENILAIAN BARU ============ */}
          <Kartu judul="Penilaian Baru" ikon="add-circle-outline">
            <Langkah nomor={1} judul={objek === 'ASET_TETAP' ? 'Pilih aset tetap' : 'Pilih properti investasi'} />
            {memuat ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.md }} />
            ) : daftarObjek.length === 0 ? (
              <View style={styles.kosongBox}>
                <Ionicons name="file-tray-outline" size={18} color={colors.textFaint} />
                <Text style={styles.kosongText}>
                  {objek === 'ASET_TETAP' ? 'Belum ada aset tetap aktif.' : 'Belum ada properti investasi aktif.'}
                </Text>
              </View>
            ) : (
              daftarObjek.map((o) => {
                const aktif = objekId === o.id;
                return (
                  <TouchableOpacity
                    key={o.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: aktif }}
                    style={[styles.opsiObjek, aktif && styles.opsiObjekAktif]}
                    onPress={() => {
                      setObjekId(o.id);
                      setGalatForm((g) => ({ ...g, objek: '' }));
                    }}
                  >
                    <Ionicons
                      name={aktif ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={aktif ? colors.primary : colors.textFaint}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.opsiNama, aktif && styles.opsiNamaAktif]} numberOfLines={2}>
                        {o.nama}
                      </Text>
                      <Text style={styles.opsiMeta} numberOfLines={1}>
                        {o.nomor}
                        {o.keterangan ? ` · ${o.keterangan}` : ''}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
            <Galat teks={galatForm.objek} />

            <Langkah nomor={2} judul="Tanggal & nilai wajar" />
            <Text style={styles.label}>Tanggal Penilaian *</Text>
            <DatePicker value={tanggal} onChange={setTanggal} />
            <Text style={[styles.label, { marginTop: spacing.md }]}>Nilai Wajar *</Text>
            <CurrencyInput
              value={nilaiWajar}
              onChangeValue={(v) => {
                setNilaiWajar(v);
                setGalatForm((g) => ({ ...g, nilai: '' }));
              }}
              placeholder="0"
              error={galatForm.nilai || undefined}
            />

            {/* Hasil perhitungan service (read-only). */}
            {galatPreview ? (
              <View style={[styles.infoBox, styles.infoBahaya]}>
                <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
                <Text style={[styles.infoText, { color: colors.danger }]}>{galatPreview}</Text>
              </View>
            ) : null}
            {preview ? <PanelPerhitungan rencana={preview} /> : (
              <Text style={styles.petunjuk}>
                Pilih objek dan isi nilai wajar untuk melihat selisih, pembagian laba rugi/OCI, dan jurnal yang akan terbentuk.
              </Text>
            )}

            <Langkah nomor={3} judul="Bukti penilaian" />
            <Text style={styles.label}>Dasar Penilaian *</Text>
            <FocusTextInput
              style={[styles.input, styles.textArea, galatForm.dasar ? styles.inputGalat : null]}
              value={dasarPenilaian}
              onChangeText={(t: string) => {
                setDasarPenilaian(t);
                setGalatForm((g) => ({ ...g, dasar: '' }));
              }}
              placeholder="Mis. laporan penilai (KJPP), harga pasar pembanding, NJOP"
              placeholderTextColor={colors.placeholder}
              multiline
            />
            <Galat teks={galatForm.dasar} />
            <Text style={[styles.label, { marginTop: spacing.md }]}>Referensi Bukti *</Text>
            <FocusTextInput
              style={[styles.input, galatForm.referensi ? styles.inputGalat : null]}
              value={referensiBukti}
              onChangeText={(t: string) => {
                setReferensiBukti(t);
                setGalatForm((g) => ({ ...g, referensi: '' }));
              }}
              placeholder="Nomor/tanggal laporan penilaian"
              placeholderTextColor={colors.placeholder}
            />
            <Galat teks={galatForm.referensi} />
            <Text style={[styles.label, { marginTop: spacing.md }]}>Penilai</Text>
            <FocusTextInput
              style={styles.input}
              value={penilai}
              onChangeText={setPenilai}
              placeholder="Nama penilai / KJPP (opsional)"
              placeholderTextColor={colors.placeholder}
            />
            <Text style={[styles.label, { marginTop: spacing.md }]}>Catatan</Text>
            <FocusTextInput
              style={[styles.input, styles.textArea]}
              value={catatan}
              onChangeText={setCatatan}
              placeholder="Catatan tambahan (opsional)"
              placeholderTextColor={colors.placeholder}
              multiline
            />

            <TouchableOpacity
              style={[styles.tombolUtama, menyimpan && styles.nonaktif]}
              onPress={() => void simpan()}
              disabled={menyimpan}
              accessibilityRole="button"
            >
              {menyimpan ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <>
                  <Ionicons name="save-outline" size={18} color={colors.white} />
                  <Text style={styles.tombolUtamaText}>Simpan Draft</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={styles.footnote}>
              Draft belum memengaruhi laporan. Jurnal baru terbentuk saat draft diposting dari Riwayat Penilaian.
            </Text>
          </Kartu>

          {/* ============ RIWAYAT ============ */}
          <View style={styles.riwayatHeader}>
            <Text style={styles.riwayatJudul}>Riwayat Penilaian</Text>
            <Text style={styles.riwayatSub}>{LABEL_OBJEK_NILAI_WAJAR[objek]}</Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
            keyboardShouldPersistTaps="handled"
          >
            {FILTER.map((f) => {
              const aktif = filter === f.nilai;
              return (
                <TouchableOpacity
                  key={f.nilai}
                  style={[styles.filterChip, aktif && styles.filterChipAktif]}
                  onPress={() => setFilter(f.nilai)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: aktif }}
                >
                  <Text style={[styles.filterText, aktif && styles.filterTextAktif]}>{f.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {galat !== null ? (
            <View>
              <Text style={styles.errorText}>{galat}</Text>
              <TouchableOpacity onPress={() => void muat()}>
                <Text style={styles.link}>Coba lagi</Text>
              </TouchableOpacity>
            </View>
          ) : daftarTersaring.length === 0 ? (
            <View style={styles.kosongBox}>
              <Ionicons name="document-text-outline" size={18} color={colors.textFaint} />
              <Text style={styles.kosongText}>Belum ada penilaian pada filter ini.</Text>
            </View>
          ) : (
            daftarTersaring.map((d) => {
              const gaya = GAYA_STATUS[d.status];
              const buka = terbuka === d.id;
              return (
                <View key={d.id} style={styles.item}>
                  <View style={styles.itemAtas}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemJudul} numberOfLines={2}>
                        {d.namaObjek}
                      </Text>
                      <Text style={styles.itemMeta}>
                        {d.nomorObjek} · per {d.tanggal}
                      </Text>
                    </View>
                    <View style={[styles.badge, { backgroundColor: gaya.bg }]}>
                      <Ionicons name={gaya.ikon} size={12} color={gaya.fg} />
                      <Text style={[styles.badgeText, { color: gaya.fg }]}>{gaya.label}</Text>
                    </View>
                  </View>

                  <View style={styles.nilaiRow}>
                    <View style={styles.nilaiKol}>
                      <Text style={styles.nilaiLabel}>Nilai tercatat</Text>
                      <Text style={styles.nilaiAngka}>{formatRupiah(d.nilaiTercatatSebelum)}</Text>
                    </View>
                    <Ionicons name="arrow-forward" size={16} color={colors.textFaint} />
                    <View style={[styles.nilaiKol, { alignItems: 'flex-end' }]}>
                      <Text style={styles.nilaiLabel}>Nilai wajar</Text>
                      <Text style={styles.nilaiAngka}>{formatRupiah(d.nilaiWajar)}</Text>
                    </View>
                  </View>
                  <View style={styles.selisihRow}>
                    <Text style={styles.selisihLabel}>{LABEL_ARAH[d.arahPerubahan]}</Text>
                    <Text style={[styles.selisihAngka, { color: warnaSelisih(d.selisih) }]}>{rupiahBertanda(d.selisih)}</Text>
                  </View>
                  {d.status === 'DIPOSTING' ? (
                    <View style={styles.pembagianRow}>
                      <Pil label="Laba rugi" nilai={d.jumlahLabaRugi} />
                      <Pil label="OCI" nilai={d.jumlahOci} />
                      <Text style={styles.jurnalText}>{d.nomorJurnal ? `Jurnal ${d.nomorJurnal}` : 'Tanpa jurnal (selisih nol)'}</Text>
                    </View>
                  ) : null}

                  <TouchableOpacity onPress={() => setTerbuka(buka ? null : d.id)} style={styles.detailToggle}>
                    <Text style={styles.detailToggleText}>{buka ? 'Sembunyikan rincian' : 'Lihat rincian'}</Text>
                    <Ionicons name={buka ? 'chevron-up' : 'chevron-down'} size={14} color={colors.primary} />
                  </TouchableOpacity>
                  {buka ? (
                    <View style={styles.detail}>
                      <BarisDetail label="Dasar Penilaian" nilai={d.dasarPenilaian ?? '-'} />
                      <BarisDetail label="Referensi Bukti" nilai={d.referensiBukti ?? '-'} />
                      {d.penilai ? <BarisDetail label="Penilai" nilai={d.penilai} /> : null}
                      {d.catatan ? <BarisDetail label="Catatan" nilai={d.catatan} /> : null}
                      <BarisDetail label="ID Transaksi" nilai={d.id} />
                      <BarisDetail label="Dibuat" nilai={`${waktuSingkat(d.createdAt)} · ${d.namaPembuat ?? d.createdBy}`} />
                      <BarisDetail label="Jurnal yang Terbentuk" nilai={d.nomorJurnal ?? 'Belum ada'} />
                      <BarisDetail label="Tanggal Posting" nilai={waktuSingkat(d.tanggalPosting)} />
                      <BarisDetail label="User Posting" nilai={d.userPosting ?? '-'} />
                    </View>
                  ) : null}

                  {d.status === 'DRAFT' &&
                    (batalId === d.id ? (
                      <View style={{ marginTop: spacing.sm }}>
                        <FocusTextInput
                          style={styles.input}
                          value={alasanBatal}
                          onChangeText={setAlasanBatal}
                          placeholder="Alasan pembatalan (wajib)"
                          placeholderTextColor={colors.placeholder}
                        />
                        <View style={styles.aksiRow}>
                          <TouchableOpacity
                            style={styles.tombolSekunder}
                            onPress={() => {
                              setBatalId(null);
                              setAlasanBatal('');
                            }}
                            disabled={membatalkan}
                          >
                            <Text style={styles.tombolSekunderText}>Kembali</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.tombolBahaya, membatalkan && styles.nonaktif]}
                            onPress={() => void batalkan(d.id)}
                            disabled={membatalkan}
                          >
                            <Text style={styles.tombolBahayaText}>Konfirmasi Batalkan</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <View style={styles.aksiRow}>
                        <TouchableOpacity
                          style={styles.tombolSekunder}
                          onPress={() => {
                            setBatalId(d.id);
                            setAlasanBatal('');
                          }}
                          accessibilityRole="button"
                        >
                          <Ionicons name="close-circle-outline" size={16} color={colors.danger} />
                          <Text style={[styles.tombolSekunderText, { color: colors.danger }]}>Batalkan Draft</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.tombolPosting, memuatPosting === d.id && styles.nonaktif]}
                          onPress={() => void bukaPosting(d)}
                          disabled={memuatPosting !== null}
                          accessibilityRole="button"
                        >
                          {memuatPosting === d.id ? (
                            <ActivityIndicator color={colors.white} size="small" />
                          ) : (
                            <>
                              <Ionicons name="checkmark-done-outline" size={16} color={colors.white} />
                              <Text style={styles.tombolPostingText}>Tinjau & Posting</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </View>
                    ))}
                </View>
              );
            })
          )}
        </ScrollView>

        {/* ============ LEMBAR KONFIRMASI POSTING ============ */}
        <Modal visible={lembarPosting !== null} transparent animationType="slide" onRequestClose={() => setLembarPosting(null)}>
          <View style={styles.overlay}>
            <SafeAreaView edges={['bottom']} style={styles.lembar}>
              <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
                <View style={styles.pegangan} />
                {lembarPosting ? (
                  <>
                    <Text style={styles.lembarJudul}>Posting Penilaian?</Text>
                    <Text style={styles.lembarSub}>
                      {lembarPosting.rencana.namaObjek} · per {lembarPosting.rencana.tanggal}
                    </Text>
                    <PanelPerhitungan rencana={lembarPosting.rencana} />
                    <Text style={styles.lembarCatatan}>
                      Nilai tercatat dihitung ulang saat posting. Penilaian yang sudah diposting bersifat final — koreksi
                      dilakukan dengan penilaian baru pada tanggal sesudahnya.
                    </Text>
                    <View style={styles.aksiRow}>
                      <TouchableOpacity style={styles.tombolSekunder} onPress={() => setLembarPosting(null)} disabled={memposting}>
                        <Text style={styles.tombolSekunderText}>Periksa Lagi</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.tombolPosting,
                          (memposting || lembarPosting.rencana.hambatan.length > 0) && styles.nonaktif,
                        ]}
                        onPress={() => void konfirmasiPosting()}
                        disabled={memposting || lembarPosting.rencana.hambatan.length > 0}
                        accessibilityRole="button"
                      >
                        {memposting ? (
                          <ActivityIndicator color={colors.white} size="small" />
                        ) : (
                          <>
                            <Ionicons name="checkmark-circle-outline" size={16} color={colors.white} />
                            <Text style={styles.tombolPostingText}>Posting Jurnal</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  </>
                ) : null}
              </ScrollView>
            </SafeAreaView>
          </View>
        </Modal>
      </View>
    </AreaAmanKeyboard>
  );
}

/**
 * Hasil perhitungan service: nilai, selisih, pembagian laba rugi/OCI,
 * jurnal yang akan terbentuk, dan hambatan posting. Murni tampilan.
 */
function PanelPerhitungan({ rencana }: { rencana: RencanaPostingNilaiWajar }) {
  return (
    <View style={styles.panel}>
      <BarisAngka label="Nilai tercatat" nilai={formatRupiah(rencana.nilaiTercatatSebelum)} />
      <BarisAngka label="Nilai wajar" nilai={formatRupiah(rencana.nilaiWajar)} />
      <View style={styles.panelPemisah} />
      <BarisAngka
        label={`Selisih · ${LABEL_ARAH[rencana.arahPerubahan]}`}
        nilai={rupiahBertanda(rencana.selisih)}
        warna={warnaSelisih(rencana.selisih)}
        tebal
      />
      {rencana.selisih !== 0 ? (
        <View style={styles.pembagianRow}>
          <Pil label="Laba rugi" nilai={rencana.jumlahLabaRugi} />
          <Pil label="OCI" nilai={rencana.jumlahOci} />
        </View>
      ) : null}

      {rencana.baris.length > 0 ? (
        <>
          <Text style={styles.jurnalJudul}>Jurnal yang akan terbentuk</Text>
          <View style={styles.tabel}>
            <View style={[styles.tabelBaris, styles.tabelKepala]}>
              <Text style={[styles.tabelAkun, styles.tabelKepalaText]}>Akun</Text>
              <Text style={[styles.tabelAngka, styles.tabelKepalaText]}>Debit</Text>
              <Text style={[styles.tabelAngka, styles.tabelKepalaText]}>Kredit</Text>
            </View>
            {rencana.baris.map((b, i) => (
              <View key={`${b.accountId}-${i}`} style={styles.tabelBaris}>
                <View style={styles.tabelAkun}>
                  <Text style={[styles.tabelKode, b.kredit > 0 && { paddingLeft: spacing.md }]}>{b.kode}</Text>
                  <Text style={[styles.tabelNama, b.kredit > 0 && { paddingLeft: spacing.md }]} numberOfLines={2}>
                    {b.nama}
                  </Text>
                </View>
                <Text style={styles.tabelAngka}>{b.debit > 0 ? formatRupiah(b.debit) : ''}</Text>
                <Text style={styles.tabelAngka}>{b.kredit > 0 ? formatRupiah(b.kredit) : ''}</Text>
              </View>
            ))}
          </View>
        </>
      ) : (
        <Text style={styles.petunjuk}>Tidak ada selisih — penilaian dicatat tanpa jurnal.</Text>
      )}

      {rencana.hambatan.length > 0 ? (
        <View style={[styles.infoBox, styles.infoPeringatan]}>
          <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.infoText, { fontWeight: '700' }]}>Belum dapat diposting</Text>
            {rencana.hambatan.map((h) => (
              <Text key={h.kode + h.pesan} style={styles.infoText}>
                • {h.pesan}
              </Text>
            ))}
          </View>
        </View>
      ) : (
        <View style={[styles.infoBox, styles.infoSiap]}>
          <Ionicons name="checkmark-circle-outline" size={16} color={colors.success} />
          <Text style={[styles.infoText, { color: colors.success }]}>Siap diposting.</Text>
        </View>
      )}
    </View>
  );
}

function Kartu({ judul, ikon, children }: { judul: string; ikon: keyof typeof Ionicons.glyphMap; children: React.ReactNode }) {
  return (
    <View style={styles.kartu}>
      <View style={styles.kartuHeader}>
        <Ionicons name={ikon} size={18} color={colors.primary} />
        <Text style={styles.kartuJudul}>{judul}</Text>
      </View>
      {children}
    </View>
  );
}

function Langkah({ nomor, judul }: { nomor: number; judul: string }) {
  return (
    <View style={styles.langkah}>
      <View style={styles.langkahNomor}>
        <Text style={styles.langkahNomorText}>{nomor}</Text>
      </View>
      <Text style={styles.langkahJudul}>{judul}</Text>
    </View>
  );
}

function Stat({ label, nilai, warna }: { label: string; nilai: string; warna?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.statNilai, warna ? { color: warna } : null]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
        {nilai}
      </Text>
    </View>
  );
}

function Pil({ label, nilai }: { label: string; nilai: number }) {
  return (
    <View style={styles.pil}>
      <Text style={styles.pilLabel}>{label}</Text>
      <Text style={[styles.pilNilai, { color: warnaSelisih(nilai) }]}>{rupiahBertanda(nilai)}</Text>
    </View>
  );
}

function BarisAngka({ label, nilai, warna, tebal }: { label: string; nilai: string; warna?: string; tebal?: boolean }) {
  return (
    <View style={styles.barisAngka}>
      <Text style={[styles.barisAngkaLabel, tebal && { fontWeight: '700', color: colors.text }]}>{label}</Text>
      <Text style={[styles.barisAngkaNilai, tebal && { fontWeight: '800' }, warna ? { color: warna } : null]}>{nilai}</Text>
    </View>
  );
}

function BarisDetail({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.barisDetail}>
      <Text style={styles.barisDetailLabel}>{label}</Text>
      <Text style={styles.barisDetailNilai} selectable>
        {nilai}
      </Text>
    </View>
  );
}

function Galat({ teks }: { teks?: string }) {
  if (!teks) return null;
  return (
    <View style={styles.galatRow}>
      <Ionicons name="alert-circle" size={13} color={colors.danger} />
      <Text style={styles.galatText}>{teks}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xxl * 2 },

  segmen: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    marginBottom: spacing.md,
  },
  segmenItem: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.pill,
  },
  segmenItemAktif: { backgroundColor: colors.primary },
  segmenText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  segmenTextAktif: { color: colors.white },

  kebijakan: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  kebijakanIkon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kebijakanJudulRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 },
  kebijakanJudul: { fontSize: 14, fontWeight: '800', color: colors.primary },
  kebijakanDasar: { fontSize: 11, color: colors.textMuted },
  kebijakanText: { fontSize: 12, color: colors.text, lineHeight: 17, marginTop: 4 },

  statRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  stat: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  statLabel: { fontSize: 10, color: colors.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3 },
  statNilai: { fontSize: 13, fontWeight: '800', color: colors.text, marginTop: 2, fontVariant: ['tabular-nums'] },

  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...elevation.card,
  },
  kartuHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  kartuJudul: { fontSize: 15, fontWeight: '800', color: colors.text },

  langkah: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg, marginBottom: spacing.sm },
  langkahNomor: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  langkahNomorText: { fontSize: 12, fontWeight: '800', color: colors.white },
  langkahJudul: { fontSize: 13, fontWeight: '700', color: colors.text },

  label: { ...formUi.label },
  input: { ...formUi.inputStandalone },
  textArea: { ...formUi.inputStandaloneMultiline },
  inputGalat: { borderColor: colors.danger, backgroundColor: colors.dangerBg },

  opsiObjek: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginBottom: spacing.xs,
    backgroundColor: colors.surface,
  },
  opsiObjekAktif: { borderColor: colors.primary, backgroundColor: colors.focusBg },
  opsiNama: { fontSize: 14, fontWeight: '600', color: colors.text },
  opsiNamaAktif: { color: colors.primary },
  opsiMeta: { fontSize: 11, color: colors.textMuted, marginTop: 1 },

  panel: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    padding: spacing.md,
  },
  panelPemisah: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  barisAngka: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, gap: spacing.sm },
  barisAngkaLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  barisAngkaNilai: { fontSize: 13, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },

  pembagianRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  pil: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  pilLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  pilNilai: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },

  jurnalJudul: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  tabel: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface, overflow: 'hidden' },
  tabelBaris: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  tabelKepala: { backgroundColor: colors.primaryLight, borderTopWidth: 0 },
  tabelKepalaText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  tabelAkun: { flex: 1.6, paddingRight: spacing.xs },
  tabelKode: { fontSize: 11, fontWeight: '700', color: colors.textMuted, fontVariant: ['tabular-nums'] },
  tabelNama: { fontSize: 12, color: colors.text },
  tabelAngka: { flex: 1, fontSize: 12, textAlign: 'right', color: colors.text, fontVariant: ['tabular-nums'] },

  infoBox: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.md },
  infoPeringatan: { backgroundColor: colors.warningBg, borderWidth: 1, borderColor: colors.warningBorder },
  infoBahaya: { backgroundColor: colors.dangerBg },
  infoSiap: { backgroundColor: colors.primaryLight },
  infoText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  petunjuk: { fontSize: 12, color: colors.textFaint, marginTop: spacing.sm, lineHeight: 17 },
  footnote: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm, lineHeight: 15 },

  tombolUtama: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
  },
  tombolUtamaText: { color: colors.white, fontWeight: '800', fontSize: 15 },
  nonaktif: { opacity: 0.55 },

  riwayatHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: spacing.sm },
  riwayatJudul: { fontSize: 15, fontWeight: '800', color: colors.text },
  riwayatSub: { fontSize: 12, color: colors.textMuted },
  filterRow: { gap: spacing.sm, paddingBottom: spacing.md },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterChipAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  filterTextAktif: { color: colors.white },

  kosongBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  kosongText: { fontSize: 12, color: colors.textMuted, flex: 1 },
  errorText: { fontSize: 12, color: colors.danger },
  link: { fontSize: 12, color: colors.primary, marginTop: spacing.xs, fontWeight: '600' },

  item: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...elevation.card,
  },
  itemAtas: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  itemJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  itemMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  nilaiRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md, gap: spacing.sm },
  nilaiKol: { flex: 1 },
  nilaiLabel: { fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 },
  nilaiAngka: { fontSize: 14, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'], marginTop: 1 },
  selisihRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  selisihLabel: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  selisihAngka: { fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  jurnalText: { fontSize: 11, color: colors.textMuted },

  detailToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm, alignSelf: 'flex-start' },
  detailToggleText: { fontSize: 12, fontWeight: '600', color: colors.primary },
  detail: { marginTop: spacing.xs, backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.sm },
  barisDetail: { paddingVertical: 3 },
  barisDetailLabel: { fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 },
  barisDetailNilai: { fontSize: 12, color: colors.text, marginTop: 1 },

  aksiRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  tombolSekunder: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tombolSekunderText: { fontSize: 13, fontWeight: '700', color: colors.text },
  tombolBahaya: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: radius.sm,
    backgroundColor: colors.danger,
  },
  tombolBahayaText: { fontSize: 13, fontWeight: '700', color: colors.white },
  tombolPosting: {
    flex: 1.3,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  tombolPostingText: { fontSize: 13, fontWeight: '800', color: colors.white },

  galatRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  galatText: { fontSize: 12, color: colors.danger, flex: 1 },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  lembar: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, maxHeight: '90%' },
  pegangan: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md },
  lembarJudul: { fontSize: 17, fontWeight: '800', color: colors.text },
  lembarSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  lembarCatatan: { fontSize: 11, color: colors.textMuted, marginTop: spacing.md, lineHeight: 15 },
});
