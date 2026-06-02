'use strict'

const types = require('pg-types')

// OID of the bytea type. pg-types ships no binary parser for bytea, so without
// an override `getTypeParser(17, 'binary')` falls back to `noParse` which does
// `String(buffer)` and corrupts the raw bytes. The binary wire format for bytea
// is simply the raw bytes, and text mode already yields a Buffer, so we install
// a passthrough that returns the Buffer as-is. This keeps `binary: true` results
// for bytea consistent with text mode (a Buffer) rather than a mangled string.
// Users can still override it via `client.setTypeParser(17, 'binary', fn)`.
const BYTEA_OID = 17
const byteaBinaryPassthrough = (buffer) => buffer

function TypeOverrides(userTypes) {
  this._types = userTypes || types
  this.text = {}
  this.binary = {
    [BYTEA_OID]: byteaBinaryPassthrough,
  }
}

TypeOverrides.prototype.getOverrides = function (format) {
  switch (format) {
    case 'text':
      return this.text
    case 'binary':
      return this.binary
    default:
      return {}
  }
}

TypeOverrides.prototype.setTypeParser = function (oid, format, parseFn) {
  if (typeof format === 'function') {
    parseFn = format
    format = 'text'
  }
  this.getOverrides(format)[oid] = parseFn
}

TypeOverrides.prototype.getTypeParser = function (oid, format) {
  format = format || 'text'
  return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format)
}

module.exports = TypeOverrides
