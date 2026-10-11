'use strict';
const Module = require('module');
const path = require('path');
const BUILD = path.join(__dirname, 'build3', 'src');
const HARNESS = path.join(__dirname, 'build3', '.harness');

const MAP = {
  'expo-secure-store': path.join(BUILD, 'test-utils', 'expoSecureStoreMock.js'),
  'expo-crypto': path.join(BUILD, 'test-utils', 'expoCryptoMock.js'),
  '@noble/ed25519': path.join(BUILD, 'test-utils', 'nobleEd25519Mock.js'),
  '@noble/hashes/sha512': path.join(BUILD, 'test-utils', 'nobleSha512Mock.js'),
  'expo-sqlite': path.join(BUILD, 'test-utils', 'expoSqliteMock.js'),
  'expo-file-system': path.join(BUILD, 'test-utils', 'expoSqliteMock.js'),
  'expo-file-system/legacy': path.join(BUILD, 'test-utils', 'expoSqliteMock.js'),
  'expo-task-manager': path.join(BUILD, 'test-utils', 'expoBackgroundMock.js'),
  'expo-background-task': path.join(BUILD, 'test-utils', 'expoBackgroundMock.js'),
  'decimal.js': path.join(HARNESS, 'decimalHarness.js'),
  'date-fns': path.join(HARNESS, 'dateFnsShim.js'),
};

const original = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (Object.prototype.hasOwnProperty.call(MAP, request)) {
    return original.call(this, MAP[request], parent, isMain, options);
  }
  // Seluruh import './testDb' dari suite diarahkan ke adapter node:sqlite
  // di .harness/ — sql.js tidak terpasang di lingkungan ini.
  if (/(^|\/)testDb$/.test(request)) {
    return original.call(this, path.join(HARNESS, 'testDb.js'), parent, isMain, options);
  }
  if (request === '@/database/db') {
    return original.call(this, path.join(__dirname, 'dbShim.js'), parent, isMain, options);
  }
  if (request.startsWith('@/')) {
    return original.call(this, path.join(BUILD, request.slice(2)), parent, isMain, options);
  }
  return original.call(this, request, parent, isMain, options);
};
