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
 * Port of the Muse Gadget SDK's linux/src/musegadget/noise/envelope.py: the
 * protobuf messages carried inside the Noise session.
 *
 *   ServiceRequest  {1: service (enum, 0 = daemon, omitted), 2: payload}
 *   ServiceResponse {1: payload}
 *   ServiceFrame    {1: stream_id, 2: request, 3: response, 4: body_chunk,
 *                    5: reset}
 *   ApplicationRequest  {1: verb, 2: path, 3: headers[], 4: body, 5: end_body}
 *   ApplicationResponse {1: status, 2: headers[], 3: body, 4: end_body}
 *   Header          {1: key, 2: value}
 *   BodyChunk       {1: data, 2: end_body}
 *   Reset           {1: code, 2: reason}
 *
 * Default-valued fields are omitted on encode and defaulted on decode,
 * exactly as the Python codec does.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;
  var proto = MG.proto;

  var ServiceType = { SERVICE_DAEMON: 0, SERVICE_SENTINEL: 1, SERVICE_VAULT: 2, SERVICE_AUTHD: 3 };
  var ResetCode = {
    CODE_UNSPECIFIED: 0, CANCELLED: 1, TIMEOUT: 2, PROTOCOL_ERROR: 3,
    REFUSED_STREAM: 4, INTERNAL_ERROR: 5, SERVICE_UNAVAILABLE: 6,
  };

  function decodeString(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      throw proto.ProtoError('invalid utf-8 string');
    }
  }

  function coerceServiceType(value) {
    if (value === 0 || value === 1 || value === 2 || value === 3) return value;
    throw proto.ProtoError('unknown service type');
  }

  function coerceResetCode(value) {
    if (value >= 0 && value <= 6) return value;
    throw proto.ProtoError('unknown reset code');
  }

  /* Header {key, value} */

  function encodeHeader(header) {
    var parts = [];
    if (header.key) parts.push(proto.stringField(1, header.key));
    if (header.value) parts.push(proto.stringField(2, header.value));
    return util.concatBytes.apply(null, parts);
  }

  function decodeHeader(data) {
    var key = '', value = '', offset = 0, k;
    while (offset < data.length) {
      k = proto.readKey(data, offset); offset = k.offset;
      if (k.fieldNumber === 1) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('Header.key wrong wire type');
        var r1 = proto.readDelimited(data, offset); offset = r1.offset;
        key = decodeString(r1.bytes);
      } else if (k.fieldNumber === 2) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('Header.value wrong wire type');
        var r2 = proto.readDelimited(data, offset); offset = r2.offset;
        value = decodeString(r2.bytes);
      } else {
        offset = proto.skipField(data, offset, k.wireType);
      }
    }
    return { key: key, value: value };
  }

  /* ApplicationRequest */

  function encodeApplicationRequest(request) {
    var parts = [];
    if (request.verb) parts.push(proto.stringField(1, request.verb));
    if (request.path) parts.push(proto.stringField(2, request.path));
    (request.headers || []).forEach(function (h) {
      parts.push(proto.delimitedField(3, encodeHeader(h)));
    });
    if (request.body && request.body.length) parts.push(proto.bytesField(4, request.body));
    if (request.endBody) parts.push(proto.boolField(5, true));
    return util.concatBytes.apply(null, parts);
  }

  function decodeApplicationRequest(data) {
    var verb = '', path = '', headers = [], body = new Uint8Array(0), endBody = false;
    var offset = 0, k, r;
    while (offset < data.length) {
      k = proto.readKey(data, offset); offset = k.offset;
      if (k.fieldNumber === 1) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ApplicationRequest.verb wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; verb = decodeString(r.bytes);
      } else if (k.fieldNumber === 2) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ApplicationRequest.path wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; path = decodeString(r.bytes);
      } else if (k.fieldNumber === 3) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ApplicationRequest.headers wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; headers.push(decodeHeader(r.bytes));
      } else if (k.fieldNumber === 4) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ApplicationRequest.body wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; body = r.bytes;
      } else if (k.fieldNumber === 5) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('ApplicationRequest.end_body wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset; endBody = r.value !== 0n;
      } else {
        offset = proto.skipField(data, offset, k.wireType);
      }
    }
    return { verb: verb, path: path, headers: headers, body: body, endBody: endBody };
  }

  /* ApplicationResponse */

  function encodeApplicationResponse(response) {
    var parts = [];
    if (response.status !== 0) parts.push(proto.int32Field(1, response.status));
    (response.headers || []).forEach(function (h) {
      parts.push(proto.delimitedField(2, encodeHeader(h)));
    });
    if (response.body && response.body.length) parts.push(proto.bytesField(3, response.body));
    if (response.endBody) parts.push(proto.boolField(4, true));
    return util.concatBytes.apply(null, parts);
  }

  function decodeApplicationResponse(data) {
    var status = 0, headers = [], body = new Uint8Array(0), endBody = false;
    var offset = 0, k, r;
    while (offset < data.length) {
      k = proto.readKey(data, offset); offset = k.offset;
      if (k.fieldNumber === 1) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('ApplicationResponse.status wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset; status = proto.decodeInt32(r.value);
      } else if (k.fieldNumber === 2) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ApplicationResponse.headers wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; headers.push(decodeHeader(r.bytes));
      } else if (k.fieldNumber === 3) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ApplicationResponse.body wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; body = r.bytes;
      } else if (k.fieldNumber === 4) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('ApplicationResponse.end_body wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset; endBody = r.value !== 0n;
      } else {
        offset = proto.skipField(data, offset, k.wireType);
      }
    }
    return { status: status, headers: headers, body: body, endBody: endBody };
  }

  /* BodyChunk */

  function encodeBodyChunk(chunk) {
    var parts = [];
    if (chunk.data && chunk.data.length) parts.push(proto.bytesField(1, chunk.data));
    if (chunk.endBody) parts.push(proto.boolField(2, true));
    return util.concatBytes.apply(null, parts);
  }

  function decodeBodyChunk(data) {
    var chunkData = new Uint8Array(0), endBody = false;
    var offset = 0, k, r;
    while (offset < data.length) {
      k = proto.readKey(data, offset); offset = k.offset;
      if (k.fieldNumber === 1) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('BodyChunk.data wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; chunkData = r.bytes;
      } else if (k.fieldNumber === 2) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('BodyChunk.end_body wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset; endBody = r.value !== 0n;
      } else {
        offset = proto.skipField(data, offset, k.wireType);
      }
    }
    return { data: chunkData, endBody: endBody };
  }

  /* Reset */

  function encodeReset(reset) {
    var parts = [];
    var code = coerceResetCode(reset.code || 0);
    if (code !== ResetCode.CODE_UNSPECIFIED) parts.push(proto.int32Field(1, code));
    if (reset.reason) parts.push(proto.stringField(2, reset.reason));
    return util.concatBytes.apply(null, parts);
  }

  function decodeReset(data) {
    var code = ResetCode.CODE_UNSPECIFIED, reason = '';
    var offset = 0, k, r;
    while (offset < data.length) {
      k = proto.readKey(data, offset); offset = k.offset;
      if (k.fieldNumber === 1) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('Reset.code wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset; code = coerceResetCode(proto.decodeInt32(r.value));
      } else if (k.fieldNumber === 2) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('Reset.reason wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; reason = decodeString(r.bytes);
      } else {
        offset = proto.skipField(data, offset, k.wireType);
      }
    }
    return { code: code, reason: reason };
  }

  /* ServiceFrame {stream_id, kind, value} */

  function encodeServiceFrame(frame) {
    var parts = [];
    if (frame.streamId !== 0) parts.push(proto.int64Field(1, frame.streamId));
    if (frame.kind === null || frame.kind === undefined) {
      if (frame.value !== null && frame.value !== undefined) {
        throw proto.ProtoError('ServiceFrame value provided without kind');
      }
      return util.concatBytes.apply(null, parts);
    }
    if (frame.kind === 'request') parts.push(proto.delimitedField(2, encodeApplicationRequest(frame.value)));
    else if (frame.kind === 'response') parts.push(proto.delimitedField(3, encodeApplicationResponse(frame.value)));
    else if (frame.kind === 'body_chunk') parts.push(proto.delimitedField(4, encodeBodyChunk(frame.value)));
    else if (frame.kind === 'reset') parts.push(proto.delimitedField(5, encodeReset(frame.value)));
    else throw proto.ProtoError('unknown ServiceFrame kind');
    return util.concatBytes.apply(null, parts);
  }

  function decodeServiceFrame(data) {
    var streamId = 0, kind = null, value = null;
    var offset = 0, k, r;
    while (offset < data.length) {
      k = proto.readKey(data, offset); offset = k.offset;
      if (k.fieldNumber === 1) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('ServiceFrame.stream_id wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset;
        streamId = Number(proto.decodeInt64(r.value));
      } else if (k.fieldNumber === 2) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ServiceFrame.request wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset;
        kind = 'request'; value = decodeApplicationRequest(r.bytes);
      } else if (k.fieldNumber === 3) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ServiceFrame.response wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset;
        kind = 'response'; value = decodeApplicationResponse(r.bytes);
      } else if (k.fieldNumber === 4) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ServiceFrame.body_chunk wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset;
        kind = 'body_chunk'; value = decodeBodyChunk(r.bytes);
      } else if (k.fieldNumber === 5) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ServiceFrame.reset wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset;
        kind = 'reset'; value = decodeReset(r.bytes);
      } else {
        offset = proto.skipField(data, offset, k.wireType);
      }
    }
    return { streamId: streamId, kind: kind, value: value };
  }

  /* ServiceRequest / ServiceResponse */

  function encodeServiceRequest(request) {
    var parts = [];
    var service = coerceServiceType(request.service || 0);
    if (service !== ServiceType.SERVICE_DAEMON) parts.push(proto.varintField(1, service));
    if (request.payload && request.payload.length) parts.push(proto.bytesField(2, request.payload));
    return util.concatBytes.apply(null, parts);
  }

  function decodeServiceRequest(data) {
    var service = ServiceType.SERVICE_DAEMON, payload = new Uint8Array(0);
    var offset = 0, k, r;
    while (offset < data.length) {
      k = proto.readKey(data, offset); offset = k.offset;
      if (k.fieldNumber === 1) {
        if (k.wireType !== proto.WIRE_VARINT) throw proto.ProtoError('ServiceRequest.service wrong wire type');
        r = proto.readVarint(data, offset); offset = r.offset; service = coerceServiceType(Number(r.value));
      } else if (k.fieldNumber === 2) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ServiceRequest.payload wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; payload = r.bytes;
      } else {
        offset = proto.skipField(data, offset, k.wireType);
      }
    }
    return { service: service, payload: payload };
  }

  function encodeServiceResponse(response) {
    if (!response.payload || !response.payload.length) return new Uint8Array(0);
    return proto.bytesField(1, response.payload);
  }

  function decodeServiceResponse(data) {
    var payload = new Uint8Array(0);
    var offset = 0, k, r;
    while (offset < data.length) {
      k = proto.readKey(data, offset); offset = k.offset;
      if (k.fieldNumber === 1) {
        if (k.wireType !== proto.WIRE_DELIMITED) throw proto.ProtoError('ServiceResponse.payload wrong wire type');
        r = proto.readDelimited(data, offset); offset = r.offset; payload = r.bytes;
      } else {
        offset = proto.skipField(data, offset, k.wireType);
      }
    }
    return { payload: payload };
  }

  MG.envelope = {
    ServiceType: ServiceType,
    ResetCode: ResetCode,
    encodeHeader: encodeHeader,
    decodeHeader: decodeHeader,
    encodeApplicationRequest: encodeApplicationRequest,
    decodeApplicationRequest: decodeApplicationRequest,
    encodeApplicationResponse: encodeApplicationResponse,
    decodeApplicationResponse: decodeApplicationResponse,
    encodeBodyChunk: encodeBodyChunk,
    decodeBodyChunk: decodeBodyChunk,
    encodeReset: encodeReset,
    decodeReset: decodeReset,
    encodeServiceFrame: encodeServiceFrame,
    decodeServiceFrame: decodeServiceFrame,
    encodeServiceRequest: encodeServiceRequest,
    decodeServiceRequest: decodeServiceRequest,
    encodeServiceResponse: encodeServiceResponse,
    decodeServiceResponse: decodeServiceResponse,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.envelope;
})(typeof globalThis !== 'undefined' ? globalThis : this);
