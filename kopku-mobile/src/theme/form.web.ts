/**
 * KOPKU DESKTOP — kepadatan form untuk mouse & keyboard. Hanya angka
 * tampilan; struktur, validasi, dan handler form tidak berubah.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dasar: typeof import('./form') = require('./form.ts');

export const formUi = {
  ...dasar.formUi,
  field: { ...dasar.formUi.field, marginBottom: 14 },
  label: { ...dasar.formUi.label, fontSize: 12.5, marginBottom: 6, color: '#344054' },
  input: { ...dasar.formUi.input, paddingVertical: 8, fontSize: 14 },
} as unknown as typeof dasar.formUi;

export const inputTypeIcon = dasar.inputTypeIcon;
export type InputTypeName = import('./form').InputTypeName;
