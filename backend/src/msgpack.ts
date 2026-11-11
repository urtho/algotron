/**
 * Minimal msgpack decoder, enough for Algorand blocks.
 * Maps become plain objects, bin becomes Uint8Array, 64-bit integers become
 * numbers (rounds, counters and microAlgo amounts in a block fit in 2^53).
 */
export type Msg = null | boolean | number | string | Uint8Array | Msg[] | { [k: string]: Msg };

const text = new TextDecoder();

export function decode(buf: Uint8Array): Msg {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;

  const need = (n: number) => {
    if (p + n > buf.length) throw new Error('msgpack: truncated');
  };
  const str = (n: number) => {
    need(n);
    const s = text.decode(buf.subarray(p, p + n));
    p += n;
    return s;
  };
  const bin = (n: number) => {
    need(n);
    const b = buf.subarray(p, p + n);
    p += n;
    return b;
  };
  const arr = (n: number) => {
    const a: Msg[] = new Array(n);
    for (let i = 0; i < n; i++) a[i] = read();
    return a;
  };
  const map = (n: number) => {
    const o: { [k: string]: Msg } = {};
    for (let i = 0; i < n; i++) {
      const k = read();
      o[typeof k === 'string' ? k : String(k)] = read();
    }
    return o;
  };
  const u8 = () => {
    need(1);
    return view.getUint8(p++);
  };
  const u16 = () => {
    need(2);
    const v = view.getUint16(p);
    p += 2;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(p);
    p += 4;
    return v;
  };

  function read(): Msg {
    const b = u8();
    if (b <= 0x7f) return b;
    if (b <= 0x8f) return map(b & 0x0f);
    if (b <= 0x9f) return arr(b & 0x0f);
    if (b <= 0xbf) return str(b & 0x1f);
    if (b >= 0xe0) return b - 0x100;
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return bin(u8());
      case 0xc5:
        return bin(u16());
      case 0xc6:
        return bin(u32());
      case 0xca: {
        need(4);
        const v = view.getFloat32(p);
        p += 4;
        return v;
      }
      case 0xcb: {
        need(8);
        const v = view.getFloat64(p);
        p += 8;
        return v;
      }
      case 0xcc:
        return u8();
      case 0xcd:
        return u16();
      case 0xce:
        return u32();
      case 0xcf: {
        need(8);
        const v = view.getBigUint64(p);
        p += 8;
        return Number(v);
      }
      case 0xd0: {
        need(1);
        return view.getInt8(p++);
      }
      case 0xd1: {
        need(2);
        const v = view.getInt16(p);
        p += 2;
        return v;
      }
      case 0xd2: {
        need(4);
        const v = view.getInt32(p);
        p += 4;
        return v;
      }
      case 0xd3: {
        need(8);
        const v = view.getBigInt64(p);
        p += 8;
        return Number(v);
      }
      case 0xd9:
        return str(u8());
      case 0xda:
        return str(u16());
      case 0xdb:
        return str(u32());
      case 0xdc:
        return arr(u16());
      case 0xdd:
        return arr(u32());
      case 0xde:
        return map(u16());
      case 0xdf:
        return map(u32());
      default:
        throw new Error(`msgpack: unsupported type 0x${b.toString(16)}`);
    }
  }

  return read();
}
