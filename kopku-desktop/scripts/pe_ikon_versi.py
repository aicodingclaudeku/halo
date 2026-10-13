#!/usr/bin/env python3
"""Ganti ikon (RT_ICON/RT_GROUP_ICON) dan VERSIONINFO pada PE64 Windows tanpa Wine/rcedit.

Cara kerja: pohon resource lama dibaca utuh, ikon & versi diganti, pohon baru
diserialisasi ke SECTION BARU di akhir berkas, DataDirectory[RESOURCE] diarahkan
ke section baru. Section .rsrc lama dibiarkan (tidak dirujuk lagi). Checksum PE
dihitung ulang. Hanya untuk berkas TANPA tanda tangan Authenticode.

Pemakaian: pe_ikon_versi.py <exe> <ikon.ico> <versi x.y.z> <json string versi> [integritas.json]

Argumen ke-5 (opsional, 1.0.13): berkas JSON daftar integritas app.asar dari
scripts/rakit-asar-fuse.js. Dipasang sebagai resource INTEGRITY/ELECTRONASAR
(bahasa sama dengan VERSIONINFO) — sama dengan electron-builder addWinAsarIntegrity —
dan dibaca Electron bila fuse EnableEmbeddedAsarIntegrityValidation ON.
"""
import json, struct, sys

RT_ICON, RT_GROUP_ICON, RT_VERSION = 3, 14, 16


def align(x, a):
    return (x + a - 1) // a * a


# ------------------------------------------------------------------ PE
class PE:
    def __init__(self, data):
        self.d = bytearray(data)
        d = self.d
        self.pe = struct.unpack_from('<I', d, 0x3C)[0]
        assert d[self.pe:self.pe + 4] == b'PE\0\0'
        self.nsec = struct.unpack_from('<H', d, self.pe + 6)[0]
        optsz = struct.unpack_from('<H', d, self.pe + 20)[0]
        self.opt = self.pe + 24
        assert struct.unpack_from('<H', d, self.opt)[0] == 0x20B, 'hanya PE32+'
        self.sa, self.fa = struct.unpack_from('<II', d, self.opt + 32)
        self.soh = struct.unpack_from('<I', d, self.opt + 60)[0]
        self.dd = self.opt + 112
        self.st = self.opt + optsz
        sec_dir = struct.unpack_from('<II', d, self.dd + 8 * 4)
        assert sec_dir == (0, 0), 'berkas bertanda tangan: tidak didukung'

    def sections(self):
        out = []
        for i in range(self.nsec):
            o = self.st + 40 * i
            vs, va, rs, rp = struct.unpack_from('<IIII', self.d, o + 8)
            out.append(dict(name=bytes(self.d[o:o + 8]).rstrip(b'\0'), vs=vs, va=va, rs=rs, rp=rp, off=o))
        return out

    def rva_to_off(self, rva):
        for s in self.sections():
            if s['va'] <= rva < s['va'] + max(s['vs'], s['rs']):
                return rva - s['va'] + s['rp']
        raise ValueError(hex(rva))

    def resource(self):
        rva, size = struct.unpack_from('<II', self.d, self.dd + 8 * 2)
        return rva, size

    def tambah_section(self, nama, data, karakteristik):
        secs = self.sections()
        end_tabel = self.st + 40 * (self.nsec + 1)
        assert end_tabel <= self.soh, 'tidak ada ruang header untuk section baru'
        last = max(secs, key=lambda s: s['va'])
        va = align(last['va'] + max(last['vs'], last['rs']), self.sa)
        file_end = max(s['rp'] + s['rs'] for s in secs)
        assert file_end == len(self.d), 'ada data overlay di akhir berkas'
        rp = align(len(self.d), self.fa)
        raw = data + b'\0' * (align(len(data), self.fa) - len(data))
        self.d += b'\0' * (rp - len(self.d)) + raw
        o = self.st + 40 * self.nsec
        hdr = nama.ljust(8, b'\0')[:8] + struct.pack('<IIIIIIHHI', len(data), va, len(raw), rp, 0, 0, 0, 0, karakteristik)
        self.d[o:o + 40] = hdr
        self.nsec += 1
        struct.pack_into('<H', self.d, self.pe + 6, self.nsec)
        struct.pack_into('<I', self.d, self.opt + 56, align(va + len(data), self.sa))  # SizeOfImage
        return va

    def checksum(self):
        off = self.opt + 64
        struct.pack_into('<I', self.d, off, 0)
        d = bytes(self.d) + b'\0' * (len(self.d) % 2)
        s = 0
        for (w,) in struct.iter_unpack('<H', d):
            s += w
            s = (s & 0xFFFF) + (s >> 16)
        s = (s & 0xFFFF) + (s >> 16)
        struct.pack_into('<I', self.d, off, (s + len(self.d)) & 0xFFFFFFFF)


