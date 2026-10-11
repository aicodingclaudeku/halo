import React, {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  SectionList,
  TextInput,
  View,
  type KeyboardEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  hitungGeserGulir,
  hitungTujuanGulir,
  JEDA_LEPAS_PADDING_MS,
  JEDA_UKUR_ULANG_MS,
} from '@/components/hitungAreaKeyboard';
import { sematkanWadahGulir } from '@/components/telusuriWadahGulir';

/**
 * SATU ATURAN ANTI-KEYBOARD-MENUTUPI-INPUT.
 *
 * ============================================================
 * KOREKSI PENTING ATAS DIAGNOSIS RC-S110
 * ============================================================
 * RC-S110 menyimpulkan bahwa "layar biasa umumnya tetap aman karena
 * Expo menyetel android:windowSoftInputMode='adjustResize'". KESIMPULAN
 * ITU SALAH untuk aplikasi ini, dan pengguna benar saat melaporkan
 * bahwa papan ketik masih menutupi input di banyak layar.
 *
 * Aplikasi ini berjalan EDGE-TO-EDGE. Expo SDK 54 menyalakannya sebagai
 * bawaan — lihat `@expo/prebuild-config` ->
 * plugins/unversioned/edge-to-edge/withEdgeToEdge.js:
 *
 *     const edgeToEdgeEnabled = raw_edgeToEdgeEnabled !== false;
 *
 * `app.json` di proyek ini tidak menyetel `android.edgeToEdgeEnabled`
 * sama sekali, jadi nilainya `true`. Sejak Android 16 (targetSdk 36)
 * bahkan tidak bisa dimatikan lagi.
 *
 * Dalam mode edge-to-edge, jendela aplikasi digambar DI BELAKANG bilah
 * sistem dan TIDAK LAGI MENYUSUT saat papan ketik muncul —
 * `adjustResize` kehilangan efeknya. Itulah sebabnya masalahnya
 * tersebar di banyak layar, bukan hanya di dalam Modal seperti dugaan
 * RC-S110.
 *
 * <Modal> TIDAK dikecualikan. `ReactModalHostView.kt` (RN 0.81) memang
 * memasang `SOFT_INPUT_ADJUST_RESIZE` pada jendela dialognya, tetapi
 * begitu flag edge-to-edge menyala, getter `navigationBarTranslucent`
 * selalu `true` dan dialognya ikut `enableEdgeToEdge()` —
 * `setDecorFitsSystemWindows(false)` — sehingga jendela dialog pun tidak
 * menyusut.
 *
 * ============================================================
 * KENAPA TIDAK MEMAKAI KeyboardAvoidingView BAWAAN
 * ============================================================
 * `KeyboardAvoidingView` menghitung tumpang-tindih dengan rumus
 * (lihat sumbernya di node_modules/react-native/Libraries/Components/
 * Keyboard/KeyboardAvoidingView.js):
 *
 *     frame.y + frame.height - keyboardY
 *
 * `frame` di situ berasal dari `onLayout`, yang RELATIF TERHADAP
 * INDUKNYA — sedangkan `keyboardY` dalam koordinat LAYAR. Begitu
 * komponennya berada di bawah header navigasi, kedua angka itu tidak
 * lagi sebanding dan hasilnya kurang sebesar tinggi header. Itu sebabnya
 * `keyboardVerticalOffset` harus diisi manual per layar dengan tinggi
 * header — angka yang berbeda-beda dan mudah salah.
 *
 * `scrollResponderScrollNativeHandleToKeyboard` milik ScrollView juga
 * tidak dipakai, dengan alasan yang sama: sumbernya sendiri menulis
 * "the calculations performed here assume the scroll view takes up the
 * entire screen".
 *
 * ============================================================
 * YANG DILAKUKAN KOMPONEN INI
 * ============================================================
 * 1. PADDING. Mengukur posisi dirinya sendiri dalam KOORDINAT JENDELA
 *    (`measureInWindow`), lalu membandingkan tepi bawahnya dengan tepi
 *    atas papan ketik (`endCoordinates.screenY`). Selisihnya dipasang
 *    sebagai `paddingBottom`, sehingga ScrollView di dalamnya MENYUSUT
 *    sampai tepi atas papan ketik. Setelah itu semua yang terlihat di
 *    ScrollView memang berada di atas papan ketik, dan sisa isinya
 *    — sampai input terakhir dan tombol Simpan — dapat digulir.
 *
 *    Dua sifat yang didapat gratis dari cara ini:
 *      - TIDAK PERLU TAHU TINGGI HEADER. Keduanya diukur pada sumbu yang
 *        sama, jadi posisi komponen di dalam pohon tidak relevan.
 *      - AMAN KALAU JENDELA TERNYATA MENYUSUT. Tepi bawah komponen sudah
 *        di atas papan ketik, selisihnya nol, dan tidak ada yang
 *        ditambahkan — tanpa perlu mendeteksi mode apa pun.
 *
 * 2. GULIR KE INPUT YANG DIFOKUSKAN (RC-S120). Menyusutkan ScrollView
 *    saja belum cukup: input yang tadi terlihat di bagian bawah kini
 *    berada di bawah tepi ScrollView yang baru, tertutup papan ketik
 *    sampai pengguna menggulir sendiri. Setelah padding terpasang,
 *    komponen ini mengukur input yang sedang fokus dan menggulir
 *    ScrollView pemiliknya secukupnya — dihitung dari posisi nyata,
 *    jadi tidak menggulir dua kali kalau Android sendiri sudah
 *    menggulirnya.
 *
 *    ScrollView/FlatList ditemukan dari `children` yang diterima
 *    komponen ini, lalu diberi `ref` yang DIGABUNG dengan `ref` milik
 *    pemanggil. Tidak satu pun layar perlu diubah untuk ini.
 *
 * 3. TIDAK MELONCAT. Padding tidak langsung dilepas saat papan ketik
 *    tertutup (lihat `JEDA_LEPAS_PADDING_MS`), dan pengukuran diulang
 *    sekali setelah tata letak selesai (`JEDA_UKUR_ULANG_MS`). Kalau
 *    papan ketik SUDAH terbuka saat komponen ini dipasang — mis. dialog
 *    dibuka sambil mengetik — tidak ada event baru dari Android; itu
 *    ditangani dari `onLayout` memakai `Keyboard.metrics()`.
 *
 * 4. SATU PEMILIK. Selama sebuah `dialog` terpasang (artinya ada <Modal>
 *    berinput yang terbuka), pembungkus `layar` di belakangnya tidak ikut
 *    menambah padding. Tanpa ini, layar di balik latar redup ikut
 *    menyusut dan meloncat setiap kali papan ketik dialog muncul.
 */
