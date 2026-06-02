'use strict'

const types = require('pg-types')

const matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/

// Detect whether runtime code generation (`new Function`) is permitted. Some
// sandboxed runtimes (e.g. Cloudflare Workers under the default CSP) forbid it;
// there we transparently fall back to the interpreted row builders.
let canCompile = true
try {
  new Function('return 1')()
} catch (e) {
  canCompile = false
}

// Build a function that materializes a result row directly, instead of
// allocating an empty object/array and filling it field-by-field in a loop.
// V8 compiles the generated literal into a single shaped allocation with the
// per-field stores inlined, which is several times faster than the interpreted
// path. The builder is a pure function of (rowData `d`, parsers `p`)
// so it captures nothing and can be garbage collected with the Result.
//
// `d[i]` is the raw field value: a string for text columns, a Buffer for binary
// columns (the parser yields a copied Buffer for binary fields), or null for SQL
// NULL. The per-column type parser `p[i]` (selected by format in addFields) is
// applied verbatim, so binary columns get their Buffer passed straight to the
// binary parser. Column names only ever appear via JSON.stringify, so arbitrary
// DB-supplied names cannot inject code.
function compileArrayRowBuilder(fieldCount) {
  let src = 'return ['
  for (let i = 0; i < fieldCount; i++) {
    if (i) src += ','
    // array mode historically does not apply the binary->Buffer conversion
    src += `d[${i}]===null?null:p[${i}](d[${i}])`
  }
  src += ']'

  return new Function('d', 'p', src)
}

// Array-mode builders depend only on the column count (parsers are passed in at
// call time), so they can be shared across queries. The key space is naturally
// bounded by the max column count Postgres allows, so this never grows large.
const arrayRowBuilderCache = new Map()
function getArrayRowBuilder(fieldCount) {
  let builder = arrayRowBuilderCache.get(fieldCount)
  if (builder === undefined) {
    builder = compileArrayRowBuilder(fieldCount)
    arrayRowBuilderCache.set(fieldCount, builder)
  }
  return builder
}

function compileObjectRowBuilder(fieldDescriptions) {
  let src = 'return {'
  for (let i = 0; i < fieldDescriptions.length; i++) {
    if (i) src += ','
    const desc = fieldDescriptions[i]
    const key = JSON.stringify(desc.name)
    // The raw field value `d[i]` is already a Buffer for binary columns and a
    // string for text columns, so it is passed straight to the per-column type
    // parser `p[i]` regardless of format. (`p[i]` is the binary parser for
    // binary columns and the text parser for text columns, chosen in addFields.)
    src += `${key}:d[${i}]===null?null:p[${i}](d[${i}])`
  }
  src += '}'

  return new Function('d', 'p', src)
}

// Object-mode builders depend only on the column names: the generated body
// applies the per-column parser `p[i]` verbatim for both text and binary (the
// raw value is already a string or Buffer), and `p` is passed at call time, so
// the same builder serves a given name set regardless of column formats.
// Compiling costs ~5us, which only pays off past ~18 rows, so for small result
// sets we'd lose CPU per query. Real apps run the same queries repeatedly, so
// cache by a collision-free signature and amortize the compile to ~zero. The
// cache is bounded to avoid unbounded growth from dynamic SQL; once full we
// simply stop caching new shapes (they still compile, just aren't retained).
const MAX_OBJECT_ROW_BUILDERS = 1000
const objectRowBuilderCache = new Map()
function getObjectRowBuilder(fieldDescriptions) {
  // `JSON.stringify(name)` is always quote-delimited and escapes embedded
  // quotes, so the concatenated `"name"` segments are unambiguous -> the
  // signature is injective (distinct name sequences never collide).
  let sig = ''
  for (let i = 0; i < fieldDescriptions.length; i++) {
    sig += JSON.stringify(fieldDescriptions[i].name)
  }
  let builder = objectRowBuilderCache.get(sig)
  if (builder === undefined) {
    builder = compileObjectRowBuilder(fieldDescriptions)
    if (objectRowBuilderCache.size < MAX_OBJECT_ROW_BUILDERS) {
      objectRowBuilderCache.set(sig, builder)
    }
  }
  return builder
}