# ------------------------------------------------------------------ pohon resource
def baca_pohon(pe):
    rva, _ = pe.resource()
    base = pe.rva_to_off(rva)
    d = pe.d

    def nama(o):
        n = struct.unpack_from('<H', d, base + o)[0]
        return d[base + o + 2: base + o + 2 + 2 * n].decode('utf-16-le')

    def dir_(o):
        nn, ni = struct.unpack_from('<HH', d, base + o + 12)
        hdr = bytes(d[base + o: base + o + 12])
        ent = []
        for i in range(nn + ni):
            k, v = struct.unpack_from('<II', d, base + o + 16 + 8 * i)
            key = nama(k & 0x7FFFFFFF) if k & 0x80000000 else k
            if v & 0x80000000:
                ent.append((key, dir_(v & 0x7FFFFFFF)))
            else:
                drva, sz, cp, _ = struct.unpack_from('<IIII', d, base + v)
                doff = pe.rva_to_off(drva)
                ent.append((key, {'data': bytes(d[doff:doff + sz]), 'cp': cp}))
        return {'hdr': hdr, 'ent': ent}

    return dir_(0)


def tulis_pohon(root, va):
    """Serialisasi: direktori → data entry → string nama → data (selaras 8)."""
    dirs, leaves, names = [], [], []

    def kumpul(n):
        dirs.append(n)
        # urutan wajib: entri bernama dulu (urut), lalu ID (urut)
        n['ent'].sort(key=lambda e: (0, e[0]) if isinstance(e[0], str) else (1, e[0]))
        for k, v in n['ent']:
            if isinstance(k, str) and k not in names:
                names.append(k)
            if 'ent' in v:
                kumpul(v)
            else:
                leaves.append(v)

    kumpul(root)
    off = 0
    for n in dirs:
        n['_off'] = off
        off += 16 + 8 * len(n['ent'])
    for l in leaves:
        l['_off'] = off
        off += 16
    name_off = {}
    for s in names:
        name_off[s] = off
        off += 2 + 2 * len(s)
    off = align(off, 8)
    for l in leaves:
        l['_doff'] = off
        off = align(off + len(l['data']), 8)
    buf = bytearray(off)
    for n in dirs:
        nn = sum(1 for k, _ in n['ent'] if isinstance(k, str))
        buf[n['_off']:n['_off'] + 12] = n['hdr'][:12]
        struct.pack_into('<HH', buf, n['_off'] + 12, nn, len(n['ent']) - nn)
        for i, (k, v) in enumerate(n['ent']):
            kk = (name_off[k] | 0x80000000) if isinstance(k, str) else k
            vv = (v['_off'] | 0x80000000) if 'ent' in v else v['_off']
            struct.pack_into('<II', buf, n['_off'] + 16 + 8 * i, kk, vv)
    for l in leaves:
        struct.pack_into('<IIII', buf, l['_off'], va + l['_doff'], len(l['data']), l['cp'], 0)
        buf[l['_doff']:l['_doff'] + len(l['data'])] = l['data']
    for s, o in name_off.items():
        struct.pack_into('<H', buf, o, len(s))
        buf[o + 2:o + 2 + 2 * len(s)] = s.encode('utf-16-le')
    return bytes(buf)


def cari(n, key):
    for k, v in n['ent']:
        if k == key:
            return v
    return None


HDR0 = bytes(12)


# ------------------------------------------------------------------ ikon
def ganti_ikon(root, ico):
    _, typ, cnt = struct.unpack_from('<HHH', ico, 0)
    assert typ == 1 and cnt > 0
    icons = []
    for i in range(cnt):
        w, h, cc, r, planes, bc, sz, off = struct.unpack_from('<BBBBHHII', ico, 6 + 16 * i)
        icons.append((w, h, cc, r, planes, bc, ico[off:off + sz]))
    grp = cari(root, RT_GROUP_ICON)
    grp_key, lang = 1, 1033
    if grp and grp['ent']:
        grp_key = grp['ent'][0][0]
        lang = grp['ent'][0][1]['ent'][0][0]
    root['ent'] = [e for e in root['ent'] if e[0] not in (RT_ICON, RT_GROUP_ICON)]
    icon_dir = {'hdr': HDR0, 'ent': [(i + 1, {'hdr': HDR0, 'ent': [(lang, {'data': img, 'cp': 0})]}) for i, (*_, img) in enumerate(icons)]}
    g = struct.pack('<HHH', 0, 1, cnt) + b''.join(struct.pack('<BBBBHHIH', w, h, cc, r, planes, bc, len(img), i + 1) for i, (w, h, cc, r, planes, bc, img) in enumerate(icons))
    grp_dir = {'hdr': HDR0, 'ent': [(grp_key, {'hdr': HDR0, 'ent': [(lang, {'data': g, 'cp': 0})]})]}
    root['ent'] += [(RT_ICON, icon_dir), (RT_GROUP_ICON, grp_dir)]
    return cnt