export type VarianAreaKeyboard = 'dialog' | 'layar';

export interface AreaAmanKeyboardProps {
  /**
   * Konteks pemakaian. `dialog` = di dalam <Modal>, `layar` = di luar.
   *
   * Sejak RC-S120 nilainya juga menentukan perilaku, bukan hanya
   * dokumentasi: selama ada `dialog` terpasang, `layar` tidak menambah
   * padding (lihat butir 4 di atas). Test struktural memastikan setiap
   * pemakaian memilih nilai yang cocok dengan letaknya.
   */
  varian: VarianAreaKeyboard;
  style?: StyleProp<ViewStyle>;
  /** Jarak lega tambahan di atas papan ketik, mis. supaya tombol tidak menempel. */
  offsetVertikal?: number;
  children: React.ReactNode;
}

/** Jumlah pembungkus `dialog` yang sedang terpasang, di seluruh aplikasi. */
let jumlahDialogTerpasang = 0;

const KonteksAreaKeyboard = createContext<{ sisipBawah: number }>({ sisipBawah: 0 });

/** Jenis elemen yang dianggap wadah gulir vertikal. */
const JENIS_WADAH_GULIR = new Set<unknown>([ScrollView, FlatList, SectionList]);

type Instans = { [k: string]: any } | null;

