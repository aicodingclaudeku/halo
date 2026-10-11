import { useEffect } from 'react';
import { bacaPasangan } from '@/sync/SyncIdentitas';
import { mulaiServerSinkron, segarkanStatusDesktop } from '@/sync/SyncServer';

/**
 * AGEN SINKRON — versi desktop. Desktop adalah SERVER: bila sudah
 * dipasangkan, server LAN dinyalakan otomatis begitu aplikasi siap
 * (setelah lisensi sah), sehingga HP dapat menyinkronkan kapan saja
 * selama aplikasi desktop terbuka.
 */
export default function AgenSinkron(): null {
  useEffect(() => {
    void (async () => {
      const p = await bacaPasangan().catch(() => null);
      if (p) await mulaiServerSinkron().catch(() => undefined);
      await segarkanStatusDesktop().catch(() => undefined);
    })();
  }, []);
  return null;
}
