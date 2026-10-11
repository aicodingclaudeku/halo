'use strict';
// Stub modul native yang tidak relevan untuk uji Node.
module.exports = new Proxy({ __esModule: true, AuthenticationType: {}, SecurityLevel: {} }, { get: (t, k) => (k in t ? t[k] : async () => false) });