function teruskanRef(ref: unknown, instans: Instans): void {
  if (typeof ref === 'function') ref(instans);
  else if (ref && typeof ref === 'object' && 'current' in ref) (ref as { current: Instans }).current = instans;
}

/** Wadah gulir vertikal yang dicari di `children`. */
const adalahWadah = (jenis: unknown) => JENIS_WADAH_GULIR.has(jenis);

/**
 * Tidak ditelusuri: <Modal> dan AreaAmanKeyboard lain. Keduanya punya
 * pemiliknya sendiri, dan isi <Modal> ada di jendela dialog — tidak
 * boleh digulir dari layar di belakangnya.
 */
const lewati = (jenis: unknown) => jenis === Modal || jenis === AreaAmanKeyboard;

export default function AreaAmanKeyboard({
  varian,
  style,
  offsetVertikal = 0,
  children,
}: AreaAmanKeyboardProps) {
  const acuan = useRef<View | null>(null);
  const [sisipBawah, setSisipBawah] = useState(0);
  /** Tepi atas papan ketik yang terakhir diketahui; `null` = tertutup. */
  const atasKeyboardRef = useRef<number | null>(null);

  const timerLepas = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerUlang = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bingkai = useRef<number | null>(null);

  // ---- wadah gulir yang ditemukan di `children` -----------------------
  const wadahGulir = useRef<Instans[]>([]);
  const refAsli = useRef<unknown[]>([]);
  const pemasang = useRef<((i: Instans) => void)[]>([]);

  /**
   * Callback ref STABIL per urutan wadah. Callback baru di setiap render
   * akan membuat React melepas lalu memasang ulang ref pada setiap
   * render; yang stabil hanya dipanggil saat wadahnya benar-benar
   * dipasang atau dilepas. Ref milik pemanggil selalu ikut diteruskan.
   */
  const refUntuk = (urutan: number, asli: unknown) => {
    refAsli.current[urutan] = asli;
    if (!pemasang.current[urutan]) {
      pemasang.current[urutan] = (instans: Instans) => {
        wadahGulir.current[urutan] = instans;
        teruskanRef(refAsli.current[urutan], instans);
      };
    }
    return pemasang.current[urutan];
  };

  const bersihkanTimer = useCallback(() => {
    if (timerLepas.current) clearTimeout(timerLepas.current);
    if (timerUlang.current) clearTimeout(timerUlang.current);
    if (bingkai.current != null) cancelAnimationFrame(bingkai.current);
    timerLepas.current = null;
    timerUlang.current = null;
    bingkai.current = null;
  }, []);

  /** Gulir ScrollView pemilik input yang sedang fokus, bila tertutup. */
  const gulirKeInputFokus = useCallback(() => {
    const atasKeyboard = atasKeyboardRef.current;
    const input = (TextInput as any).State?.currentlyFocusedInput?.() as Instans;
    if (atasKeyboard == null || !input || typeof input.measureInWindow !== 'function') return;

    input.measureInWindow((_x: number, iy: number, _l: number, it: number) => {
      const kotakInput = { y: iy, tinggi: it };
      for (const wadah of wadahGulir.current) {
        if (!wadah) continue;
        // FlatList/SectionList -> ScrollView di dalamnya; ScrollView -> dirinya.
        const sv: Instans = typeof wadah.getScrollResponder === 'function' ? wadah.getScrollResponder() : wadah;
        const isi: Instans = sv?.getInnerViewRef?.();
        const asli: Instans = sv?.getNativeScrollRef?.();
        if (!sv || !isi || !asli || typeof sv.scrollTo !== 'function') continue;
        // `measureLayout` gagal kalau input bukan keturunan wadah ini —
        // itulah cara memilih wadah yang benar di antara beberapa.
        input.measureLayout(
          isi,
          (_lx: number, yDalamIsi: number) => {
            asli.measureInWindow((_sx: number, sy: number, _sl: number, st: number) => {
              const kotakWadah = { y: sy, tinggi: st };
              const geser = hitungGeserGulir({ input: kotakInput, wadah: kotakWadah, atasKeyboard });
              const tujuan = hitungTujuanGulir({ yDalamIsi, input: kotakInput, wadah: kotakWadah, geser });
              if (tujuan != null) sv.scrollTo({ y: tujuan, animated: true });
            });
          },
          () => {},
        );
      }
    });
  }, []);

  const terapkanSisip = useCallback(
    (atasKeyboard: number, sesudah?: () => void) => {
      const simpul = acuan.current;
      if (!simpul) return;
      simpul.measureInWindow((_x, y, _lebar, tinggi) => {
        // Nilai tidak masuk akal (0 atau NaN) muncul kalau pengukuran
        // terjadi saat komponen belum ter-layout. Diabaikan, bukan
        // dipasang sebagai padding — padding raksasa jauh lebih buruk
        // daripada tidak ada padding.
        if (!Number.isFinite(y) || !Number.isFinite(tinggi) || tinggi <= 0) return;
        const tumpang = y + tinggi - atasKeyboard;
        // Dibulatkan ke dp utuh: pengukuran ulang (onLayout, jeda ukur
        // ulang) lalu menghasilkan nilai yang PERSIS sama, dan React
        // berhenti me-render. Selisih pecahan float tidak boleh menjadi
        // alasan render ulang tanpa akhir.
        setSisipBawah(tumpang > 0 ? Math.round(tumpang + offsetVertikal) : 0);
        sesudah?.();
      });
    },
    [offsetVertikal],
  );

  /**
   * Pasang padding, gulir ke input, lalu ukur ulang SEKALI setelah tata
   * letak selesai. Pengukuran ulang idempoten — bingkai pembungkus
   * ber-flex tidak berubah oleh padding-nya sendiri — jadi ia hanya
   * membetulkan pengukuran pertama yang terbaca sebelum layout final.
   */
  const ukurDanGulir = useCallback(
    (atasKeyboard: number) => {
      atasKeyboardRef.current = atasKeyboard;
      bersihkanTimer();
      terapkanSisip(atasKeyboard, () => {
        bingkai.current = requestAnimationFrame(gulirKeInputFokus);
        timerUlang.current = setTimeout(() => {
          timerUlang.current = null;
          if (atasKeyboardRef.current == null) return;
          terapkanSisip(atasKeyboardRef.current, gulirKeInputFokus);
        }, JEDA_UKUR_ULANG_MS);
      });
    },
    [terapkanSisip, gulirKeInputFokus, bersihkanTimer],
  );

  /** Layar di belakang dialog yang terbuka tidak ikut bereaksi. */
  const bolehBereaksi = useCallback(() => varian === 'dialog' || jumlahDialogTerpasang === 0, [varian]);

  const hitungSisip = useCallback(
    (e: KeyboardEvent) => {
      if (!bolehBereaksi()) return;
      const atasKeyboard = e.endCoordinates.screenY;
      if (!Number.isFinite(atasKeyboard)) return;
      ukurDanGulir(atasKeyboard);
    },
    [bolehBereaksi, ukurDanGulir],
  );

  useEffect(() => {
    if (varian !== 'dialog') return;
    jumlahDialogTerpasang += 1;
    return () => {
      jumlahDialogTerpasang -= 1;
    };
  }, [varian]);

  useEffect(() => {
    // iOS memberi kabar SEBELUM papan ketik bergerak ('will'), Android
    // hanya SESUDAH ('did'). Memakai 'will' di Android tidak pernah
    // terpicu, jadi namanya dipilih per platform.
    //
    // 'keyboardDidChangeFrame' hanya dikirim iOS. Di Android API 30+
    // (`ReactRootView.checkForKeyboardEvents`) event hanya dikirim saat
    // papan ketik berganti TAMPAK/TERSEMBUNYI — perubahan tingginya
    // saja tidak dilaporkan.
    const namaMuncul = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const namaHilang = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const muncul = Keyboard.addListener(namaMuncul, hitungSisip);
    const berubah = Keyboard.addListener('keyboardDidChangeFrame', hitungSisip);
    const hilang = Keyboard.addListener(namaHilang, () => {
      atasKeyboardRef.current = null;
      bersihkanTimer();
      timerLepas.current = setTimeout(() => {
        timerLepas.current = null;
        setSisipBawah(0);
      }, JEDA_LEPAS_PADDING_MS);
    });
    return () => {
      muncul.remove();
      berubah.remove();
      hilang.remove();
      bersihkanTimer();
    };
  }, [hitungSisip, bersihkanTimer]);

  /**
   * Papan ketik yang SUDAH terbuka saat komponen ini dipasang tidak
   * memicu event baru — Android hanya melapor saat tampak/tersembunyi
   * berganti. Tanpa ini, dialog yang dibuka sambil mengetik tidak pernah
   * mendapat padding sama sekali.
   */
  const saatLayout = useCallback(() => {
    if (!Keyboard.isVisible() || !bolehBereaksi()) return;
    const m = Keyboard.metrics();
    if (m && Number.isFinite(m.screenY)) ukurDanGulir(m.screenY);
  }, [bolehBereaksi, ukurDanGulir]);

  // Wadah yang hilang dari JSX (mis. dirender bersyarat) tidak perlu
  // dibersihkan di sini: React memanggil callback ref-nya dengan `null`
  // saat dilepas, dan `gulirKeInputFokus` melewati slot yang kosong.
  let urutanWadah = 0;
  const isi = sematkanWadahGulir(children, {
    adalahWadah,
    lewati,
    pasang: (el) => cloneElement(el, { ref: refUntuk(urutanWadah++, el.props?.ref) } as any),
  });

  const nilaiKonteks = useMemo(() => ({ sisipBawah }), [sisipBawah]);

  return (
    <KonteksAreaKeyboard.Provider value={nilaiKonteks}>
      <View
        ref={acuan}
        collapsable={false}
        onLayout={saatLayout}
        style={[style, sisipBawah > 0 ? { paddingBottom: sisipBawah } : null]}
      >
        {isi}
      </View>
    </KonteksAreaKeyboard.Provider>
  );
}

