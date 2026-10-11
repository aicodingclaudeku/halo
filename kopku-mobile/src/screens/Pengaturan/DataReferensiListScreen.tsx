import React, { useCallback, useEffect, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  listDataReferensi,
  tambahDataReferensi,
  editDataReferensi,
  hapusDataReferensi,
  DataReferensiItem,
  JenisDataReferensi,
  LABEL_JENIS_DATA_REFERENSI,
} from '@/services/DataReferensiService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

import FocusTextInput from '@/components/FocusTextInput';
/**
 * Layar "Data Pemasok" / "Data Bank Pemberi Pinjaman" / "Data Pemberi
 * Pinjaman" / "Data Beban Lain" — SATU komponen generik dipakai untuk
 * ke-4 jenis lewat route param `jenis` (lihat InputDataHubScreen).
 * Tambah/edit inline di layar ini (bukan navigasi ke form terpisah)
 * karena field-nya cukup sederhana untuk modal ringan.
 *
 * Phase 17 §U/§V: field Alamat ditambahkan KHUSUS untuk jenis PEMASOK
 * & PEMBERI_PINJAMAN_PIHAK_LAIN (satu-satunya dua jenis yang diminta
 * eksplisit) — Bank Pemberi Pinjaman & Beban Lain tetap cuma nama.
 * Delete permanen ditambahkan dengan dialog konfirmasi (aman —
 * transaksi menyimpan nama sebagai teks bebas, tidak FK ke sini, lihat
 * catatan di DataReferensiService.hapusDataReferensi).
 */
const JENIS_DENGAN_ALAMAT: JenisDataReferensi[] = ['PEMASOK', 'PEMBERI_PINJAMAN_PIHAK_LAIN'];

