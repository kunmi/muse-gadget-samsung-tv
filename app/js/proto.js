/*
 * Copyright (c) 2026 Muse Gadget TV contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Port of the Muse Gadget SDK's linux/src/musegadget/noise/_proto.py: the
 * minimal protobuf wire codec the Noise transport uses. Varints are BigInt
 * internally so int64 fields (stream ids, chunk ids) survive exactly.
 * Protocol constants keep their wire meaning; see PROTOCOL.md.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;

  var WIRE_VARINT = 0;
  var WIRE_FIXED64 = 1;
  var WIRE_DELIMITED = 2;
  var WIRE_FIXED32 = 5;

  var MAX_FIELD_NUMBER = (1 << 29) - 1;
  var FIRST_RESERVED = 19000;
  var LAST_RESERVED = 19999;

  function ProtoError(message) {
    var err = new Error(message);
    err.name = 'ProtoError';
    return err;
  }

  function validFieldNumber(fieldNumber) {
    return (
      fieldNumber !== 0 &&
      fieldNumber <= MAX_FIELD_NUMBER &&
      !(fieldNumber >= FIRST_RESERVED && fieldNumber <= LAST_RESERVED)
    );
  }

  function encodeVarint(value) {
    var v = typeof value === 'bigint' ? value : BigInt(value);
    if (v < 0n) throw ProtoError('varint value must be non-negative');
    if (v >= (1n << 64n)) throw ProtoError('varint value exceeds uint64 range');
    var out = [];
    for (;;) {
      var byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) out.push(byte | 0x80);
      else { out.push(byte); break; }
    }
    return new Uint8Array(out);
  }

  function signedInt64Value(value) {
    var v = BigInt(value);
    if (v < -(1n << 63n) || v > (1n << 63n) - 1n) throw ProtoError('int64 value out of range');
    return v & ((1n << 64n) - 1n);
  }

  function signedInt32Value(value) {
    var v = BigInt(value);
    if (v < -(1n << 31n) || v > (1n << 31n) - 1n) throw ProtoError('int32 value out of range');
    return v & ((1n << 64n) - 1n);
  }

  function decodeInt64(value) {
    var v = typeof value === 'bigint' ? value : BigInt(value);
    if (v >= (1n << 64n)) throw ProtoError('int64 wire value exceeds uint64 range');
    if (v >= (1n << 63n)) return v - (1n << 64n);
    return v;
  }

  function decodeInt32(value) {
    var v = typeof value === 'bigint' ? value : BigInt(value);
    if (v >= (1n << 64n)) throw ProtoError('int32 wire value exceeds uint64 range');
    var signed = v >= (1n << 63n) ? v - (1n << 64n) : v;
    if (signed < -(1n << 31n) || signed > (1n << 31n) - 1n) {
      throw ProtoError('int32 value out of range');
    }
    return Number(signed);
  }

  function decodeUint32(value) {
    var v = typeof value === 'bigint' ? value : BigInt(value);
    if (v > 0xffffffffn) throw ProtoError('uint32 value out of range');
    return Number(v);
  }

  function encodeKey(fieldNumber, wireType) {
    if (!validFieldNumber(fieldNumber)) throw ProtoError('invalid field number');
    if ([WIRE_VARINT, WIRE_FIXED64, WIRE_DELIMITED, WIRE_FIXED32].indexOf(wireType) < 0) {
      throw ProtoError('invalid wire type');
    }
    return encodeVarint(BigInt((fieldNumber << 3) | wireType));
  }

  function varintField(fieldNumber, value) {
    return util.concatBytes(encodeKey(fieldNumber, WIRE_VARINT), encodeVarint(value));
  }

  function int64Field(fieldNumber, value) {
    return varintField(fieldNumber, signedInt64Value(value));
  }

  function int32Field(fieldNumber, value) {
    return varintField(fieldNumber, signedInt32Value(value));
  }

  function uint32Field(fieldNumber, value) {
    if (value < 0 || value > 0xffffffff) throw ProtoError('uint32 value out of range');
    return varintField(fieldNumber, value);
  }

  function boolField(fieldNumber, value) {
    return varintField(fieldNumber, value ? 1 : 0);
  }

  function delimitedField(fieldNumber, payload) {
    return util.concatBytes(
      encodeKey(fieldNumber, WIRE_DELIMITED), encodeVarint(payload.length), payload);
  }

  function stringField(fieldNumber, value) {
    return delimitedField(fieldNumber, util.utf8Encode(value));
  }

  function bytesField(fieldNumber, value) {
    return delimitedField(fieldNumber, value);
  }

  // Returns {value: BigInt, offset}.
  function readVarint(data, offset) {
    var value = 0n;
    var shift = 0n;
    for (var i = 0; i < 10; i++) {
      if (offset >= data.length) throw ProtoError('truncated varint');
      var byte = data[offset];
      offset += 1;
      if (i === 9 && (byte & 0xfe) !== 0) throw ProtoError('malformed varint');
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return { value: value, offset: offset };
      shift += 7n;
    }
    throw ProtoError('malformed varint');
  }

  // Returns {fieldNumber, wireType, offset}.
  function readKey(data, offset) {
    var r = readVarint(data, offset);
    var key = r.value;
    var fieldNumber = Number(key >> 3n);
    var wireType = Number(key & 0x07n);
    if (!validFieldNumber(fieldNumber)) throw ProtoError('invalid field number');
    if ([WIRE_VARINT, WIRE_FIXED64, WIRE_DELIMITED, WIRE_FIXED32].indexOf(wireType) < 0) {
      throw ProtoError('invalid wire type');
    }
    return { fieldNumber: fieldNumber, wireType: wireType, offset: r.offset };
  }

  // Returns {bytes, offset}.
  function readDelimited(data, offset) {
    var r = readVarint(data, offset);
    var length = Number(r.value);
    var end = r.offset + length;
    if (end > data.length) throw ProtoError('truncated delimited field');
    return { bytes: data.subarray(r.offset, end), offset: end };
  }

  function skipField(data, offset, wireType) {
    if (wireType === WIRE_VARINT) return readVarint(data, offset).offset;
    if (wireType === WIRE_FIXED64) {
      if (offset + 8 > data.length) throw ProtoError('truncated fixed64 field');
      return offset + 8;
    }
    if (wireType === WIRE_DELIMITED) return readDelimited(data, offset).offset;
    if (wireType === WIRE_FIXED32) {
      if (offset + 4 > data.length) throw ProtoError('truncated fixed32 field');
      return offset + 4;
    }
    throw ProtoError('invalid wire type');
  }

  MG.proto = {
    WIRE_VARINT: WIRE_VARINT,
    WIRE_FIXED64: WIRE_FIXED64,
    WIRE_DELIMITED: WIRE_DELIMITED,
    WIRE_FIXED32: WIRE_FIXED32,
    ProtoError: ProtoError,
    encodeVarint: encodeVarint,
    signedInt64Value: signedInt64Value,
    signedInt32Value: signedInt32Value,
    decodeInt64: decodeInt64,
    decodeInt32: decodeInt32,
    decodeUint32: decodeUint32,
    encodeKey: encodeKey,
    varintField: varintField,
    int64Field: int64Field,
    int32Field: int32Field,
    uint32Field: uint32Field,
    boolField: boolField,
    delimitedField: delimitedField,
    stringField: stringField,
    bytesField: bytesField,
    readVarint: readVarint,
    readKey: readKey,
    readDelimited: readDelimited,
    skipField: skipField,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.proto;
})(typeof globalThis !== 'undefined' ? globalThis : this);
