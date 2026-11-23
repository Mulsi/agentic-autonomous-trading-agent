import { crc32, deflateRawSync } from 'node:zlib';

// A test-only zip writer. It builds archives in memory from committed CSV
// text, with switches for every fault the reader must reject. Nothing is
// downloaded and nothing is written to disk.

export interface EntrySpec {
  readonly name: string;
  readonly data: Uint8Array;
  /** 0 stored, 8 deflate (default), anything else written as given. */
  readonly method?: number;
  /** General-purpose flags in both headers. */
  readonly flags?: number;
  /** A different name in the local header only. */
  readonly localName?: string;
  /** Overrides the declared CRC-32. */
  readonly crc?: number;
  /** Overrides the declared uncompressed size. */
  readonly size?: number;
  /** Overrides the compressed bytes. */
  readonly compressed?: Uint8Array;
  readonly externalAttributes?: number;
  /** Sets flag bit 3, zeroes the local CRC and sizes, and appends a descriptor. */
  readonly dataDescriptor?: boolean;
  /** Adds a ZIP64 extended-information extra field to the central header. */
  readonly zip64Extra?: boolean;
  /** Writes 0xffffffff as the central compressed size. */
  readonly zip64Sizes?: boolean;
}

export interface ArchiveSpec {
  readonly entries: readonly EntrySpec[];
  /** Overrides the entry count in the end record. */
  readonly endEntries?: number;
  /** Overrides the central directory offset in the end record. */
  readonly endCentralOffset?: number;
  /** Adds a ZIP64 end-of-central-directory locator before the end record. */
  readonly zip64Locator?: boolean;
  /** Writes the end record twice. */
  readonly duplicateEnd?: boolean;
}

const encoder = new TextEncoder();

class Bytes {
  private readonly parts: number[] = [];

  get length(): number {
    return this.parts.length;
  }

  u16(value: number): this {
    this.parts.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    this.u16(value & 0xffff).u16((value >>> 16) & 0xffff);
    return this;
  }

  bytes(data: Uint8Array): this {
    for (const byte of data) this.parts.push(byte);
    return this;
  }

  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export function buildZip(spec: ArchiveSpec): Uint8Array {
  const out = new Bytes();
  const central = new Bytes();
  for (const entry of spec.entries) {
    const method = entry.method ?? 8;
    const compressed =
      entry.compressed ??
      (method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data);
    const crc = entry.crc ?? crc32(entry.data);
    const size = entry.size ?? entry.data.length;
    const flags = (entry.flags ?? 0) | (entry.dataDescriptor ? 1 << 3 : 0);
    const name = encoder.encode(entry.name);
    const localName = encoder.encode(entry.localName ?? entry.name);
    const offset = out.length;

    out
      .u32(0x04034b50)
      .u16(20)
      .u16(flags)
      .u16(method)
      .u16(0)
      .u16(0x5b21)
      .u32(entry.dataDescriptor ? 0 : crc)
      .u32(entry.dataDescriptor ? 0 : compressed.length)
      .u32(entry.dataDescriptor ? 0 : size)
      .u16(localName.length)
      .u16(0)
      .bytes(localName)
      .bytes(compressed);
    if (entry.dataDescriptor) {
      out.u32(0x08074b50).u32(crc).u32(compressed.length).u32(size);
    }

    const extra = new Bytes();
    if (entry.zip64Extra) {
      extra.u16(0x0001).u16(8).u32(size).u32(0);
    }
    const extraBytes = extra.done();
    central
      .u32(0x02014b50)
      .u16(0x031e)
      .u16(20)
      .u16(flags)
      .u16(method)
      .u16(0)
      .u16(0x5b21)
      .u32(crc)
      .u32(entry.zip64Sizes ? 0xffffffff : compressed.length)
      .u32(size)
      .u16(name.length)
      .u16(extraBytes.length)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(entry.externalAttributes ?? 0o100644 << 16)
      .u32(offset)
      .bytes(name)
      .bytes(extraBytes);
  }
  const centralOffset = out.length;
  const centralBytes = central.done();
  out.bytes(centralBytes);
  if (spec.zip64Locator) {
    out.u32(0x07064b50).u32(0).u32(0).u32(0).u32(1);
  }
  const count = spec.endEntries ?? spec.entries.length;
  const end = new Bytes()
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(count)
    .u16(count)
    .u32(centralBytes.length)
    .u32(spec.endCentralOffset ?? centralOffset)
    .u16(0)
    .done();
  if (spec.duplicateEnd) {
    // The first copy's comment length covers the second, so both are valid.
    const first = Uint8Array.from(end);
    first[20] = 22;
    out.bytes(first);
  }
  out.bytes(end);
  return out.done();
}

/** A one-entry deflate archive of `text` named `name`. */
export function zipOf(name: string, text: string | Uint8Array): Uint8Array {
  const data = typeof text === 'string' ? encoder.encode(text) : text;
  return buildZip({ entries: [{ name, data }] });
}
