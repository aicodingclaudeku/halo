import React from 'react';

/**
 * Tata letak navigasi — versi HP (Android): TIDAK menambah apa pun.
 * `desktopNav.web.tsx` (dipilih Metro untuk build desktop) mengganti tab
 * bawah dengan sidebar kiri dan memusatkan konten.
 */
export const propsTabDesktop: Record<string, unknown> = {};

export function BingkaiKonten({ children }: { children: React.ReactElement }): React.ReactElement {
  return children;
}

export const opsiTabDesktop: Record<string, unknown> = {};
