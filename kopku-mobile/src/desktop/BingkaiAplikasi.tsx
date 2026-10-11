import type React from 'react';

/** Versi HP: tanpa bingkai — anak dirender apa adanya. Lihat BingkaiAplikasi.web.tsx. */
export default function BingkaiAplikasi({ children }: { children: React.ReactNode }): React.ReactNode {
  return children;
}
