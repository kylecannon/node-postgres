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

// pg-types ships no binary parser for uuid/json/jsonb either, so without these
// `getTypeParser(oid, 'binary')` falls back to `noParse` (String(buffer)) and
// returns a corrupted string. We install correct binary decoders so `binary:
// true` yields the same JS values as text mode. All remain user-overridable via
// `client.setTypeParser(oid, 'binary', fn)`.
const UUID_OID = 2950
const JSON_OID = 114
const JSONB_OID = 3802

// uuid binary wire format is the raw 16 bytes; format them as the canonical
// 8-4-4-4-12 lowercase-hex string (matching text mode) — 16B on the wire vs 36
// chars of text.
const uuidBinaryParser = (buffer) => {
  const hex = buffer.toString('hex')
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  )
}
// json binary wire format is just the UTF-8 JSON text.
const jsonBinaryParser = (buffer) => JSON.parse(buffer.toString('utf8'))
// jsonb binary wire format is a 1-byte version header (always 0x01) followed by
// the UTF-8 JSON text.
const jsonbBinaryParser = (buffer) => JSON.parse(buffer.toString('utf8', 1))

function TypeOverrides(userTypes) {
  this._types = userTypes || types
  this.text = {}
  this.binary = {
    [BYTEA_OID]: byteaBinaryPassthrough,
    [UUID_OID]: uuidBinaryParser,
    [JSON_OID]: jsonBinaryParser,
    [JSONB_OID]: jsonbBinaryParser,
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