/**
 * Pengganti `<SafeAreaView edges={['bottom']}>` untuk lembar bawah yang
 * berada DI DALAM AreaAmanKeyboard.
 *
 * Saat papan ketik terbuka, padding dari AreaAmanKeyboard sudah mencakup
 * area bilah navigasi — papan ketik duduk di atasnya, jadi area itu
 * memang tertutup. Inset bawah SafeAreaView lalu menambah tinggi bilah
 * navigasi SEKALI LAGI: celah kosong di antara tombol dan papan ketik.
 * Komponen ini melepas inset bawahnya selama papan ketik terbuka, dan
 * memasangnya lagi saat tertutup.
 */
export function SafeAreaBawahAman({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const { sisipBawah } = useContext(KonteksAreaKeyboard);
  return (
    <SafeAreaView style={style} edges={sisipBawah > 0 ? [] : ['bottom']}>
      {children}
    </SafeAreaView>
  );
}

/**
 * Prop ScrollView yang harus dipakai setiap layar/dialog berisi input.
 *
 * Disediakan sebagai objek, bukan sekadar disebut di dokumentasi,
 * supaya ketiganya tidak lagi bergantung pada ingatan penulis layar:
 *   - `keyboardShouldPersistTaps: 'handled'` — menekan tombol Simpan
 *     saat papan ketik terbuka langsung menekannya, bukan cuma
 *     menutup papan ketik lalu harus ditekan dua kali;
 *   - `keyboardDismissMode: 'on-drag'` — menggulir menutup papan
 *     ketik, jalan keluar tercepat saat input tertutup;
 *   - `automaticallyAdjustKeyboardInsets` — iOS menggeser isi sendiri.
 */
export const PROP_SCROLL_FORM = {
  keyboardShouldPersistTaps: 'handled',
  keyboardDismissMode: 'on-drag',
  automaticallyAdjustKeyboardInsets: true,
} as const;

/**
 * Ruang bawah minimum pada `contentContainerStyle` layar berinput.
 * Tanpa ini, input terakhir menempel pada tepi bawah dan tertutup
 * tombol aksi melayang begitu papan ketik muncul.
 */
export const RUANG_BAWAH_FORM = 120;