// result object returned from query
// in the 'end' event and also
// passed as second argument to provided callback
class Result {
  constructor(rowMode, types) {
    this.command = null
    this.rowCount = null
    this.oid = null
    this.rows = []
    this.fields = []
    this._parsers = undefined
    this._types = types
    this.RowCtor = null
    this.rowAsArray = rowMode === 'array'
    if (this.rowAsArray) {
      this.parseRow = this._parseRowAsArray
    }
    this._prebuiltEmptyResultObject = null
    // a per-shape compiled row builder, populated lazily in addFields
    this._rowBuilder = null
  }

  // adds a command complete message
  addCommandComplete(msg) {
    let match
    if (msg.text) {
      // pure javascript
      match = matchRegexp.exec(msg.text)
    } else {
      // native bindings
      match = matchRegexp.exec(msg.command)
    }
    if (match) {
      this.command = match[1]
      if (match[3]) {
        // COMMAND OID ROWS
        this.oid = parseInt(match[2], 10)
        this.rowCount = parseInt(match[3], 10)
      } else if (match[2]) {
        // COMMAND ROWS
        this.rowCount = parseInt(match[2], 10)
      }
    }
  }

  _parseRowAsArray(rowData) {
    const builder = this._rowBuilder
    if (builder !== null) {
      return builder(rowData, this._parsers)
    }
    // interpreted fallback (used when runtime code generation is unavailable).
    // Hoist `this._parsers` into a local: V8 cannot prove the property is
    // invariant across the parser calls below, so reading it once avoids a
    // property load on every field.
    const len = rowData.length
    const row = new Array(len)
    const parsers = this._parsers
    for (let i = 0; i < len; i++) {
      const rawValue = rowData[i]
      row[i] = rawValue === null ? null : parsers[i](rawValue)
    }
    return row
  }

  parseRow(rowData) {
    const builder = this._rowBuilder
    if (builder !== null) {
      return builder(rowData, this._parsers)
    }
    // interpreted fallback (sandboxed runtimes, or shapes we won't compile such
    // as a "__proto__" column).
    const row = { ...this._prebuiltEmptyResultObject }
    const parsers = this._parsers
    const fields = this.fields
    const len = rowData.length
    for (let i = 0; i < len; i++) {
      const rawValue = rowData[i]
      // The raw value is already a Buffer for binary columns and a string for
      // text columns (the parser does the format-specific decode), so it is
      // applied directly to the per-column type parser `parsers[i]`.
      row[fields[i].name] = rawValue === null ? null : parsers[i](rawValue)
    }
    return row
  }

  addRow(row) {
    this.rows.push(row)
  }

  addFields(fieldDescriptions) {
    // clears field definitions
    // multiple query statements in 1 action can result in multiple sets
    // of rowDescriptions...eg: 'select NOW(); select 1::int;'
    // you need to reset the fields
    this.fields = fieldDescriptions
    if (this.fields.length) {
      this._parsers = new Array(fieldDescriptions.length)
    }

    const row = Object.create(null)

    let hasProtoField = false
    for (let i = 0; i < fieldDescriptions.length; i++) {
      const desc = fieldDescriptions[i]
      row[desc.name] = null
      // a "__proto__" column cannot be expressed as an object literal key
      // without mutating the prototype, so such shapes use the interpreted path
      if (desc.name === '__proto__') {
        hasProtoField = true
      }

      if (this._types) {
        this._parsers[i] = this._types.getTypeParser(desc.dataTypeID, desc.format || 'text')
      } else {
        this._parsers[i] = types.getTypeParser(desc.dataTypeID, desc.format || 'text')
      }
    }

    this._prebuiltEmptyResultObject = { ...row }

    // Compile a per-shape row builder. Falls back to the interpreted path when
    // code generation is forbidden (sandbox) or the shape can't be compiled.
    this._rowBuilder = null
    if (canCompile && fieldDescriptions.length) {
      try {
        this._rowBuilder = this.rowAsArray
          ? getArrayRowBuilder(fieldDescriptions.length)
          : hasProtoField
          ? null
          : getObjectRowBuilder(fieldDescriptions)
      } catch (e) {
        this._rowBuilder = null
      }
    }
  }
}

module.exports = Result
