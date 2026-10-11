# UJI TAMPILAN & ALUR (opsional, butuh Python + playwright + Chromium):
#   node test/lan/demo-server.js 47999   (terminal 1)
#   mkdir shots && python test/lan/ui-browser.py   (terminal 2)
# Menu per peran (Permission Matrix), alur transaksi lewat klik (ajukan → simulasi → cairkan,
# bayar angsuran, tarik sukarela, kas keluar, pemindahan saldo), konflik bayar ganda dari 2 perangkat,
# Pengawas tanpa tombol ubah, Ctrl+K, tampilan HP. Mencetak ringkasan JSON; exit 1 bila ada yang gagal.
import asyncio, json, os, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('KOPKU_URL', 'http://127.0.0.1:47999')
OUT = os.environ.get('KOPKU_SHOTS', 'shots')
PW = {'admin': 'Admin#Kopku2026', 'bendahara': 'Bendahara#Kopku2026', 'operator': 'Operator#Kopku2026', 'pengawas': 'Pengawas#Kopku2026'}
hasil = {}
errs = []


def cek(nama, ok, info=''):
    hasil[nama] = bool(ok)
    print(('OK   ' if ok else 'GAGAL'), nama, info)


async def masuk(ctx, user):
    pg = await ctx.new_page()
    pg.on('console', lambda m: errs.append((user, m.type, m.text)) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.on('pageerror', lambda e: errs.append((user, 'pageerror', str(e))))
    await pg.goto(BASE + '/')
    await pg.wait_for_selector('input[name=username]')
    await pg.fill('input[name=username]', user)
    await pg.fill('input[name=password]', PW[user])
    await pg.click('button[type=submit]')
    await pg.wait_for_selector('.kepala-halaman h1')
    return pg


async def menu(pg):
    return await pg.eval_on_selector_all('.nav-sub a, .nav > a.nav-item', 'els => els.map(e => e.textContent.trim())')


async def toast(pg):
    await pg.wait_for_selector('#toast.tampil', timeout=8000)
    return await pg.inner_text('#toast')


async def pilih_anggota(pg, teks):
    await pg.fill('.pilih-anggota input[type=search]', teks)
    await pg.wait_for_selector(f'.saran-item:has-text("{teks}")')
    await pg.click(f'.saran-item:has-text("{teks}") >> nth=0')
    await pg.wait_for_selector(f'.terpilih:has-text("{teks}")')


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(**({'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}))
        ca = await b.new_context(viewport={'width': 1440, 'height': 900})
        a = await masuk(ca, 'admin')
        await a.wait_for_selector('.statistik')
        await a.screenshot(path=f'{OUT}/40-dashboard.png', full_page=True)
        m_admin = await menu(a)
        cek('admin melihat semua grup menu', all(x in m_admin for x in ['Anggota', 'Tarik Simpanan Sukarela', 'Ajukan Pinjaman', 'Kas Keluar', 'Pemindahan Saldo', 'Arus Kas', 'Buku Besar', 'Pengguna & Izin']), len(m_admin))

        # ---- Ctrl+K
        await a.keyboard.press('Control+k')
        await a.wait_for_selector('.palet input')
        await a.keyboard.type('buku besar')
        await a.wait_for_timeout(150)
        await a.screenshot(path=f'{OUT}/41-ctrl-k.png')
        await a.keyboard.press('Enter')
        await a.wait_for_selector('text=Buku Besar')
        cek('Ctrl+K membuka menu', '#/laporan/buku-besar' in a.url, a.url)

        # ---- ajukan pinjaman + simulasi
        await a.goto(BASE + '/#/pinjaman/baru')
        await pilih_anggota(a, 'Uji 2')
        await a.fill('.input-rp input >> nth=0', '3000000')
        await a.fill('input[type=number] >> nth=0', '6')
        await a.select_option('select >> nth=1', 'EFEKTIF')
        await a.wait_for_selector('.simulasi table')
        baris_sim = await a.locator('.simulasi tbody tr').count()
        cek('simulasi angsuran tampil (6 baris)', baris_sim == 6, baris_sim)
        await a.screenshot(path=f'{OUT}/42-ajukan-simulasi.png', full_page=True)
        await a.click('button:has-text("Simpan pengajuan")')
        t = await toast(a)
        await a.wait_for_selector('button:has-text("Cairkan")')
        cek('pengajuan tersimpan → detail DIAJUKAN', 'tersimpan' in t and await a.locator('.profil .lencana:has-text("DIAJUKAN")').count() == 1, t)
        await a.screenshot(path=f'{OUT}/43-pengajuan.png', full_page=True)
        await a.click('button:has-text("Cairkan")')
        await a.wait_for_selector('.dialog')
        await a.screenshot(path=f'{OUT}/44-dialog-cairkan.png')
        await a.click('.dialog button:has-text("Cairkan pinjaman")')
        t = await toast(a)
        await a.wait_for_selector('.profil .lencana:has-text("AKTIF")')
        cek('pencairan lewat klik → AKTIF', 'dicairkan' in t, t)
        url_baru = a.url

        # ---- tarik simpanan sukarela
        await a.goto(BASE + '/#/simpanan/tarik')
        await pilih_anggota(a, 'Uji 3')
        await a.fill('.input-rp input', '750000')
        await a.screenshot(path=f'{OUT}/45-tarik.png')
        await a.click('button:has-text("Simpan penarikan")')
        t = await toast(a)
        cek('tarik sukarela', 'ST-TARIK' in t, t)

        # ---- kas keluar (beban) + transfer
        await a.goto(BASE + '/#/kas/keluar')
        await a.wait_for_selector('select')
        await a.select_option('select >> nth=0', index=1)
        await a.fill('.input-rp input', '85000')
        await a.click('button:has-text("Simpan pengeluaran")')
        t = await toast(a)
        cek('kas keluar', 'Pengeluaran tercatat' in t, t)
        await a.wait_for_selector('text=Riwayat Kas & Bank')
        await a.screenshot(path=f'{OUT}/46-riwayat-kas.png', full_page=True)
        await a.goto(BASE + '/#/kas/transfer')
        await a.wait_for_selector('button:has-text("Simpan pemindahan")')
        await a.select_option('select >> nth=1', index=0)
        await a.fill('.input-rp input', '1000')
        await a.click('button:has-text("Simpan pemindahan")')
        await a.wait_for_selector('.pesan.galat:not([hidden])')
        g = await a.inner_text('.pesan.galat')
        cek('transfer ke rekening yang sama ditolak server', 'tidak boleh sama' in g, g)

        # ---- laporan
        for path, name in [('/#/laporan/posisi', '47-posisi'), ('/#/laporan/arus-kas', '48-arus-kas'), ('/#/laporan/neraca-saldo', '49-neraca-saldo'), ('/#/laporan/kolektibilitas', '50-kolektibilitas'), ('/#/history', '51-history'), ('/#/pengguna?tab=izin', '52-matriks'), ('/#/simpanan/saldo', '53-saldo-simpanan'), ('/#/anggota', '54-anggota')]:
            await a.goto(BASE + path)
            await a.wait_for_timeout(800)
            await a.screenshot(path=f'{OUT}/{name}.png', full_page=True)
        await a.goto(BASE + '/#/laporan/neraca-saldo')
        await a.wait_for_selector('text=Seimbang')
        await a.click('tbody tr.klik >> nth=0')
        await a.wait_for_selector('text=Jumlah mutasi')
        cek('neraca saldo → buku besar', '#/laporan/buku-besar' in a.url)
        await a.goto(BASE + '/#/history')
        await a.click('tbody tr.klik >> nth=0')
        await a.wait_for_selector('text=Jurnal')
        cek('history → detail jurnal', await a.locator('tfoot').count() == 1)

        # ---- dua perangkat: admin (laptop) & bendahara (HP) bayar angsuran yang sama
        ch = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        hp = await masuk(ch, 'bendahara')
        await hp.wait_for_selector('.statistik')
        await hp.screenshot(path=f'{OUT}/55-hp-dashboard.png', full_page=True)
        lebar = await hp.evaluate('document.documentElement.scrollWidth')
        cek('HP: tidak ada geser horizontal', lebar <= 392, lebar)
        await a.goto(url_baru)
        await a.wait_for_selector('button:has-text("Bayar")')
        await hp.goto(url_baru)
        await hp.wait_for_selector('button:has-text("Bayar")')
        await a.click('button:has-text("Bayar") >> nth=0')
        await a.wait_for_selector('.dialog')
        await a.click('button:has-text("Simpan pembayaran")')
        t = await toast(a)
        cek('admin bayar angsuran', 'Pembayaran tercatat' in t, t)
        await hp.click('button:has-text("Bayar") >> nth=0')
        await hp.wait_for_selector('.dialog')
        await hp.click('button:has-text("Simpan pembayaran")')
        await hp.wait_for_selector('.dialog .pesan.galat:not([hidden])')
        k = await hp.inner_text('.dialog .pesan.galat')
        cek('HP dengan data lama → konflik (tidak bayar ganda)', 'berubah' in k, k)
        await hp.screenshot(path=f'{OUT}/56-hp-konflik.png')
        await hp.click('.dialog button:has-text("Batal")')
        await hp.click('.menu-btn')
        await hp.wait_for_timeout(300)
        await hp.screenshot(path=f'{OUT}/57-hp-menu.png')
        m_bend = await menu(hp)
        cek('bendahara: tanpa Pengguna & Izin / Daftar Akun', 'Pengguna & Izin' not in m_bend and 'Daftar Akun' not in m_bend and 'Pemindahan Saldo' in m_bend)

        # ---- operator & pengawas
        co = await b.new_context(viewport={'width': 1280, 'height': 860})
        op = await masuk(co, 'operator')
        m_op = await menu(op)
        cek('operator (Petugas): tanpa Pemindahan Saldo & pengaturan', 'Pemindahan Saldo' not in m_op and 'WhatsApp Reminder' not in m_op and 'Kas Keluar' in m_op)
        await op.goto(url_baru)
        await op.wait_for_selector('.profil')
        cek('operator tidak melihat tombol Cairkan/Batalkan', await op.locator('button:has-text("Cairkan")').count() == 0)
        cg = await b.new_context(viewport={'width': 1280, 'height': 860})
        pg = await masuk(cg, 'pengawas')
        m_pg = await menu(pg)
        cek('pengawas: hanya menu baca', not any(x in m_pg for x in ['Setor Simpanan', 'Ajukan Pinjaman', 'Kas Masuk', 'Kas Keluar', 'Tarik Simpanan Sukarela']) and 'Buku Besar' in m_pg, m_pg)
        await pg.goto(url_baru)
        await pg.wait_for_selector('.profil')
        cek('pengawas tanpa tombol Bayar/Pelunasan', await pg.locator('button:has-text("Bayar")').count() == 0 and await pg.locator('button:has-text("Pelunasan")').count() == 0)
        await pg.goto(BASE + '/#/kas/masuk')
        await pg.wait_for_selector('text=tidak memiliki izin')
        cek('pengawas membuka URL transaksi langsung → layar tanpa izin', True)
        await pg.screenshot(path=f'{OUT}/58-pengawas-tanpa-izin.png')

        # ---- keluar
        await a.click('.akun-btn')
        await a.click('.menu-akun-isi button:has-text("Keluar")')
        await a.wait_for_selector('input[name=username]')
        cek('keluar', True)
        cek('tanpa galat JavaScript', not errs, errs[:5])
        await b.close()
    gagal = [k for k, v in hasil.items() if not v]
    print(json.dumps({'lulus': len(hasil) - len(gagal), 'total': len(hasil), 'gagal': gagal}, ensure_ascii=False))
    sys.exit(1 if gagal else 0)


asyncio.run(main())
