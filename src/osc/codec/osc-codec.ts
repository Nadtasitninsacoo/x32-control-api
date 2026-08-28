import {
  OSC_TIMETAG_IMMEDIATE,
  OscArg,
  OscBundle,
  OscDecodeError,
  OscEncodeError,
  OscMessage,
  OscPacket,
  isBundle,
} from './osc-types.js';

const BUNDLE_PREFIX = '#bundle';

/** OSC pads every element up to the next multiple of 4 bytes. */
function padded(byteLength: number): number {
  return (byteLength + 3) & ~3;
}

/**
 * OSC-string: the UTF-8 bytes, at least one terminating NUL, then NUL padding
 * up to a 4-byte boundary. A 4-character string therefore occupies 8 bytes.
 */
function encodeString(value: string): Buffer {
  const raw = Buffer.from(value, 'utf8');
  if (raw.includes(0)) {
    throw new OscEncodeError(
      `OSC string must not contain NUL bytes: ${JSON.stringify(value)}`,
    );
  }
  const buf = Buffer.alloc(padded(raw.length + 1));
  raw.copy(buf);
  return buf;
}

/** OSC-blob: int32 byte count, the bytes, then NUL padding to a 4-byte boundary. */
function encodeBlob(value: Buffer): Buffer {
  const buf = Buffer.alloc(4 + padded(value.length));
  buf.writeInt32BE(value.length, 0);
  value.copy(buf, 4);
  return buf;
}

function encodeArg(arg: OscArg): Buffer {
  switch (arg.type) {
    case 'i': {
      if (!Number.isInteger(arg.value)) {
        throw new OscEncodeError(
          `int32 argument is not an integer: ${arg.value}`,
        );
      }
      if (arg.value < -0x80000000 || arg.value > 0x7fffffff) {
        throw new OscEncodeError(`int32 argument out of range: ${arg.value}`);
      }
      const buf = Buffer.alloc(4);
      buf.writeInt32BE(arg.value, 0);
      return buf;
    }
    case 'f': {
      if (!Number.isFinite(arg.value)) {
        throw new OscEncodeError(
          `float32 argument is not finite: ${arg.value}`,
        );
      }
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(arg.value, 0);
      return buf;
    }
    case 's':
      return encodeString(arg.value);
    case 'b':
      return encodeBlob(arg.value);
  }
}

/**
 * Addresses we *send* must be well formed. Replies we *receive* need not be:
 * the X32 answers a `/node` query on the bare address `node`, so the decoder
 * stays permissive and this guard is applied by the transport instead.
 */
export function assertOutboundAddress(address: string): void {
  if (!address.startsWith('/')) {
    throw new OscEncodeError(
      `outbound OSC address must start with "/": "${address}"`,
    );
  }
}

export function encodeMessage(message: OscMessage): Buffer {
  if (message.address.length === 0 || /\s/.test(message.address)) {
    throw new OscEncodeError(
      `invalid OSC address: ${JSON.stringify(message.address)}`,
    );
  }
  const typeTags = `,${message.args.map((a) => a.type).join('')}`;
  return Buffer.concat([
    encodeString(message.address),
    encodeString(typeTags),
    ...message.args.map(encodeArg),
  ]);
}

export function encodeBundle(bundle: OscBundle): Buffer {
  const header = Buffer.alloc(16);
  encodeString(BUNDLE_PREFIX).copy(header, 0);
  header.writeBigUInt64BE(bundle.timetag, 8);
  const elements = bundle.packets.map((packet) => {
    const body = encodePacket(packet);
    const size = Buffer.alloc(4);
    size.writeInt32BE(body.length, 0);
    return Buffer.concat([size, body]);
  });
  return Buffer.concat([header, ...elements]);
}

export function encodePacket(packet: OscPacket): Buffer {
  return isBundle(packet) ? encodeBundle(packet) : encodeMessage(packet);
}

