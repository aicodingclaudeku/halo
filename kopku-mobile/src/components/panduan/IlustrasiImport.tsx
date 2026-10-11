import React, { useEffect, useRef, useState } from 'react';
import { Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius } from '@/theme/colors';
import { kolomWajibIlustrasi, ribuan, tanggalPanjang, hariSebelumIso, type IlustrasiImport } from '@/import/PanduanImportData';

/**
 * RC-S133.4.7 — ILUSTRASI BERANIMASI untuk panduan Import Data Awal.
 *
 * Digambar dengan komponen React Native (bukan gambar), meniru lembar
 * Excel template KOPKU: bar judul hijau, baris contoh kuning, tab sheet di
 * bawah. Kolom yang sedang dijelaskan DISOROT bergantian dan isinya
 * "diketik" di bilah rumus, supaya pengguna melihat persis sel mana yang
 * diisi dan dengan bentuk apa.
 *
 * Murni tampilan: tidak membaca atau menulis data apa pun. Seluruh animasi
 * memakai driver JS (`useNativeDriver: false`) supaya perilakunya sama di
 * HP dan desktop (react-native-web), dan setiap loop dihentikan saat
 * komponen dilepas (hanya slide yang aktif yang dipasang).
 */

const BIRU = '#1E5AA8';
const BIRU_MUDA = '#E8F0FB';
const ABU_KEPALA = '#EEF1EE';
const KUNING = '#FFF6D9';
const KUNING_TEKS = '#8A5300';
const HURUF = 'ABCDEFGHIJKLMNOP';

/** Indeks yang berputar 0..n-1 setiap `ms`. */
function useDetak(n: number, ms: number): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (n <= 1) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), ms);
    return () => clearInterval(t);
  }, [n, ms]);
  return i;
}

/** Nilai 0→1→0 berulang (denyut). */
function useDenyut(ms = 900) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: ms, useNativeDriver: false }),
        Animated.timing(v, { toValue: 0, duration: ms, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [v, ms]);
  return v;
}

