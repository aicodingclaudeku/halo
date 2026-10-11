import { create } from 'zustand';

/** State tampilan kerangka KOPKU Desktop (bukan data koperasi). */
interface UiDesktop {
  paletTerbuka: boolean;
  sidebarRingkas: boolean;
  bukaPalet: () => void;
  tutupPalet: () => void;
  alihSidebar: () => void;
}

const KUNCI = 'kopku.desktop.sidebarRingkas';
function bacaAwal(): boolean {
  try {
    return globalThis.localStorage?.getItem(KUNCI) === '1';
  } catch {
    return false;
  }
}

export const useUiDesktop = create<UiDesktop>((set, get) => ({
  paletTerbuka: false,
  sidebarRingkas: bacaAwal(),
  bukaPalet: () => set({ paletTerbuka: true }),
  tutupPalet: () => set({ paletTerbuka: false }),
  alihSidebar: () => {
    const v = !get().sidebarRingkas;
    try {
      globalThis.localStorage?.setItem(KUNCI, v ? '1' : '0');
    } catch {
      /* preferensi tampilan saja */
    }
    set({ sidebarRingkas: v });
  },
}));