/** Cursor over a datagram; every read validates its own bounds. */
class Reader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  readString(): string {
    const end = this.buf.indexOf(0, this.offset);
    if (end === -1) {
      throw new OscDecodeError('unterminated OSC string');
    }
    const value = this.buf.toString('utf8', this.offset, end);
    this.offset += padded(end - this.offset + 1);
    if (this.offset > this.buf.length) {
      throw new OscDecodeError('OSC string padding runs past end of packet');
    }
    return value;
  }

  readInt32(): number {
    this.require(4, 'int32');
    const value = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt64(): bigint {
    this.require(8, 'timetag');
    const value = this.buf.readBigUInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  readFloat32(): number {
    this.require(4, 'float32');
    const value = this.buf.readFloatBE(this.offset);
    this.offset += 4;
    return value;
  }

  readBlob(): Buffer {
    const size = this.readInt32();
    if (size < 0) {
      throw new OscDecodeError(`negative blob size: ${size}`);
    }
    this.require(padded(size), 'blob');
    // Copy: dgram reuses its receive buffer between packets.
    const value = Buffer.from(
      this.buf.subarray(this.offset, this.offset + size),
    );
    this.offset += padded(size);
    return value;
  }

  readSlice(size: number): Buffer {
    this.require(size, 'bundle element');
    const value = this.buf.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  private require(bytes: number, what: string): void {
    if (this.remaining < bytes) {
      throw new OscDecodeError(
        `truncated packet: need ${bytes} more bytes for ${what}`,
      );
    }
  }
}

function decodeArgs(reader: Reader, typeTags: string): OscArg[] {
  const args: OscArg[] = [];
  for (const tag of typeTags) {
    switch (tag) {
      case 'i':
        args.push({ type: 'i', value: reader.readInt32() });
        break;
      case 'f':
        args.push({ type: 'f', value: reader.readFloat32() });
        break;
      case 's':
      case 'S':
        args.push({ type: 's', value: reader.readString() });
        break;
      case 'b':
        args.push({ type: 'b', value: reader.readBlob() });
        break;
      default:
        throw new OscDecodeError(`unsupported OSC type tag: "${tag}"`);
    }
  }
  return args;
}

function decodeMessageFrom(reader: Reader, address: string): OscMessage {
  // A message with no type-tag string is legal in OSC 1.0 and means "no
  // arguments"; the X32 uses exactly this form to *query* a parameter.
  if (reader.remaining === 0) {
    return { address, args: [] };
  }
  const typeTags = reader.readString();
  if (!typeTags.startsWith(',')) {
    throw new OscDecodeError(
      `type tag string must start with ",": "${typeTags}"`,
    );
  }
  return { address, args: decodeArgs(reader, typeTags.slice(1)) };
}

function decodeBundleFrom(reader: Reader): OscBundle {
  const timetag = reader.readUInt64();
  const packets: OscPacket[] = [];
  while (reader.remaining > 0) {
    const size = reader.readInt32();
    if (size < 0 || size % 4 !== 0) {
      throw new OscDecodeError(`invalid bundle element size: ${size}`);
    }
    packets.push(decodePacket(reader.readSlice(size)));
  }
  return { timetag, packets };
}

export function decodePacket(buf: Buffer): OscPacket {
  if (buf.length % 4 !== 0) {
    throw new OscDecodeError(
      `OSC packet length must be a multiple of 4, got ${buf.length}`,
    );
  }
  const reader = new Reader(buf);
  const head = reader.readString();
  if (head === BUNDLE_PREFIX) {
    return decodeBundleFrom(reader);
  }
  if (head.length === 0) {
    throw new OscDecodeError('empty OSC address');
  }
  // No leading-slash check: the X32 replies to /node on the address "node".
  return decodeMessageFrom(reader, head);
}

/**
 * Decode a datagram into the flat list of messages it carries, discarding
 * bundle nesting — consumers of the X32 feed only care about the messages.
 */
export function decodeMessages(buf: Buffer): OscMessage[] {
  const out: OscMessage[] = [];
  const walk = (p: OscPacket): void => {
    if (isBundle(p)) {
      p.packets.forEach(walk);
    } else {
      out.push(p);
    }
  };
  walk(decodePacket(buf));
  return out;
}

export function message(address: string, ...args: OscArg[]): OscMessage {
  return { address, args };
}

export function bundle(
  packets: OscPacket[],
  timetag = OSC_TIMETAG_IMMEDIATE,
): OscBundle {
  return { timetag, packets };
}

/** Human-readable form used by the audit log and DRY_RUN output. */
export function formatMessage(msg: OscMessage): string {
  if (msg.args.length === 0) return msg.address;
  const tags = msg.args.map((a) => a.type).join('');
  const args = msg.args
    .map((a) =>
      a.type === 'b' ? `<blob ${a.value.length}B>` : JSON.stringify(a.value),
    )
    .join(' ');
  return `${msg.address} ,${tags} ${args}`;
}
