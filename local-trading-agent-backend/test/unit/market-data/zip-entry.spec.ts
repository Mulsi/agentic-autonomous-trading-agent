import fc from 'fast-check';
import { deflateRawSync } from 'node:zlib';
import { readSingleEntry } from '../../../src/market-data/zip-entry.js';
import { listAppFiles, readAppFile } from '../../fixtures/repo.js';
import { readFixture } from '../../fixtures/market-data/bulk.js';
import {
  buildZip,
  zipOf,
  type ArchiveSpec,
  type EntrySpec,
} from '../../fixtures/market-data/zip-writer.js';

// S1b criteria 8 to 10. Archives are built in memory from the committed CSV.

const NAME = 'BTCUSDT-15m-2026-10-01.csv';
const CSV = new TextEncoder().encode(readFixture('btcusdt-15m-2026-10-01.csv'));
const MAX = 16 * 1024 * 1024;
const entry: EntrySpec = { name: NAME, data: CSV };

function read(zip: Uint8Array, max = MAX) {
  return readSingleEntry(zip, NAME, max);
}

describe('valid archives (criterion 8)', () => {
  it.each([
    ['deflate', { ...entry, method: 8 }],
    ['stored', { ...entry, method: 0 }],
    ['deflate with a data descriptor', { ...entry, dataDescriptor: true }],
    [
      'stored with a data descriptor',
      { ...entry, method: 0, dataDescriptor: true },
    ],
  ])('returns the exact bytes of a one-entry %s archive', (_, spec) => {
    const result = read(buildZip({ entries: [spec] }));

    expect(result).toEqual({ ok: true, bytes: CSV });
  });

  it('accepts an entry of exactly maxBytes', () => {
    expect(read(zipOf(NAME, CSV), CSV.length)).toEqual({
      ok: true,
      bytes: CSV,
    });
  });

  it('returns a copy, not a view of the archive', () => {
    const zip = buildZip({ entries: [{ ...entry, method: 0 }] });
    const result = read(zip);
    if (!result.ok) throw new Error(result.reason);

    expect(result.bytes.buffer).not.toBe(zip.buffer);
  });
});

describe('rejected archives (criterion 8)', () => {
  const bomb = new Uint8Array(1024 * 1024);
  const cases: [string, () => Uint8Array, number, string][] = [
    [
      'two entries',
      () => buildZip({ entries: [entry, { ...entry, name: 'other.csv' }] }),
      MAX,
      'entry_count',
    ],
    ['zero entries', () => buildZip({ entries: [] }), MAX, 'entry_count'],
    [
      'an end record that counts 2 for one entry',
      () => buildZip({ entries: [entry], endEntries: 2 }),
      MAX,
      'entry_count',
    ],
    [
      'the name ../BTCUSDT-15m-2026-10-01.csv',
      () => zipOf(`../${NAME}`, CSV),
      MAX,
      'wrong_name',
    ],
    [
      'the name /BTCUSDT-15m-2026-10-01.csv',
      () => zipOf(`/${NAME}`, CSV),
      MAX,
      'wrong_name',
    ],
    [
      'the name x/BTCUSDT-15m-2026-10-01.csv',
      () => zipOf(`x/${NAME}`, CSV),
      MAX,
      'wrong_name',
    ],
    [
      'the name BTCUSDT-15m-2026-10-01.csv\\0.txt',
      () => zipOf(`${NAME}\0.txt`, CSV),
      MAX,
      'wrong_name',
    ],
    [
      'the name C:\\BTCUSDT-15m-2026-10-01.csv',
      () => zipOf(`C:\\${NAME}`, CSV),
      MAX,
      'wrong_name',
    ],
    [
      'a different .csv name',
      () => zipOf('BTCUSDT-15m-2026-10-02.csv', CSV),
      MAX,
      'wrong_name',
    ],
    [
      'a local header name that differs from the central one',
      () => buildZip({ entries: [{ ...entry, localName: `../${NAME}` }] }),
      MAX,
      'local_header_mismatch',
    ],
    [
      'a directory entry (trailing slash)',
      () => zipOf(`${NAME}/`, new Uint8Array(0)),
      MAX,
      'directory_entry',
    ],
    [
      'a directory entry (attributes)',
      () =>
        buildZip({
          entries: [{ ...entry, externalAttributes: (0o040755 << 16) | 0x10 }],
        }),
      MAX,
      'directory_entry',
    ],
    [
      'the encryption flag',
      () => buildZip({ entries: [{ ...entry, flags: 1 }] }),
      MAX,
      'encrypted',
    ],
    [
      'method 12 (bzip2)',
      () => buildZip({ entries: [{ ...entry, method: 12 }] }),
      MAX,
      'unsupported_method',
    ],
    [
      'a ZIP64 extra field',
      () => buildZip({ entries: [{ ...entry, zip64Extra: true }] }),
      MAX,
      'zip64',
    ],
    [
      'a ZIP64 size marker',
      () => buildZip({ entries: [{ ...entry, zip64Sizes: true }] }),
      MAX,
      'zip64',
    ],
    [
      'a ZIP64 end locator',
      () => buildZip({ entries: [entry], zip64Locator: true }),
      MAX,
      'zip64',
    ],
    [
      'a declared size above maxBytes',
      () => zipOf(NAME, CSV),
      CSV.length - 1,
      'declared_too_large',
    ],
    [
      'a deflate stream that inflates past maxBytes (a zip bomb)',
      () =>
        buildZip({
          entries: [{ name: NAME, data: bomb, size: 100, crc: 0 }],
        }),
      4096,
      'inflated_too_large',
    ],
    [
      'a CRC mismatch',
      () => buildZip({ entries: [{ ...entry, crc: 0x12345678 }] }),
      MAX,
      'crc_mismatch',
    ],
    [
      'a declared size that differs from the inflated size',
      () => buildZip({ entries: [{ ...entry, size: CSV.length - 1 }] }),
      MAX,
      'size_mismatch',
    ],
    [
      'a stored entry whose sizes differ',
      () =>
        buildZip({ entries: [{ ...entry, method: 0, size: CSV.length + 1 }] }),
      MAX,
      'size_mismatch',
    ],
    [
      'a corrupt deflate stream',
      () =>
        buildZip({
          entries: [
            { ...entry, compressed: Uint8Array.from([0xff, 0xff, 0xff]) },
          ],
        }),
      MAX,
      'bad_deflate',
    ],
    [
      'a truncated buffer (the end record cut off)',
      () => zipOf(NAME, CSV).subarray(0, -10),
      MAX,
      'no_end_record',
    ],
    [
      'a buffer cut short inside the data',
      () => {
        const zip = zipOf(NAME, CSV);
        // Drop 20 bytes of compressed data, keep the directory and end record.
        return Uint8Array.from([...zip.subarray(0, 60), ...zip.subarray(80)]);
      },
      MAX,
      'out_of_bounds',
    ],
    [
      'an end record pointing outside the buffer',
      () => buildZip({ entries: [entry], endCentralOffset: 0x7fff0000 }),
      MAX,
      'out_of_bounds',
    ],
    [
      'two end records',
      () => buildZip({ entries: [entry], duplicateEnd: true }),
      MAX,
      'duplicate_end_record',
    ],
    ['0 bytes', () => new Uint8Array(0), MAX, 'empty'],
    ['bytes that are not a zip', () => CSV, MAX, 'no_end_record'],
  ];

  it.each(cases)('rejects %s', (_, build, max, reason) => {
    let result: ReturnType<typeof read> | undefined;
    expect(() => {
      result = read(build(), max);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, reason });
  });

  it('names each kind of fault with its own reason', () => {
    // Several cases share a reason only where they are the same fault (two
    // entries and zero entries are both a wrong entry count); 16 reasons in all.
    expect(new Set(cases.map(([, , , reason]) => reason)).size).toBe(16);
  });

  it('a deflate bomb really is large', () => {
    expect(deflateRawSync(bomb).length).toBeLessThan(4096);
  });
});

