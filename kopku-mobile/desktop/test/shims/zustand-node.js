'use strict';
// Pengganti minimal `zustand` untuk uji e2e Node bila node_modules tidak
// tersedia (lingkungan tanpa registry npm). API: create(fn) → hook dengan
// getState/setState/subscribe — hanya yang dipakai store KOPKU.
function create(init) {
  let state;
  const dengar = new Set();
  const setState = (p) => {
    const lanjut = typeof p === 'function' ? p(state) : p;
    state = Object.assign({}, state, lanjut);
    for (const f of dengar) f(state);
  };
  const getState = () => state;
  const subscribe = (f) => (dengar.add(f), () => dengar.delete(f));
  state = init(setState, getState, { setState, getState, subscribe });
  const hook = (sel) => (sel ? sel(state) : state);
  return Object.assign(hook, { getState, setState, subscribe });
}
module.exports = { create, default: create };