# ------------------------------------------------------------------ versi
def blok(key, value=b'', anak=b'', jenis_teks=False):
    k = (key + '\0').encode('utf-16-le')
    hdr_len = 6 + len(k)
    pad1 = align(hdr_len, 4) - hdr_len
    val_len = (len(value) // 2) if jenis_teks else len(value)
    body = k + b'\0' * pad1 + value
    if anak:
        body += b'\0' * (align(6 + len(body), 4) - (6 + len(body))) + anak
    total = 6 + len(body)
    return struct.pack('<HHH', total, val_len, 1 if jenis_teks else 0) + body


def teks(key, val):
    b = blok(key, (val + '\0').encode('utf-16-le'), jenis_teks=True)
    return b + b'\0' * (align(len(b), 4) - len(b))


def versi_info(ver, strings, lang=0x0409, cp=1200):
    a = [int(x) for x in ver.split('.')] + [0] * 4
    ms, ls = (a[0] << 16) | a[1], (a[2] << 16) | a[3]
    ffi = struct.pack('<IIIIIIIIIIIII', 0xFEEF04BD, 0x00010000, ms, ls, ms, ls, 0x3F, 0, 0x40004, 1, 0, 0, 0)
    st = b''.join(teks(k, v) for k, v in strings.items())
    table = blok('%04x%04x' % (lang, cp), anak=st)
    sfi = blok('StringFileInfo', anak=table + b'\0' * (align(len(table), 4) - len(table)))
    var = blok('Translation', struct.pack('<HH', lang, cp))
    vfi = blok('VarFileInfo', anak=var)
    anak = sfi + b'\0' * (align(len(sfi), 4) - len(sfi)) + vfi
    return blok('VS_VERSION_INFO', ffi, anak=anak)


def ganti_versi(root, ver, strings):
    v = cari(root, RT_VERSION)
    lang = 1033
    key = 1
    if v and v['ent']:
        key = v['ent'][0][0]
        lang = v['ent'][0][1]['ent'][0][0]
    root['ent'] = [e for e in root['ent'] if e[0] != RT_VERSION]
    data = versi_info(ver, strings)
    root['ent'].append((RT_VERSION, {'hdr': HDR0, 'ent': [(key, {'hdr': HDR0, 'ent': [(lang, {'data': data, 'cp': 0})]})]}))


def pasang_integritas(root, data, lang=1033):
    json.loads(data.decode('utf-8'))  # harus JSON valid
    root['ent'] = [e for e in root['ent'] if e[0] != 'INTEGRITY']
    root['ent'].append(('INTEGRITY', {'hdr': HDR0, 'ent': [('ELECTRONASAR', {'hdr': HDR0, 'ent': [(lang, {'data': data, 'cp': 0})]})]}))


def main():
    exe, ico, ver, js = sys.argv[1:5]
    integritas = open(sys.argv[5], 'rb').read() if len(sys.argv) > 5 else None
    pe = PE(open(exe, 'rb').read())
    root = baca_pohon(pe)
    n = ganti_ikon(root, open(ico, 'rb').read())
    ganti_versi(root, ver, json.loads(js))
    if integritas:
        pasang_integritas(root, integritas, cari(root, RT_VERSION)['ent'][0][1]['ent'][0][0])
    secs = pe.sections()
    last = max(secs, key=lambda s: s['va'])
    va = align(last['va'] + max(last['vs'], last['rs']), pe.sa)
    data = tulis_pohon(root, va)
    # section lama berganti nama (tidak dirujuk lagi); section baru memakai nama baku .rsrc
    for sec in pe.sections():
        if sec['name'] == b'.rsrc':
            pe.d[sec['off']:sec['off'] + 8] = b'.rsrcold'
    va2 = pe.tambah_section(b'.rsrc', data, 0x40000040)
    assert va2 == va
    struct.pack_into('<II', pe.d, pe.dd + 8 * 2, va, len(data))
    pe.checksum()
    open(exe, 'wb').write(pe.d)
    print('ikon (%d gambar) & versi %s terpasang%s: %s' % (n, ver, ' + integritas asar' if integritas else '', exe))


if __name__ == '__main__':
    main()
