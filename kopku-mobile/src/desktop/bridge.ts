/**
 * Kontrak jembatan `window.kopkuDesktop` yang diekspos `desktop/electron/preload.js`
 * lewat contextBridge. Di HP (Android) objek ini tidak ada → `bridge()` = null.
 */
export interface StatBerkas {
  exists: boolean;
  isDirectory: boolean;
  size: number;
  modificationTime: number;
}

export interface StatusFirewall {
  didukung: boolean;
  aturanIzin?: boolean;
  aturanBlokir?: number;
  profil?: { nama: string; kategori: string }[];
  perluPerbaikan?: boolean;
  tidakDiketahui?: boolean;
  pesan?: string;
}

export interface KopkuDesktopBridge {
  info: {
    platform: string;
    platformLabel: string;
    hostname: string;
    version: string;
    documentUri: string;
    cacheUri: string;
    dataDir: string;
  };
  sqlite: {
    open(name: string, directory?: string): Promise<{ id: number; file: string }>;
    exec(id: number, sql: string): Promise<void>;
    run(id: number, sql: string, params: unknown[]): Promise<{ lastInsertRowId: number; changes: number }>;
    get(id: number, sql: string, params: unknown[]): Promise<Record<string, unknown> | null>;
    all(id: number, sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
    close(id: number): Promise<void>;
  };
  fs: {
    uriToPath(uri: string): string;
    pathToUri(path: string): string;
    info(uri: string): Promise<StatBerkas>;
    readString(uri: string, encoding: 'utf8' | 'base64'): Promise<string>;
    writeString(uri: string, data: string, encoding: 'utf8' | 'base64', append?: boolean): Promise<void>;
    remove(uri: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
    copy(from: string, to: string): Promise<void>;
    mkdir(uri: string): Promise<void>;
    readDir(uri: string): Promise<string[]>;
    statSync(uri: string): StatBerkas;
    createSync(uri: string, overwrite: boolean): void;
    removeSync(uri: string): void;
    openSync(uri: string): number;
    readSync(handle: number, offset: number, length: number): Uint8Array;
    writeSync(handle: number, offset: number, data: Uint8Array): number;
    closeSync(handle: number): void;
  };
  secure: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  print: {
    toPdf(html: string, opts: { width?: number; height?: number; margins?: unknown }): Promise<{ uri: string; numberOfPages: number }>;
    printHtml(html: string): Promise<boolean>;
    printFile(uri: string): Promise<boolean>;
  };
  dialog: {
    openFiles(opts: { title?: string; filters?: { name: string; extensions: string[] }[]; multiple?: boolean }): Promise<string[] | null>;
    saveFile(sourceUri: string, defaultName: string): Promise<string | null>;
  };
  shell: {
    openPath(uri: string): Promise<void>;
    showItem(uri: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  http: {
    fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string | null }): Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      bodyB64: string;
    }>;
  };
  auth: {
    canBiometric(): Promise<boolean>;
    promptBiometric(reason: string): Promise<boolean>;
  };
  lan: {
    start(): Promise<{ port: number; addresses: string[] }>;
    info(): Promise<{ port: number; addresses: string[]; running: boolean }>;
    onRequest(handler: (req: { path: string; body: string }) => Promise<{ status: number; body: string }>): void;
    onPing(cb: (info: { ip: string; waktu: string }) => void): () => void;
  };
  firewall: {
    status(): Promise<StatusFirewall>;
    perbaiki(): Promise<{ ok: boolean; dibatalkan?: boolean; dilewati?: boolean; pesan?: string; status?: StatusFirewall }>;
  };
  qr: { toDataUrl(text: string): Promise<string> };
  app: {
    openDataFolder(): Promise<void>;
    onMenu(cb: (perintah: string) => void): (() => void) | void;
    setTitle(t: string): void;
  };
}

export function bridge(): KopkuDesktopBridge | null {
  const g = globalThis as unknown as { kopkuDesktop?: KopkuDesktopBridge };
  return g.kopkuDesktop ?? null;
}