export default function DataReferensiListScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const jenis: JenisDataReferensi = route.params?.jenis;
  const currentUser = useAppStore((s) => s.currentUser);
  const pakaiAlamat = JENIS_DENGAN_ALAMAT.includes(jenis);

  const [data, setData] = useState<DataReferensiItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [namaBaru, setNamaBaru] = useState('');
  const [alamatBaru, setAlamatBaru] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNama, setEditingNama] = useState('');
  const [editingAlamat, setEditingAlamat] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listDataReferensi(jenis, { termasukNonaktif: true }));
    } finally {
      setLoading(false);
    }
  }, [jenis]);

  useEffect(() => {
    navigation.setOptions({ title: LABEL_JENIS_DATA_REFERENSI[jenis] });
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load, jenis]);

  const tambah = async () => {
    if (!namaBaru.trim() || !currentUser) return;
    setSubmitting(true);
    try {
      await tambahDataReferensi({
        jenis,
        nama: namaBaru.trim(),
        alamat: pakaiAlamat && alamatBaru.trim() ? alamatBaru.trim() : undefined,
        createdBy: currentUser.id,
      });
      setNamaBaru('');
      setAlamatBaru('');
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  const mulaiEdit = (item: DataReferensiItem) => {
    setEditingId(item.id);
    setEditingNama(item.nama);
    setEditingAlamat(item.alamat ?? '');
  };

  const simpanEdit = async (item: DataReferensiItem) => {
    if (!editingNama.trim() || !currentUser) return;
    try {
      await editDataReferensi({
        id: item.id,
        nama: editingNama.trim(),
        alamat: pakaiAlamat && editingAlamat.trim() ? editingAlamat.trim() : undefined,
        aktif: item.aktif,
        updatedBy: currentUser.id,
      });
      setEditingId(null);
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  };

  const toggleAktif = async (item: DataReferensiItem) => {
    if (!currentUser) return;
    try {
      await editDataReferensi({ id: item.id, nama: item.nama, alamat: item.alamat ?? undefined, aktif: !item.aktif, updatedBy: currentUser.id });
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  };

  const konfirmasiHapus = (item: DataReferensiItem) => {
    notify('Hapus Data', `Hapus "${item.nama}" secara permanen?`, [
      { text: 'Batal', style: 'cancel' },
      { text: 'Hapus', style: 'destructive', onPress: () => hapus(item) },
    ]);
  };

  const hapus = async (item: DataReferensiItem) => {
    if (!currentUser) return;
    setDeletingId(item.id);
    try {
      await hapusDataReferensi(currentUser.id, item.id);
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <View style={styles.container}>
        <View style={styles.addBox}>
          <FocusTextInput
            style={styles.addInput}
            value={namaBaru}
            onChangeText={setNamaBaru}
            placeholder="Nama baru..."
            placeholderTextColor={colors.placeholder}
          />
          {pakaiAlamat && (
            <FocusTextInput
              style={[styles.addInput, { marginTop: spacing.sm }]}
              value={alamatBaru}
              onChangeText={setAlamatBaru}
              placeholder="Alamat (opsional)"
              placeholderTextColor={colors.placeholder}
            />
          )}
          <TouchableOpacity style={styles.addButton} onPress={tambah} disabled={submitting}>
            {submitting ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <>
                <Ionicons name="add" size={18} color={colors.white} />
                <Text style={styles.addButtonText}>Tambah</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {loading && <ActivityIndicator style={{ marginTop: 24 }} />}

        {!loading && (
          <FlatList
            data={data}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
            ListEmptyComponent={<Text style={styles.emptyText}>Belum ada data. Tambahkan lewat kolom di atas.</Text>}
            renderItem={({ item }) => (
              <View style={[styles.row, !item.aktif && styles.rowNonaktif]}>
                {editingId === item.id ? (
                  <View style={{ flex: 1 }}>
                    <FocusTextInput
                      style={styles.editInput}
                      value={editingNama}
                      onChangeText={setEditingNama}
                      autoFocus
                      onSubmitEditing={() => simpanEdit(item)}
                    />
                    {pakaiAlamat && (
                      <FocusTextInput
                        style={[styles.editInput, { marginTop: spacing.xs }]}
                        value={editingAlamat}
                        onChangeText={setEditingAlamat}
                        placeholder="Alamat"
                        placeholderTextColor={colors.placeholder}
                        onSubmitEditing={() => simpanEdit(item)}
                      />
                    )}
                  </View>
                ) : (
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowNama}>{item.nama}</Text>
                    {pakaiAlamat && item.alamat && <Text style={styles.rowAlamat}>{item.alamat}</Text>}
                  </View>
                )}
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  {editingId === item.id ? (
                    <TouchableOpacity onPress={() => simpanEdit(item)}>
                      <Ionicons name="checkmark" size={20} color={colors.primary} />
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity onPress={() => mulaiEdit(item)}>
                      <Ionicons name="pencil-outline" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={() => toggleAktif(item)}>
                    <Ionicons
                      name={item.aktif ? 'eye-outline' : 'eye-off-outline'}
                      size={18}
                      color={item.aktif ? colors.textMuted : colors.danger}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => konfirmasiHapus(item)} disabled={deletingId === item.id}>
                    {deletingId === item.id ? (
                      <ActivityIndicator size="small" color={colors.danger} />
                    ) : (
                      <Ionicons name="trash-outline" size={18} color={colors.danger} />
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            )}
          />
        )}
      </View>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  addBox: { padding: spacing.lg },
  addInput: { ...formUi.inputStandalone },
  addButton: {
    flexDirection: 'row',
    gap: 6,
    marginTop: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  addButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowNonaktif: { opacity: 0.5 },
  rowNama: { fontSize: 14, color: colors.text, fontWeight: '600' },
  rowAlamat: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  // Sebelumnya border primary permanen sebagai penanda mode edit; kini
  // penanda itu datang dari focus state bersama (input ini autoFocus).
  editInput: { ...formUi.inputStandalone },
});