/** Muncul (fade + naik) setiap kali `kunci` berubah. */
function Muncul({ kunci, children, jeda = 0 }: { kunci: string | number; children: React.ReactNode; jeda?: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    v.setValue(0);
    const a = Animated.timing(v, { toValue: 1, duration: 380, delay: jeda, useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [kunci, v, jeda]);
  return (
    <Animated.View
      style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}
    >
      {children}
    </Animated.View>
  );
}

// ===========================================================================
// LEMBAR EXCEL
// ===========================================================================

function lebarKolom(label: string): number {
  return Math.max(88, Math.min(150, label.length * 7.2 + 22));
}

function LembarExcel({ il }: { il: Extract<IlustrasiImport, { jenis: 'SHEET' }> }) {
  const langkah = useDetak(il.sorot.length, 2800);
  const kolomAktif = il.sorot[langkah] ?? 0;
  const nilai = il.baris[0]?.[kolomAktif] ?? '';
  const [ketik, setKetik] = useState(0);
  const denyut = useDenyut(700);
  const tabRef = useRef<any>(null);

  // Mesin ketik di bilah rumus.
  useEffect(() => {
    setKetik(0);
    const t = setInterval(() => setKetik((n) => (n >= nilai.length ? n : n + 1)), 75);
    return () => clearInterval(t);
  }, [nilai, langkah]);

  // Tab aktif digulir ke tengah.
  useEffect(() => {
    const i = il.tab.indexOf(il.tabAktif);
    const x = il.tab.slice(0, Math.max(0, i - 1)).reduce((t, n) => t + n.length * 6.2 + 22, 0);
    const id = setTimeout(() => tabRef.current?.scrollTo?.({ x, animated: false }), 30);
    return () => clearTimeout(id);
  }, [il.tab, il.tabAktif]);

  const alamat = `${HURUF[kolomAktif]}4`;
  const lebar = il.kolom.map(lebarKolom);
  const gridRef = useRef<any>(null);
  // Layar sempit (HP): geser lembar supaya kolom yang dijelaskan selalu terlihat.
  useEffect(() => {
    const x = Math.max(0, lebar.slice(0, kolomAktif).reduce((t, w) => t + w, 0) - 40);
    gridRef.current?.scrollTo?.({ x, animated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kolomAktif]);

  return (
    <View style={s.excel}>
      <View style={s.excelJudul}>
        <Ionicons name="grid" size={12} color={colors.white} />
        <Text style={s.excelJudulTeks} numberOfLines={1}>
          Template KOPKU.xlsx
        </Text>
      </View>
      <View style={s.bilahRumus}>
        <Text style={s.alamatSel}>{alamat}</Text>
        <Text style={s.fx}>fx</Text>
        <Text style={s.isiRumus} numberOfLines={1}>
          {nilai.slice(0, ketik)}
          <Text style={s.kursorKetik}>|</Text>
        </Text>
      </View>

      <ScrollView ref={gridRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.gridIsi}>
        <View>
          {/* Huruf kolom */}
          <View style={s.baris}>
            <View style={[s.nomorBaris, s.sudut]} />
            {il.kolom.map((k, c) => (
              <View key={k} style={[s.hurufKolom, { width: lebar[c] }, c === kolomAktif && s.hurufKolomAktif]}>
                <Text style={[s.hurufTeks, c === kolomAktif && { color: colors.primary }]}>{HURUF[c]}</Text>
              </View>
            ))}
          </View>
          {/* Baris 3 = judul kolom (seperti di template) */}
          <View style={s.baris}>
            <View style={s.nomorBaris}>
              <Text style={s.nomorTeks}>3</Text>
            </View>
            {il.kolom.map((k, c) => (
              <View key={k} style={[s.selJudul, { width: lebar[c] }]}>
                <Text style={s.selJudulTeks} numberOfLines={2}>
                  {k}
                  {kolomWajibIlustrasi(il.tabAktif, k) ? ' *' : ''}
                </Text>
                {c === kolomAktif && (
                  <Animated.View
                    pointerEvents="none"
                    style={[s.bingkaiSorot, { opacity: denyut.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }]}
                  />
                )}
              </View>
            ))}
          </View>
          {/* Baris data (baris contoh sudah dihapus, data mulai baris 4) */}
          {il.baris.map((b, r) => (
            <View key={r} style={s.baris}>
              <View style={s.nomorBaris}>
                <Text style={s.nomorTeks}>{r + 4}</Text>
              </View>
              {b.map((v, c) => {
                const aktif = c === kolomAktif;
                const angka = /^[\d.,]+$/.test(v) && v.length > 0;
                return (
                  <View key={c} style={[s.sel, { width: lebar[c] }, aktif && s.selKolomAktif]}>
                    <Text
                      style={[s.selTeks, angka && { textAlign: 'right' }, v === '' && { color: colors.textFaint }]}
                      numberOfLines={1}
                    >
                      {aktif && r === 0 ? v.slice(0, ketik) : v === '' ? '(kosong)' : v}
                    </Text>
                    {aktif && r === 0 && <View pointerEvents="none" style={s.kursorSel} />}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>

      <Muncul kunci={langkah}>
        <View style={s.gelembung}>
          <View style={s.gelembungHuruf}>
            <Text style={s.gelembungHurufTeks}>{HURUF[kolomAktif]}</Text>
          </View>
          <Text style={s.gelembungTeks}>
            <Text style={{ fontWeight: '800' }}>{il.kolom[kolomAktif]}</Text>
            {'  '}
            {il.keterangan[langkah]}
          </Text>
        </View>
      </Muncul>

      <ScrollView ref={tabRef} horizontal showsHorizontalScrollIndicator={false} style={s.tabStrip}>
        {il.tab.map((t) => (
          <View key={t} style={[s.tab, t === il.tabAktif && s.tabAktif]}>
            <Text style={[s.tabTeks, t === il.tabAktif && s.tabTeksAktif]}>{t}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// ===========================================================================
// ILUSTRASI LAIN
// ===========================================================================

function Alur({ tahap }: { tahap: { ikon: string; label: string }[] }) {
  const aktif = useDetak(tahap.length, 1200);
  const maju = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(maju, { toValue: aktif / Math.max(1, tahap.length - 1), duration: 500, useNativeDriver: false }).start();
  }, [aktif, maju, tahap.length]);
  return (
    <View style={s.alur}>
      <View style={s.alurRel}>
        <Animated.View style={[s.alurRelIsi, { width: maju.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
      </View>
      <View style={s.alurBaris}>
        {tahap.map((t, i) => {
          const sudah = i <= aktif;
          return (
            <View key={t.label} style={s.alurItem}>
              <View style={[s.alurBulat, sudah && s.alurBulatAktif, i === aktif && s.alurBulatKini]}>
                <Ionicons name={t.ikon as any} size={i === aktif ? 22 : 18} color={sudah ? colors.white : colors.textMuted} />
              </View>
              <Text style={[s.alurLabel, i === aktif && { color: colors.primary, fontWeight: '800' }]}>{t.label}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function CutOff({ tanggal }: { tanggal: string }) {
  const denyut = useDenyut(800);
  return (
    <View style={s.cutoff}>
      <View style={s.cutoffRel}>
        <View style={[s.cutoffBagian, { backgroundColor: '#DADFDA' }]}>
          <Text style={s.cutoffBagianTeks}>Pembukuan lama</Text>
        </View>
        <View style={[s.cutoffBagian, { backgroundColor: colors.primary }]}>
          <Text style={[s.cutoffBagianTeks, { color: colors.white }]}>Dicatat di KOPKU</Text>
        </View>
        <Animated.View
          style={[
            s.cutoffPenanda,
            { transform: [{ scale: denyut.interpolate({ inputRange: [0, 1], outputRange: [1, 1.25] }) }] },
          ]}
        />
      </View>
      <View style={s.cutoffLabelBaris}>
        <View style={[s.cutoffLabel, { alignItems: 'flex-end' }]}>
          <Text style={s.cutoffKecil}>POSISI SALDO DI BERKAS</Text>
          <Text style={s.cutoffTanggal}>{tanggalPanjang(hariSebelumIso(tanggal))}</Text>
          <Text style={s.cutoffKecil}>akhir hari</Text>
        </View>
        <View style={s.cutoffGaris} />
        <View style={s.cutoffLabel}>
          <Text style={[s.cutoffKecil, { color: colors.primary }]}>TANGGAL CUT-OFF</Text>
          <Text style={[s.cutoffTanggal, { color: colors.primary }]}>{tanggalPanjang(tanggal)}</Text>
          <Text style={s.cutoffKecil}>hari pertama di KOPKU</Text>
        </View>
      </View>
    </View>
  );
}

function Dokumen({ daftar }: { daftar: string[] }) {
  const putaran = useDetak(2, 7000);
  const vals = useRef(daftar.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    vals.forEach((v) => v.setValue(0));
    const a = Animated.stagger(
      420,
      vals.map((v) => Animated.timing(v, { toValue: 1, duration: 320, useNativeDriver: false }))
    );
    a.start();
    return () => a.stop();
  }, [putaran, vals]);
  return (
    <View style={s.dokumen}>
      {daftar.map((d, i) => (
        <View key={d} style={s.dokumenBaris}>
          <Animated.View
            style={[
              s.kotakCentang,
              {
                backgroundColor: vals[i].interpolate({ inputRange: [0, 1], outputRange: [colors.surface, colors.primary] }),
                transform: [{ scale: vals[i].interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 1.2, 1] }) }],
              },
            ]}
          >
            <Ionicons name="checkmark" size={12} color={colors.white} />
          </Animated.View>
          <Text style={s.dokumenTeks}>{d}</Text>
        </View>
      ))}
    </View>
  );
}

function Pilih() {
  const gerak = useDenyut(1100);
  return (
    <View style={s.pilih}>
      {[
        { judul: 'Saldo Lama', sub: 'Koperasi sudah berjalan', ikon: 'archive-outline', kas: 'Kas tidak berubah', bergerak: false },
        { judul: 'Transaksi Baru', sub: 'Koperasi baru / uang bergerak sekarang', ikon: 'swap-horizontal-outline', kas: 'Kas bertambah / berkurang', bergerak: true },
      ].map((p) => (
        <View key={p.judul} style={s.pilihKartu}>
          <Ionicons name={p.ikon as any} size={22} color={colors.primary} />
          <Text style={s.pilihJudul}>{p.judul}</Text>
          <Text style={s.pilihSub}>{p.sub}</Text>
          <View style={s.pilihKas}>
            <View style={s.kasKotak}>
              <Ionicons name="wallet-outline" size={16} color={colors.primary} />
              {p.bergerak ? (
                <Animated.View
                  style={[
                    s.koin,
                    {
                      opacity: gerak.interpolate({ inputRange: [0, 0.8, 1], outputRange: [1, 1, 0] }),
                      transform: [{ translateY: gerak.interpolate({ inputRange: [0, 1], outputRange: [-18, 2] }) }],
                    },
                  ]}
                />
              ) : (
                <Ionicons name="lock-closed" size={10} color={colors.textMuted} style={s.gembok} />
              )}
            </View>
            <Text style={s.pilihKasTeks}>{p.kas}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function Neraca({ il }: { il: Extract<IlustrasiImport, { jenis: 'NERACA' }> }) {
  const putaran = useDetak(2, 6000);
  const v = useRef(new Animated.Value(0)).current;
  const [p, setP] = useState(0);
  useEffect(() => {
    const id = v.addListener(({ value }) => setP(value));
    v.setValue(0);
    const a = Animated.timing(v, { toValue: 1, duration: 1600, useNativeDriver: false });
    a.start();
    return () => {
      a.stop();
      v.removeListener(id);
    };
  }, [putaran, v]);
  const tD = il.debit.reduce((t, b) => t + b.nilai, 0);
  const tK = il.kredit.reduce((t, b) => t + b.nilai, 0);
  const kolom = (judul: string, isi: typeof il.debit, total: number) => (
    <View key={judul} style={s.neracaKolom}>
      <Text style={s.neracaJudul}>{judul}</Text>
      {isi.map((b) => (
        <View key={b.akun} style={s.neracaBaris}>
          <View style={[s.lencana, b.asal === 'OTOMATIS' ? s.lencanaOto : s.lencana7]}>
            <Text style={[s.lencanaTeks, { color: b.asal === 'OTOMATIS' ? colors.primary : BIRU }]}>
              {b.asal === 'OTOMATIS' ? 'oto' : 'sh 7'}
            </Text>
          </View>
          <Text style={s.neracaAkun} numberOfLines={1}>
            {b.akun}
          </Text>
          <Text style={s.neracaNilai}>{ribuan(b.nilai)}</Text>
        </View>
      ))}
      <View style={s.neracaTotal}>
        <Text style={s.neracaTotalLabel}>Total</Text>
        <Text style={s.neracaTotalNilai}>{ribuan(Math.round(total * p))}</Text>
      </View>
    </View>
  );
  return (
    <View style={s.neraca}>
      <View style={s.neracaDua}>
        {kolom('DEBIT', il.debit, tD)}
        {kolom('KREDIT', il.kredit, tK)}
      </View>
      <View style={[s.neracaHasil, p < 1 && { opacity: 0.25 }]}>
        <Ionicons name={tD === tK ? 'checkmark-circle' : 'alert-circle'} size={16} color={tD === tK ? colors.success : colors.danger} />
        <Text style={s.neracaHasilTeks}>
          {tD === tK ? 'Seimbang — Saldo Awal Belum Sesuai: Rp0' : `Selisih Rp${ribuan(Math.abs(tD - tK))}`}
        </Text>
      </View>
      <View style={s.legenda}>
        <View style={[s.lencana, s.lencanaOto]}>
          <Text style={[s.lencanaTeks, { color: colors.primary }]}>oto</Text>
        </View>
        <Text style={s.legendaTeks}>otomatis dari sheet 2–5</Text>
        <View style={[s.lencana, s.lencana7]}>
          <Text style={[s.lencanaTeks, { color: BIRU }]}>sh 7</Text>
        </View>
        <Text style={s.legendaTeks}>diketik di sheet 7</Text>
      </View>
    </View>
  );
}

function Format({ baris }: { baris: { contoh: string; sah: boolean; catatan: string }[] }) {
  const putaran = useDetak(2, 8000);
  return (
    <View style={s.format}>
      {baris.map((b, i) => (
        <Muncul key={`${b.contoh}-${putaran}`} kunci={putaran} jeda={i * 260}>
          <View style={[s.formatBaris, b.sah ? s.formatSah : s.formatSalah]}>
            <Ionicons name={b.sah ? 'checkmark-circle' : 'close-circle'} size={16} color={b.sah ? colors.success : colors.danger} />
            <Text style={[s.formatContoh, !b.sah && { textDecorationLine: 'line-through', color: colors.danger }]} numberOfLines={1}>
              {b.contoh}
            </Text>
            <Text style={s.formatCatatan} numberOfLines={2}>
              {b.catatan}
            </Text>
          </View>
        </Muncul>
      ))}
    </View>
  );
}

function HapusContoh({ il }: { il: Extract<IlustrasiImport, { jenis: 'HAPUS_CONTOH' }> }) {
  const coret = useRef(new Animated.Value(0)).current;
  const lipat = useRef(new Animated.Value(0)).current;
  const [terhapus, setTerhapus] = useState(false);
  useEffect(() => {
    const id = lipat.addListener(({ value }) => setTerhapus(value > 0.5));
    return () => lipat.removeListener(id);
  }, [lipat]);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(700),
        Animated.timing(coret, { toValue: 1, duration: 700, useNativeDriver: false }),
        Animated.delay(300),
        Animated.timing(lipat, { toValue: 1, duration: 500, useNativeDriver: false }),
        Animated.delay(1500),
        Animated.parallel([
          Animated.timing(coret, { toValue: 0, duration: 1, useNativeDriver: false }),
          Animated.timing(lipat, { toValue: 0, duration: 1, useNativeDriver: false }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [coret, lipat]);
  const lebar = il.kolom.map((k) => Math.max(92, k.length * 7 + 20));
  return (
    <View style={s.excel}>
      <View style={s.excelJudul}>
        <Ionicons name="grid" size={12} color={colors.white} />
        <Text style={s.excelJudulTeks}>Baris 4 = contoh → hapus</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.gridIsi}>
        <View>
          <View style={s.baris}>
            <View style={s.nomorBaris}>
              <Text style={s.nomorTeks}>3</Text>
            </View>
            {il.kolom.map((k, c) => (
              <View key={k} style={[s.selJudul, { width: lebar[c] }]}>
                <Text style={s.selJudulTeks}>{k} *</Text>
              </View>
            ))}
          </View>
          <Animated.View
            style={{
              height: lipat.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }),
              opacity: lipat.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
              overflow: 'hidden',
            }}
          >
            <View style={s.baris}>
              <View style={s.nomorBaris}>
                <Text style={s.nomorTeks}>4</Text>
              </View>
              {il.contoh.map((v, c) => (
                <View key={c} style={[s.sel, { width: lebar[c], backgroundColor: KUNING }]}>
                  <Text style={[s.selTeks, { color: KUNING_TEKS, fontStyle: 'italic' }]} numberOfLines={1}>
                    {v}
                  </Text>
                </View>
              ))}
              <Animated.View
                pointerEvents="none"
                style={[
                  s.garisCoret,
                  { width: coret.interpolate({ inputRange: [0, 1], outputRange: [0, lebar.reduce((t, x) => t + x, 0)] }) },
                ]}
              />
            </View>
          </Animated.View>
          {il.data.map((b, r) => (
            <View key={r} style={s.baris}>
              <View style={s.nomorBaris}>
                <Text style={s.nomorTeks}>{r + (terhapus ? 4 : 5)}</Text>
              </View>
              {b.map((v, c) => (
                <View key={c} style={[s.sel, { width: lebar[c] }]}>
                  <Text style={s.selTeks} numberOfLines={1}>
                    {v}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={s.hapusCatatan}>
        <Ionicons name="trash-outline" size={13} color={colors.danger} />
        <Text style={s.hapusCatatanTeks}>Klik kanan nomor baris 4 › Delete</Text>
      </View>
    </View>
  );
}

function Periksa() {
  const tahap = useDetak(2, 2800);
  const galat = tahap === 0;
  return (
    <View style={s.periksa}>
      <Text style={s.periksaJudul}>HASIL PEMERIKSAAN</Text>
      <Muncul kunci={tahap}>
        <View style={[s.periksaBanner, galat ? s.periksaBannerGalat : s.periksaBannerOk]}>
          <Ionicons name={galat ? 'alert-circle' : 'checkmark-circle'} size={16} color={galat ? colors.danger : colors.success} />
          <Text style={s.periksaBannerTeks}>{galat ? '1 kesalahan — perbaiki di Excel' : '12 baris siap diimpor'}</Text>
        </View>
        {galat ? (
          <View style={s.periksaGalat}>
            <View style={s.pilBaris}>
              <Text style={s.pilBarisTeks}>Baris 6</Text>
            </View>
            <Text style={s.periksaGalatTeks}>3. Pinjaman — Angsuran Sudah Dibayar (14) melebihi Tenor (12).</Text>
          </View>
        ) : (
          <View style={s.periksaGrid}>
            {['1. Anggota', '2. Simpanan', '3. Pinjaman', '7. Saldo Awal'].map((t) => (
              <View key={t} style={s.periksaChip}>
                <Ionicons name="checkmark" size={11} color={colors.success} />
                <Text style={s.periksaChipTeks}>{t}</Text>
              </View>
            ))}
          </View>
        )}
        <View style={[s.periksaTombol, galat && { opacity: 0.35 }]}>
          <Ionicons name="cloud-upload-outline" size={14} color={colors.white} />
          <Text style={s.periksaTombolTeks}>{galat ? 'Import (terkunci)' : 'Import 12 Baris'}</Text>
        </View>
      </Muncul>
    </View>
  );
}

function Selesai() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.spring(v, { toValue: 1, friction: 5, useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [v]);
  return (
    <View style={s.selesai}>
      <Animated.View style={[s.selesaiBulat, { transform: [{ scale: v }] }]}>
        <Ionicons name="checkmark" size={40} color={colors.white} />
      </Animated.View>
      {['Saldo Awal Belum Sesuai: Rp0', 'Neraca = pembukuan lama', 'Pinjaman perlu dicek: 0'].map((t, i) => (
        <Muncul key={t} kunci="s" jeda={350 + i * 300}>
          <View style={s.selesaiChip}>
            <Ionicons name="checkmark-circle" size={14} color={colors.success} />
            <Text style={s.selesaiChipTeks}>{t}</Text>
          </View>
        </Muncul>
      ))}
    </View>
  );
}

export default function IlustrasiImportView({ ilustrasi }: { ilustrasi: IlustrasiImport }) {
  switch (ilustrasi.jenis) {
    case 'SHEET':
      return <LembarExcel il={ilustrasi} />;
    case 'ALUR':
      return <Alur tahap={ilustrasi.tahap} />;
    case 'CUTOFF':
      return <CutOff tanggal={ilustrasi.tanggalCutOff} />;
    case 'DOKUMEN':
      return <Dokumen daftar={ilustrasi.daftar} />;
    case 'PILIH':
      return <Pilih />;
    case 'NERACA':
      return <Neraca il={ilustrasi} />;
    case 'FORMAT':
      return <Format baris={ilustrasi.baris} />;
    case 'HAPUS_CONTOH':
      return <HapusContoh il={ilustrasi} />;
    case 'PERIKSA':
      return <Periksa />;
    case 'SELESAI':
      return <Selesai />;
    default:
      return null;
  }
}

const s = StyleSheet.create({
  // ---- Excel ----
  excel: { width: '100%', backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  excelJudul: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#1D6F42', paddingHorizontal: 10, paddingVertical: 6 },
  excelJudulTeks: { color: colors.white, fontSize: 11, fontWeight: '700', flex: 1 },
  bilahRumus: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 8, paddingVertical: 5 },
  alamatSel: { fontSize: 10.5, fontWeight: '800', color: colors.textMuted, minWidth: 26 },
  fx: { fontSize: 11, fontStyle: 'italic', color: colors.textFaint },
  isiRumus: { flex: 1, fontSize: 12, color: colors.text, fontVariant: ['tabular-nums'] },
  kursorKetik: { color: colors.primary, fontWeight: '800' },
  gridIsi: { paddingBottom: 2 },
  baris: { flexDirection: 'row' },
  nomorBaris: { width: 28, backgroundColor: ABU_KEPALA, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', minHeight: 28 },
  sudut: { minHeight: 18 },
  nomorTeks: { fontSize: 10, color: colors.textMuted, fontWeight: '700' },
  hurufKolom: { backgroundColor: ABU_KEPALA, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', minHeight: 18 },
  hurufKolomAktif: { backgroundColor: colors.primaryLight },
  hurufTeks: { fontSize: 10, fontWeight: '700', color: colors.textMuted },
  selJudul: { backgroundColor: colors.primary, borderRightWidth: 1, borderRightColor: '#FFFFFF55', paddingHorizontal: 6, paddingVertical: 5, justifyContent: 'center', minHeight: 34 },
  selJudulTeks: { color: colors.white, fontSize: 10.5, fontWeight: '800', textAlign: 'center' },
  bingkaiSorot: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderWidth: 2.5, borderColor: '#FFC400' },
  sel: { borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 6, justifyContent: 'center', minHeight: 28 },
  selKolomAktif: { backgroundColor: '#FFF8E1' },
  selTeks: { fontSize: 11.5, color: colors.text, fontVariant: ['tabular-nums'] },
  kursorSel: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderWidth: 2, borderColor: '#1D6F42' },
  gelembung: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FFF8E1', borderTopWidth: 1, borderTopColor: '#F1D58A', paddingHorizontal: 10, paddingVertical: 8 },
  gelembungHuruf: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFC400', alignItems: 'center', justifyContent: 'center' },
  gelembungHurufTeks: { fontSize: 10.5, fontWeight: '900', color: '#5A3E00' },
  gelembungTeks: { flex: 1, fontSize: 12, color: '#5A3E00', lineHeight: 17 },
  tabStrip: { borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: ABU_KEPALA, flexGrow: 0 },
  tab: { paddingHorizontal: 9, paddingVertical: 5, borderRightWidth: 1, borderRightColor: colors.border },
  tabAktif: { backgroundColor: colors.surface, borderBottomWidth: 2, borderBottomColor: '#1D6F42' },
  tabTeks: { fontSize: 10, color: colors.textMuted },
  tabTeksAktif: { color: '#1D6F42', fontWeight: '800' },

  // ---- Alur ----
  alur: { width: '100%', paddingVertical: 24, paddingHorizontal: 8 },
  alurRel: { position: 'absolute', left: '12.5%', right: '12.5%', top: 24 + 22, height: 4, borderRadius: 2, backgroundColor: colors.border },
  alurRelIsi: { height: 4, borderRadius: 2, backgroundColor: colors.primary },
  alurBaris: { flexDirection: 'row' },
  alurItem: { flex: 1, alignItems: 'center', gap: 8 },
  alurBulat: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  alurBulatAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  alurBulatKini: { transform: [{ scale: 1.12 }], borderColor: '#A5D6A7', borderWidth: 3 },
  alurLabel: { fontSize: 11.5, color: colors.textMuted, textAlign: 'center', fontWeight: '600' },

  // ---- Cut-off ----
  cutoff: { width: '100%', paddingVertical: 18 },
  cutoffRel: { flexDirection: 'row', height: 34, borderRadius: radius.sm, overflow: 'visible' },
  cutoffBagian: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cutoffBagianTeks: { fontSize: 11.5, fontWeight: '800', color: colors.textMuted },
  cutoffPenanda: { position: 'absolute', left: '50%', marginLeft: -9, top: -6, width: 18, height: 46, borderRadius: 9, borderWidth: 3, borderColor: '#FFC400', backgroundColor: 'transparent' },
  cutoffLabelBaris: { flexDirection: 'row', marginTop: 12, alignItems: 'stretch' },
  cutoffLabel: { flex: 1, paddingHorizontal: 8 },
  cutoffGaris: { width: 2, backgroundColor: '#FFC400' },
  cutoffKecil: { fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.3 },
  cutoffTanggal: { fontSize: 15, fontWeight: '900', color: colors.text, marginVertical: 2 },

  // ---- Dokumen ----
  dokumen: { width: '100%', gap: 7, paddingVertical: 6 },
  dokumenBaris: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  kotakCentang: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  dokumenTeks: { flex: 1, fontSize: 12.5, color: colors.text },

  // ---- Pilih ----
  pilih: { width: '100%', flexDirection: 'row', gap: 10 },
  pilihKartu: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 4 },
  pilihJudul: { fontSize: 14, fontWeight: '900', color: colors.text, marginTop: 4 },
  pilihSub: { fontSize: 11, color: colors.textMuted, lineHeight: 15, minHeight: 30 },
  pilihKas: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  kasKotak: { width: 34, height: 34, borderRadius: 8, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  koin: { position: 'absolute', top: 2, width: 10, height: 10, borderRadius: 5, backgroundColor: '#FFC400', borderWidth: 1, borderColor: '#C79100' },
  gembok: { position: 'absolute', right: 2, bottom: 2 },
  pilihKasTeks: { flex: 1, fontSize: 11, fontWeight: '700', color: colors.text },

  // ---- Neraca ----
  neraca: { width: '100%', gap: 8 },
  neracaDua: { flexDirection: 'row', gap: 8 },
  neracaKolom: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, padding: 8 },
  neracaJudul: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.6, marginBottom: 4 },
  neracaBaris: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 },
  neracaAkun: { flex: 1, fontSize: 10.5, color: colors.text },
  neracaNilai: { fontSize: 10.5, color: colors.text, fontVariant: ['tabular-nums'] },
  neracaTotal: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: colors.text, marginTop: 4, paddingTop: 4 },
  neracaTotalLabel: { fontSize: 11, fontWeight: '900', color: colors.text },
  neracaTotalNilai: { fontSize: 11.5, fontWeight: '900', color: colors.primary, fontVariant: ['tabular-nums'] },
  neracaHasil: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', backgroundColor: colors.primaryLight, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  neracaHasilTeks: { fontSize: 12, fontWeight: '800', color: colors.primary },
  lencana: { borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, minWidth: 28, alignItems: 'center' },
  lencanaOto: { backgroundColor: colors.primaryLight },
  lencana7: { backgroundColor: BIRU_MUDA },
  lencanaTeks: { fontSize: 8.5, fontWeight: '900' },
  legenda: { flexDirection: 'row', alignItems: 'center', gap: 4, justifyContent: 'center', flexWrap: 'wrap' },
  legendaTeks: { fontSize: 10, color: colors.textMuted, marginRight: 8 },

  // ---- Format ----
  format: { width: '100%', gap: 5 },
  formatBaris: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1 },
  formatSah: { backgroundColor: '#F2F8F2', borderColor: '#CFE5D0' },
  formatSalah: { backgroundColor: '#FDF1F1', borderColor: '#F3CACA' },
  formatContoh: { width: 150, fontSize: 12, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  formatCatatan: { flex: 1, fontSize: 11, color: colors.textMuted },

  // ---- Hapus contoh ----
  garisCoret: { position: 'absolute', left: 28, top: 13, height: 2.5, backgroundColor: colors.danger },
  hapusCatatan: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.border },
  hapusCatatanTeks: { fontSize: 11.5, color: colors.danger, fontWeight: '700' },

  // ---- Periksa ----
  periksa: { width: '100%', backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 8 },
  periksaJudul: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.6 },
  periksaBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.sm, borderWidth: 1, padding: 8 },
  periksaBannerGalat: { backgroundColor: colors.dangerBg, borderColor: colors.danger },
  periksaBannerOk: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  periksaBannerTeks: { flex: 1, fontSize: 12, fontWeight: '700', color: colors.text },
  periksaGalat: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8 },
  pilBaris: { backgroundColor: colors.dangerBg, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  pilBarisTeks: { fontSize: 10, fontWeight: '900', color: colors.danger },
  periksaGalatTeks: { flex: 1, fontSize: 11.5, color: colors.text, lineHeight: 16 },
  periksaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  periksaChip: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.primaryLight, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  periksaChipTeks: { fontSize: 10.5, fontWeight: '700', color: colors.primary },
  periksaTombol: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 9, marginTop: 10 },
  periksaTombolTeks: { color: colors.white, fontWeight: '800', fontSize: 12 },

  // ---- Selesai ----
  selesai: { width: '100%', alignItems: 'center', gap: 8, paddingVertical: 8 },
  selesaiBulat: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  selesaiChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 6 },
  selesaiChipTeks: { fontSize: 12, fontWeight: '700', color: colors.text },
});
