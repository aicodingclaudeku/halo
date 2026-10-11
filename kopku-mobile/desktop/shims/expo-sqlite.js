/**
 * Shim desktop `expo-sqlite` — API async yang sama, dieksekusi di proses
 * utama oleh node:sqlite (berkas SQLite asli di folder data aplikasi).
 * withTransactionAsync meniru implementasi expo-sqlite persis.
 */
import { b } from './_bridge';

export class SQLiteDatabase {
  constructor(databaseName, id) {
    this.databaseName = databaseName;
    this._id = id;
  }
  execAsync(source) { return b().sqlite.exec(this._id, source); }
  runAsync(source, ...params) { return b().sqlite.run(this._id, source, params); }
  getFirstAsync(source, ...params) { return b().sqlite.get(this._id, source, params); }
  getAllAsync(source, ...params) { return b().sqlite.all(this._id, source, params); }
  async *getEachAsync(source, ...params) { for (const r of await this.getAllAsync(source, ...params)) yield r; }
  async withTransactionAsync(task) {
    try {
      await this.execAsync('BEGIN');
      await task();
      await this.execAsync('COMMIT');
    } catch (e) {
      await this.execAsync('ROLLBACK').catch(() => undefined);
      throw e;
    }
  }
  withExclusiveTransactionAsync(task) { return this.withTransactionAsync(() => task(this)); }
  closeAsync() { return b().sqlite.close(this._id); }
  isInTransactionAsync() { return Promise.resolve(false); }
}

export async function openDatabaseAsync(databaseName, _options, directory) {
  const { id } = await b().sqlite.open(databaseName, directory);
  return new SQLiteDatabase(databaseName, id);
}
export const defaultDatabaseDirectory = (() => { try { return b().info.documentUri + 'SQLite'; } catch { return ''; } })();
export async function deleteDatabaseAsync(databaseName, directory) {
  const dir = directory || defaultDatabaseDirectory;
  for (const s of ['', '-wal', '-shm']) await b().fs.remove(`${dir}/${databaseName}${s}`);
}
export default { openDatabaseAsync, SQLiteDatabase, deleteDatabaseAsync };
