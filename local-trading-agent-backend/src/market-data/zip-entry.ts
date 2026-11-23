import { crc32, inflateRawSync } from 'node:zlib';

// Reads the one CSV entry of a bulk-data zip, in memory (S1b). The archive is
// untrusted data that already passed its CHECKSUM: every offset and length is
// checked against the buffer, and anything outside the narrow shape the loader
// expects is rejected. The entry comes back as bytes and is never written
// anywhere, so no name inside an archive ever becomes a path.

export type ZipRejectReason =
  | 'empty'
  | 'no_end_record'
  | 'duplicate_end_record'
  | 'multi_disk'
  | 'entry_count'
  | 'zip64'
  | 'out_of_bounds'
  | 'bad_central_header'
  | 'bad_local_header'
  | 'encrypted'
  | 'directory_entry'
  | 'wrong_name'
  | 'local_header_mismatch'
  | 'unsupported_method'
  | 'declared_too_large'
  | 'inflated_too_large'
  | 'bad_deflate'
  | 'size_mismatch'
  | 'crc_mismatch'
  | 'malformed';

export type ZipEntryResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: ZipRejectReason };

const END_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;

/** General-purpose flag bits. */
const FLAG_ENCRYPTED = 1 << 0;
const FLAG_STRONG_ENCRYPTION = 1 << 6;
const FLAG_ENCRYPTED_DIRECTORY = 1 << 13;
const FLAG_DATA_DESCRIPTOR = 1 << 3;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** The MS-DOS directory attribute in the external attributes. */
const DOS_DIRECTORY = 0x10;
/** The Unix file-type bits in the upper half of the external attributes. */
const UNIX_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY = 0o040000;

/** Thrown inside the reader only; `readSingleEntry` turns it into a result. */
class Reject extends Error {
  constructor(readonly reason: ZipRejectReason) {
    super(reason);
  }
}

function fail(reason: ZipRejectReason): never {
  throw new Reject(reason);
}

/** Little-endian reads that reject anything outside the buffer. */
class Reader {
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  inBounds(offset: number, length: number): boolean {
    return (
      Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset + length <= this.bytes.length
    );
  }

  u16(offset: number): number {
    if (!this.inBounds(offset, 2)) fail('out_of_bounds');
    return this.view.getUint16(offset, true);
  }

  u32(offset: number): number {
    if (!this.inBounds(offset, 4)) fail('out_of_bounds');
    return this.view.getUint32(offset, true);
  }