describe('never throws, never returns more than maxBytes (criterion 9)', () => {
  const valid = zipOf(NAME, CSV);

  it('arbitrary bytes', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 512 }),
        fc.integer({ min: 0, max: 4096 }),
        (bytes, max) => {
          const result = readSingleEntry(bytes, NAME, max);
          if (result.ok) expect(result.bytes.length).toBeLessThanOrEqual(max);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('valid archives with one byte flipped', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: valid.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        fc.integer({ min: 0, max: CSV.length + 16 }),
        (at, xor, max) => {
          const copy = Uint8Array.from(valid);
          copy[at] = (copy[at] as number) ^ xor;
          const result = readSingleEntry(copy, NAME, max);
          if (result.ok) {
            expect(result.bytes.length).toBeLessThanOrEqual(max);
            expect(result.bytes).toEqual(CSV);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('archives built from arbitrary specs', () => {
    const spec: fc.Arbitrary<ArchiveSpec> = fc.record({
      entries: fc.array(
        fc.record({
          name: fc.constantFrom(NAME, `../${NAME}`, 'x.csv'),
          data: fc.uint8Array({ maxLength: 64 }),
          method: fc.constantFrom(0, 8, 12),
          flags: fc.constantFrom(0, 1, 8),
          size: fc.option(fc.integer({ min: 0, max: 0xffffffff }), {
            nil: undefined,
          }),
        }),
        { maxLength: 2 },
      ),
    });
    fc.assert(
      fc.property(spec, fc.integer({ min: 0, max: 128 }), (archive, max) => {
        const result = readSingleEntry(buildZip(archive), NAME, max);
        if (result.ok) expect(result.bytes.length).toBeLessThanOrEqual(max);
      }),
      { numRuns: 500 },
    );
  });
});

describe('nothing touches disk (criterion 10)', () => {
  it('zip-entry.ts imports only node:zlib, node:buffer and relative modules', () => {
    const text = readAppFile('src/market-data/zip-entry.ts');
    const imports = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1] as string,
    );

    expect(imports.length).toBeGreaterThan(0);
    expect(
      imports.filter(
        (name) =>
          !['node:zlib', 'node:buffer'].includes(name) && !name.startsWith('.'),
      ),
    ).toEqual([]);
    expect(text).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });

  const files = [
    ...listAppFiles('src/market-data'),
    ...listAppFiles('src/shared'),
  ];

  it('scans the market-data and shared sources', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'src/market-data/zip-entry.ts',
        'src/market-data/bulk-loader.ts',
        'src/shared/bounded-fetch.ts',
      ]),
    );
  });

  it.each([
    'node:fs',
    "'fs'",
    'node:fs/promises',
    'writeFile',
    'createWriteStream',
    'mkdtemp',
    'extract',
  ])('no file names %s', (needle) => {
    expect(files.filter((path) => readAppFile(path).includes(needle))).toEqual(
      [],
    );
  });
});
