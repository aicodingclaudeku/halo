import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

/**
 * RC-S120 — PENELUSURAN WADAH GULIR DI `children` (MODUL MURNI).
 *
 * Dipisah dari `AreaAmanKeyboard.tsx` karena berkas itu mengimpor
 * `react-native`, yang tidak dapat dimuat ts-jest. Modul ini hanya
 * memakai `react`, jadi perilakunya diuji dengan elemen sungguhan —
 * bukan dibaca sebagai teks.
 *
 * Tugasnya: menyalin pohon `children`, lalu menyerahkan setiap wadah
 * gulir vertikal yang terlihat langsung di JSX ke `pasang` (yang
 * menyematkan `ref`). Aturan yang dijaga:
 *
 *   - Hanya JALUR menuju wadah yang disalin. Cabang lain dikembalikan
 *     sebagai objek yang SAMA, jadi tidak ada kerja ulang maupun
 *     identitas elemen yang berubah tanpa perlu.
 *   - Anak tunggal tetap anak tunggal. `React.Children.map` akan
 *     mengubahnya menjadi larik dan mematahkan komponen yang memakai
 *     `React.Children.only`.
 *   - Isi wadah itu sendiri tidak ditelusuri (yang terluar yang dipakai),
 *     begitu pula ScrollView `horizontal` (baris chip, bukan form) dan
 *     elemen yang `lewati` — <Modal> dan AreaAmanKeyboard lain, yang
 *     punya pemiliknya sendiri.
 *   - Salinan di dalam larik yang belum ber-key diberi key per posisi.
 *     `cloneElement` (React 19.1) tidak membawa tanda "anak statis sudah
 *     divalidasi" milik JSX, sehingga tanpa key React versi dev
 *     memperingatkan "unique key". Key-nya sama di setiap render, jadi
 *     tidak memicu pasang ulang.
 */
export interface OpsiTelusur {
  adalahWadah: (jenis: unknown) => boolean;
  lewati: (jenis: unknown) => boolean;
  pasang: (el: ReactElement<any>) => ReactElement<any>;
}

export function sematkanWadahGulir(node: ReactNode, opsi: OpsiTelusur): ReactNode {
  if (Array.isArray(node)) {
    let berubah = false;
    const hasil = node.map((anak, i) => {
      const baru = sematkanWadahGulir(anak, opsi);
      if (baru === anak) return anak;
      berubah = true;
      return isValidElement(baru) && baru.key == null ? cloneElement(baru, { key: `wadah-gulir-${i}` }) : baru;
    });
    return berubah ? hasil : node;
  }
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<any>;
  if (opsi.adalahWadah(el.type)) return el.props?.horizontal ? el : opsi.pasang(el);
  if (opsi.lewati(el.type)) return el;
  const anak = el.props?.children;
  if (anak == null || typeof anak === 'function') return el;
  const anakBaru = sematkanWadahGulir(anak, opsi);
  return anakBaru === anak ? el : cloneElement(el, { children: anakBaru });
}
