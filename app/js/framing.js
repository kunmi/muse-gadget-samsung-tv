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
 * Port of the Muse Gadget SDK's linux/src/musegadget/noise/framing.py: the
 * NoiseTransportFrame protobuf that chunks one service message across
 * WebSocket frames.
 *
 *   NoiseTransportFrame {1: chunk_id int64, 2: chunk_index uint32,
 *                        3: total_chunks uint32, 4: payload bytes}
 *
 * Chunk payloads are capped at 65,489 bytes, a message at 256 chunks and
 * 16 MiB assembled, with at most 16 assemblies pending for at most 60 s.
 * chunk_id is a random int64 and is carried as a BigInt end to end.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;
  var proto = MG.proto;

  var MAX_CHUNK_PAYLOAD = 65489;
  var MAX_PENDING_ASSEMBLIES = 16;
  var MAX_TOTAL_CHUNKS = 256;
  var MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
  var ASSEMBLY_TTL_SECONDS = 60;

  function randomInt64() {
    var bytes = util.randomBytes(8);
    var v = 0n;
    for (var i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    // Interpret as signed int64, like framing.py's _random_int64.
    if (v >= (1n << 63n)) v -= (1n << 64n);
    return v;
  }

  function encodeNoiseFrame(frame) {
    var parts = [];
    if (frame.chunkId !== 0n) parts.push(proto.int64Field(1, frame.chunkId));
    if (frame.chunkIndex !== 0) parts.push(proto.uint32Field(2, frame.chunkIndex));
    if (frame.totalChunks !== 0) parts.push(proto.uint32Field(3, frame.totalChunks));
    if (frame.payload && frame.payload.length) parts.push(proto.bytesField(4, frame.payload));
    return util.concatBytes.apply(null, parts);
  }

  function decodeNoiseFrame(data) {
    var chunkId = 0n, chunkIndex = 0, totalChunks = 1, payload = new Uint8Array(0);
    var offset = 0, k, r;
    while (offset < data.length) {
      k = proto.readKey(data, offset); offset = k.offset;
      if (k.fieldNumber === 1) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('NoiseTransportFrame.chunk_id wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset;
        chunkId = proto.decodeInt64(r.value);
      } else if (k.fieldNumber === 2) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('NoiseTransportFrame.chunk_index wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset;
        chunkIndex = proto.decodeUint32(r.value);
      } else if (k.fieldNumber === 3) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('NoiseTransportFrame.total_chunks wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset;
        totalChunks = proto.decodeUint32(r.value);
      } else if (k.fieldNumber === 4) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('NoiseTransportFrame.payload wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset;
        payload = r.bytes;
      } else {
        offset = proto.skipField(data, offset, k.wireType);
      }
    }
    return { chunkId: chunkId, chunkIndex: chunkIndex, totalChunks: totalChunks, payload: payload };
  }

  // Splits one message into framed chunks; returns an array of protobuf
  // byte strings (not yet Noise-encrypted). chunkId may be a BigInt; a
  // random one is chosen when omitted, as in the SDK.
  function encodeNoiseFrames(data, chunkId) {
    var payload = new Uint8Array(data);
    var selectedChunkId = (chunkId === undefined || chunkId === null) ? randomInt64() : chunkId;
    var totalChunks = Math.max(1, Math.ceil(payload.length / MAX_CHUNK_PAYLOAD));
    if (totalChunks > MAX_TOTAL_CHUNKS) {
      throw new Error(
        'payload too large for noise framing (' + payload.length + ' bytes, ' +
        totalChunks + ' chunks > ' + MAX_TOTAL_CHUNKS + ')');
    }
    if (payload.length === 0) {
      return [encodeNoiseFrame({
        chunkId: selectedChunkId, chunkIndex: 0, totalChunks: 1, payload: new Uint8Array(0),
      })];
    }
    var frames = [];
    for (var index = 0; index < totalChunks; index++) {
      var start = index * MAX_CHUNK_PAYLOAD;
      frames.push(encodeNoiseFrame({
        chunkId: selectedChunkId,
        chunkIndex: index,
        totalChunks: totalChunks,
        payload: payload.subarray(start, start + MAX_CHUNK_PAYLOAD),
      }));
    }
    return frames;
  }

  function NoiseFrameDecoder(nowFn) {
    this._pending = new Map(); // chunkId (string) -> assembly
    this._poisoned = false;
    this._now = nowFn || function () { return Date.now() / 1000; };
  }

  // Returns the reassembled message, or null when more chunks are needed.
  NoiseFrameDecoder.prototype.decode = function (frameBytes) {
    if (this._poisoned) throw new Error('NoiseFrameDecoder: poisoned after prior failure');
    try {
      return this._decode(frameBytes);
    } catch (err) {
      this._poisoned = true;
      throw err;
    }
  };

  NoiseFrameDecoder.prototype._decode = function (frameBytes) {
    var frame = decodeNoiseFrame(new Uint8Array(frameBytes));
    if (frame.chunkId < -(1n << 63n) || frame.chunkId > (1n << 63n) - 1n) {
      throw new Error('chunkId outside int64 range: ' + frame.chunkId);
    }
    if (frame.totalChunks < 1 || frame.totalChunks > MAX_TOTAL_CHUNKS) {
      throw new Error('invalid totalChunks: ' + frame.totalChunks);
    }
    if (frame.chunkIndex < 0 || frame.chunkIndex >= frame.totalChunks) {
      throw new Error('chunkIndex ' + frame.chunkIndex + ' out of range [0, ' + frame.totalChunks + ')');
    }
    if (frame.payload.length > MAX_CHUNK_PAYLOAD) {
      throw new Error('payload too large for noise frame (' + frame.payload.length + ' bytes)');
    }

    this._evictExpired();

    var key = frame.chunkId.toString();
    var assembly = this._pending.get(key);
    if (!assembly) {
      if (this._pending.size >= MAX_PENDING_ASSEMBLIES) {
        throw new Error('too many pending noise frame assemblies');
      }
      var now = this._now();
      assembly = { chunks: {}, total: frame.totalChunks, totalBytes: 0, createdAt: now, lastUpdated: now };
      this._pending.set(key, assembly);
    }

    if (assembly.total !== frame.totalChunks) {
      this._pending.delete(key);
      throw new Error(
        'inconsistent totalChunks for chunkId: expected ' + assembly.total + ', got ' + frame.totalChunks);
    }
    if (assembly.chunks[frame.chunkIndex] !== undefined) {
      this._pending.delete(key);
      throw new Error('duplicate chunkIndex ' + frame.chunkIndex);
    }

    assembly.lastUpdated = this._now();
    assembly.totalBytes += frame.payload.length;
    if (assembly.totalBytes > MAX_ASSEMBLY_BYTES) {
      this._pending.delete(key);
      throw new Error('assembly exceeded byte budget');
    }

    assembly.chunks[frame.chunkIndex] = frame.payload;
    if (Object.keys(assembly.chunks).length < assembly.total) return null;

    this._pending.delete(key);
    if (assembly.total === 1) return assembly.chunks[0];
    var parts = [];
    for (var i = 0; i < assembly.total; i++) parts.push(assembly.chunks[i]);
    return util.concatBytes.apply(null, parts);
  };

  NoiseFrameDecoder.prototype._evictExpired = function () {
    var now = this._now();
    var self = this;
    this._pending.forEach(function (assembly, key) {
      if (now - assembly.createdAt > ASSEMBLY_TTL_SECONDS) self._pending.delete(key);
    });
  };

  MG.framing = {
    MAX_CHUNK_PAYLOAD: MAX_CHUNK_PAYLOAD,
    MAX_TOTAL_CHUNKS: MAX_TOTAL_CHUNKS,
    MAX_ASSEMBLY_BYTES: MAX_ASSEMBLY_BYTES,
    encodeNoiseFrame: encodeNoiseFrame,
    decodeNoiseFrame: decodeNoiseFrame,
    encodeNoiseFrames: encodeNoiseFrames,
    NoiseFrameDecoder: NoiseFrameDecoder,
    randomInt64: randomInt64,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.framing;
})(typeof globalThis !== 'undefined' ? globalThis : this);
