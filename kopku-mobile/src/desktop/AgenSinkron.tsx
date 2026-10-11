import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { bacaPasangan } from '@/sync/SyncIdentitas';
import { useSyncStore } from '@/sync/SyncStore';
import {
  cekPermintaanDesktop,
  jalankanPermintaanDesktop,
  pastikanModeManual,
  tolakPermintaanDesktop,
  type PermintaanDesktop,
} from '@/sync/SyncKlien';

/**
 * AGEN SINKRON — versi HP (RC-S133.5: SINKRON MANUAL).
 *
 * Tidak ada lagi sinkron berkala: data dipindah hanya bila pengguna
 * menekan "Kirim HP → PC" / "Ambil PC → HP". Agen ini hanya:
 *  1. melepas mode baca-saja peninggalan RC-S133.4 (sekali, saat masuk);
 *  2. selama HP terpasang & aplikasi terbuka, memeriksa (tiap 20 detik dan
 *     saat aplikasi kembali ke depan) apakah KOPKU Desktop mengirim
 *     PERMINTAAN — "Kirim data PC → HP" atau "Minta data dari HP" — lalu
 *     menanyakan persetujuan pemilik HP sebelum menjalankannya.
 * Desktop tidak terjangkau bukan galat: diperiksa lagi pada putaran berikutnya.
 */
let sedangBertanya = false;

function tanyakan(k: PermintaanDesktop, desktop: string): void {
  sedangBertanya = true;
  const keDesktop = k === 'PAKAI_HP';
  notify(
    keDesktop ? 'Komputer meminta data HP' : 'Komputer mengirim data ke HP',
    keDesktop
      ? `${desktop} meminta data dari HP ini (Kirim data HP → PC). Data di komputer akan diganti dengan data HP ini; data HP tidak berubah.`
      : `${desktop} ingin mengirim datanya ke HP ini (PC → HP). Data di HP ini akan DIGANTI dengan data komputer. Backup pengaman HP dibuat otomatis lebih dulu.`,
    [
      {
        text: 'Tolak',
        style: 'cancel',
        onPress: () => {
          sedangBertanya = false;
          void tolakPermintaanDesktop().catch(() => undefined);
        },
      },
      {
        text: keDesktop ? 'Kirim data' : 'Terima & ganti data HP',
        style: keDesktop ? 'default' : 'destructive',
        onPress: () => {
          sedangBertanya = false;
          void jalankanPermintaanDesktop(k).catch((e) =>
            notify('Pengiriman gagal', e instanceof Error ? e.message : String(e), undefined, 'error')
          );
        },
      },
    ]
  );
}

export default function AgenSinkron(): null {
  const userId = useAppStore((s) => s.currentUser?.id ?? null);
  useEffect(() => {
    if (!userId) return;
    let hidup = true;
    let modeDisiapkan = false;
    const jalan = async () => {
      if (!hidup || sedangBertanya) return;
      const p = await bacaPasangan().catch(() => null);
      if (!p || p.diputusDesktop) return;
      if (!modeDisiapkan) {
        modeDisiapkan = true;
        await pastikanModeManual().catch(() => undefined);
      }
      const st = useSyncStore.getState().status;
      if (st === 'MENYINKRONKAN' || st === 'MENUNGGU_KONFIRMASI') return;
      const r = await cekPermintaanDesktop().catch(() => null);
      if (hidup && r?.permintaan && !sedangBertanya) tanyakan(r.permintaan, r.desktopNama ?? p.peerNama);
    };
    void jalan();
    const timer = setInterval(jalan, 20_000);
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void jalan();
    });
    return () => {
      hidup = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [userId]);
  return null;
}