  slice(offset: number, length: number): Uint8Array {
    if (!this.inBounds(offset, length)) fail('out_of_bounds');
    return this.bytes.subarray(offset, offset + length);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** True when an extra field block holds a ZIP64 record. */
function hasZip64Extra(
  reader: Reader,
  offset: number,
  length: number,
): boolean {
  let at = offset;
  const end = offset + length;
  while (at + 4 <= end) {
    if (reader.u16(at) === ZIP64_EXTRA_ID) return true;
    at += 4 + reader.u16(at + 2);
  }
  return false;
}

/** The offset of the single end-of-central-directory record. */
function findEndRecord(reader: Reader): number {
  const { length } = reader.bytes;
  const lowest = Math.max(0, length - END_SIZE - MAX_COMMENT);
  const found: number[] = [];
  for (let at = length - END_SIZE; at >= lowest; at -= 1) {
    // A real record's comment runs exactly to the end of the buffer.
    if (
      reader.u32(at) === END_SIGNATURE &&
      at + END_SIZE + reader.u16(at + 20) === length
    ) {
      found.push(at);
    }
  }
  if (found.length === 0) fail('no_end_record');
  if (found.length > 1) fail('duplicate_end_record');
  return found[0] as number;
}

function read(
  zip: Uint8Array,
  expectedCsvName: string,
  maxBytes: number,
): Uint8Array {
  if (zip.length === 0) fail('empty');
  const reader = new Reader(zip);
  const end = findEndRecord(reader);

  if (
    end >= ZIP64_LOCATOR_SIZE &&
    reader.u32(end - ZIP64_LOCATOR_SIZE) === ZIP64_LOCATOR_SIGNATURE
  ) {
    fail('zip64');
  }
  const disk = reader.u16(end + 4);
  const centralDisk = reader.u16(end + 6);
  const entriesHere = reader.u16(end + 8);
  const entriesTotal = reader.u16(end + 10);
  const centralSize = reader.u32(end + 12);
  const centralOffset = reader.u32(end + 16);
  if (
    entriesHere === 0xffff ||
    entriesTotal === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    fail('zip64');
  }
  if (disk !== 0 || centralDisk !== 0) fail('multi_disk');
  if (entriesHere !== 1 || entriesTotal !== 1) fail('entry_count');
  if (centralOffset + centralSize > end) fail('out_of_bounds');

  // The one central directory header.
  const c = centralOffset;
  if (reader.u32(c) !== CENTRAL_SIGNATURE) fail('bad_central_header');
  const flags = reader.u16(c + 8);
  const method = reader.u16(c + 10);
  const crc = reader.u32(c + 16);
  const compressedSize = reader.u32(c + 20);
  const size = reader.u32(c + 24);
  const nameLength = reader.u16(c + 28);
  const extraLength = reader.u16(c + 30);
  const commentLength = reader.u16(c + 32);
  const startDisk = reader.u16(c + 34);
  const externalAttributes = reader.u32(c + 38);
  const localOffset = reader.u32(c + 42);
  if (CENTRAL_SIZE + nameLength + extraLength + commentLength !== centralSize) {
    fail('bad_central_header');
  }
  const name = reader.slice(c + CENTRAL_SIZE, nameLength);

  if (
    compressedSize === 0xffffffff ||
    size === 0xffffffff ||
    localOffset === 0xffffffff ||
    startDisk === 0xffff ||
    hasZip64Extra(reader, c + CENTRAL_SIZE + nameLength, extraLength)
  ) {
    fail('zip64');
  }
  if (startDisk !== 0) fail('multi_disk');
  if (
    (flags &
      (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_ENCRYPTED_DIRECTORY)) !==
    0
  ) {
    fail('encrypted');
  }
  if (
    (nameLength > 0 && name[nameLength - 1] === 0x2f) ||
    (externalAttributes & DOS_DIRECTORY) !== 0 ||
    ((externalAttributes >>> 16) & UNIX_TYPE_MASK) === UNIX_DIRECTORY
  ) {
    fail('directory_entry');
  }
  // The only name accepted is the one the loader computed. A path, `..`, a
  // drive letter or a NUL can never equal it.
  if (!sameBytes(name, new TextEncoder().encode(expectedCsvName))) {
    fail('wrong_name');
  }
  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
    fail('unsupported_method');
  }
  if (size > maxBytes) fail('declared_too_large');

  // The local header must agree with the central one.
  const l = localOffset;
  if (reader.u32(l) !== LOCAL_SIGNATURE) fail('bad_local_header');
  const localFlags = reader.u16(l + 6);
  const localMethod = reader.u16(l + 8);
  const localNameLength = reader.u16(l + 26);
  const localExtraLength = reader.u16(l + 28);
  const localName = reader.slice(l + LOCAL_SIZE, localNameLength);
  if (!sameBytes(localName, name) || localMethod !== method) {
    fail('local_header_mismatch');
  }
  if (
    (localFlags &
      (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_ENCRYPTED_DIRECTORY)) !==
    0
  ) {
    fail('encrypted');
  }
  if ((localFlags & FLAG_DATA_DESCRIPTOR) === 0) {
    // Without a data descriptor the local header carries the real values.
    if (
      reader.u32(l + 14) !== crc ||
      reader.u32(l + 18) !== compressedSize ||
      reader.u32(l + 22) !== size
    ) {
      fail('local_header_mismatch');
    }
  }
  if (
    hasZip64Extra(reader, l + LOCAL_SIZE + localNameLength, localExtraLength)
  ) {
    fail('zip64');
  }
  const dataOffset = l + LOCAL_SIZE + localNameLength + localExtraLength;
  if (dataOffset + compressedSize > centralOffset) fail('out_of_bounds');
  const data = reader.slice(dataOffset, compressedSize);

  let bytes: Uint8Array;
  if (method === METHOD_STORED) {
    bytes = data;
  } else {
    try {
      bytes = inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) });
    } catch (error) {
      fail(
        error instanceof RangeError ||
          (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
          ? 'inflated_too_large'
          : 'bad_deflate',
      );
    }
  }
  if (bytes.length > maxBytes) fail('inflated_too_large');
  if (bytes.length !== size) fail('size_mismatch');
  if (crc32(bytes) !== crc) fail('crc_mismatch');
  // A copy, so the result never aliases the downloaded archive.
  return Uint8Array.from(bytes);
}

/**
 * The bytes of the single entry named `expectedCsvName`, at most `maxBytes`
 * long, or the reason the archive is rejected. Never throws on archive content.
 */
export function readSingleEntry(
  zip: Uint8Array,
  expectedCsvName: string,
  maxBytes: number,
): ZipEntryResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a safe integer >= 0');
  }
  try {
    return { ok: true, bytes: read(zip, expectedCsvName, maxBytes) };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, reason: error.reason };
    // Anything unforeseen in the content is a rejection, never a crash.
    return { ok: false, reason: 'malformed' };
  }
}
