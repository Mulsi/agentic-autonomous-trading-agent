// A fast-check generator of DATABASE_URL candidates for the boot-availability
// property (S0c review). Most random strings fail `parseSettings`, so it builds
// URL-shaped strings from parts, mixes in near-misses and fully random strings,
// and tags each value with the shapes it was built from. The shapes are set from
// the parts, never read back from the string.
import fc from 'fast-check';

export type UrlShape =
  | 'scheme postgres'
  | 'scheme postgresql'
  | 'upper-case scheme'
  | 'edge ASCII whitespace or C0 control'
  | 'edge U+00A0 or U+FEFF'
  | 'edge other Unicode space'
  | 'edge mixed'
  | 'tab, LF or CR inside'
  | 'percent-encoded password'
  | 'invalid percent sequence in password'
  | 'raw @ in password'
  | 'non-ASCII password'
  | 'bracketed IPv6 host'
  | 'non-ASCII host'
  | 'explicit port'
  | 'port out of range'
  | 'unclosed IPv6 bracket'
  | 'space in host'
  | 'near miss'
  | 'random';

/** The three shapes in `UNPARSEABLE_DATABASE_URLS` (test/fixtures/env.ts). */
export const UNPARSEABLE_SHAPES: readonly UrlShape[] = [
  'port out of range',
  'unclosed IPv6 bracket',
  'space in host',
];

export interface GeneratedUrl {
  value: string;
  shapes: readonly UrlShape[];
}

interface Part {
  text: string;
  shapes: readonly UrlShape[];
}

function part(text: string, ...shapes: UrlShape[]): Part {
  return { text, shapes };
}

function join(parts: readonly Part[]): Part {
  return {
    text: parts.map(({ text }) => text).join(''),
    shapes: [...new Set(parts.flatMap(({ shapes }) => shapes))],
  };
}

const chars = (text: string): string[] => [...text];

const ALNUM = chars(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
);
// ASCII punctuation, except `@` (its own piece) and `/`, `?` and `#`, which end
// the authority (the near-misses put those in a password).
const PUNCTUATION = chars('!"$%&\'()*+,-.:;<=>[\\]^_`{|}~');
// Edge characters. The WHATWG parser strips C0 controls and space at the
// edges. JavaScript's `trim`, which zod applies first, strips ASCII whitespace
// and Unicode spaces such as U+00A0 and U+FEFF, but not the other C0 controls.
const C0_AND_SPACE = Array.from({ length: 0x21 }, (_, code) =>
  String.fromCharCode(code),
);
const NBSP_AND_BOM = ['\u00a0', '\ufeff'];
const OTHER_UNICODE_SPACES = chars(
  '\u1680\u2000\u2009\u200a\u2028\u2029\u202f\u205f\u3000',
);
// Trimmed by neither: DEL, NEL, zero-width space, Mongolian vowel separator.
const TRIMMED_BY_NEITHER = chars('\u007f\u0085\u200b\u180e');

/** One non-ASCII code point, lone surrogates included. */
const nonAsciiCodePoint = fc
  .integer({ min: 0x80, max: 0x10ffff })
  .map((code) => String.fromCodePoint(code));

const nonAscii = fc.oneof(
  fc.constantFrom('ü', 'é', 'ß', '日本', 'пароль', '🙂', '\ud800', '\udfff'),
  fc.string({ unit: nonAsciiCodePoint, minLength: 1, maxLength: 4 }),
);

const scheme: fc.Arbitrary<Part> = fc
  .constantFrom(
    'postgres',
    'postgresql',
    'POSTGRES',
    'POSTGRESQL',
    'Postgres',
    'PostgreSQL',
  )
  .map((text) => {
    const lower = text.toLowerCase();
    const shapes: UrlShape[] = [
      lower === 'postgres' ? 'scheme postgres' : 'scheme postgresql',
    ];
    if (text !== lower) shapes.push('upper-case scheme');
    return part(text, ...shapes);
  });

const user = fc.string({
  unit: fc.constantFrom(...ALNUM, ...chars("-._~!$&'()*+,;=")),
  maxLength: 10,
});

const hexByte = fc
  .tuple(fc.integer({ min: 0, max: 255 }), fc.boolean())
  .map(([byte, upper]) => {
    const hex = byte.toString(16).padStart(2, '0');
    return `%${upper ? hex.toUpperCase() : hex}`;
  });

const passwordPiece: fc.Arbitrary<Part> = fc.oneof(
  fc
    .string({ unit: fc.constantFrom(...ALNUM), minLength: 1, maxLength: 8 })
    .map((text) => part(text)),
  fc.constantFrom(...PUNCTUATION, ' ').map((text) => part(text)),
  fc.constant(part('@', 'raw @ in password')),
  fc
    .constantFrom('\t', '\n', '\r')
    .map((text) => part(text, 'tab, LF or CR inside')),
  hexByte.map((text) => part(text, 'percent-encoded password')),
  // Multi-byte UTF-8, and bytes that do not decode as UTF-8.
  fc
    .constantFrom('%C3%BC', '%e2%82%ac', '%F0%9F%99%82', '%C3', '%FF')
    .map((text) => part(text, 'percent-encoded password')),
  // A non-hex character right after `%`, whatever comes next.
  fc
    .constantFrom('%zz', '%G1', '%z', '%-1', '%%')
    .map((text) => part(text, 'invalid percent sequence in password')),
  nonAscii.map((text) => part(text, 'non-ASCII password')),
);

const password = fc.array(passwordPiece, { maxLength: 6 }).map(join);

/** Empty, `user@` or `user:password@`. */
const userinfo: fc.Arbitrary<Part> = fc.oneof(
  { arbitrary: fc.constant(part('')), weight: 1 },
  { arbitrary: user.map((name) => part(`${name}@`)), weight: 1 },
  {
    arbitrary: fc
      .tuple(user, password)
      .map(([name, pw]) => join([part(`${name}:`), pw, part('@')])),
    weight: 6,
  },
);

const host: fc.Arbitrary<Part> = fc.oneof(
  fc.constantFrom('localhost', '127.0.0.1', 'db').map((text) => part(text)),
  fc.domain().map((text) => part(text)),
  fc.ipV4().map((text) => part(text)),
  fc.ipV6().map((ip) => part(`[${ip}]`, 'bracketed IPv6 host')),
  fc
    .tuple(
      fc.string({ unit: nonAsciiCodePoint, minLength: 1, maxLength: 4 }),
      fc.domain(),
    )
    .map(([label, domain]) => part(`${label}.${domain}`, 'non-ASCII host')),
  fc
    .constantFrom('münchen.de', 'bücher.example', '日本.jp', 'пример.рф')
    .map((text) => part(text, 'non-ASCII host')),
);

const port: fc.Arbitrary<Part> = fc.oneof(
  { arbitrary: fc.constant(part('')), weight: 3 },
  {
    arbitrary: fc
      .integer({ min: 0, max: 65535 })
      .map((n) => part(`:${n}`, 'explicit port')),
    weight: 2,
  },
  { arbitrary: fc.constant(part(':')), weight: 1 },
);

/** Path, query string and fragment, each optional. */
const tail: fc.Arbitrary<Part> = fc
  .tuple(
    fc.oneof(
      fc.constantFrom('', '/', '/trader'),
      fc.string({ unit: 'grapheme', maxLength: 12 }).map((s) => `/${s}`),
    ),
    fc.option(
      fc.string({ unit: 'grapheme-ascii', maxLength: 12 }).map((s) => `?${s}`),
      { freq: 2, nil: '' },
    ),
    fc.option(
      fc.string({ unit: 'grapheme', maxLength: 8 }).map((s) => `#${s}`),
      { freq: 2, nil: '' },
    ),
  )
  .map(([path, query, fragment]) => part(path + query + fragment));

const wellFormed: fc.Arbitrary<Part> = fc
  .tuple(
    scheme,
    userinfo,
    host,
    port,
    tail,
    // A tab, LF or CR inside the scheme or right after `://`, where neither
    // trim can reach it.
    fc.oneof(
      { arbitrary: fc.constant(undefined), weight: 3 },
      {
        arbitrary: fc.tuple(fc.constantFrom('\t', '\n', '\r'), fc.nat()),
        weight: 1,
      },
    ),
  )
  .map(([s, u, h, p, t, inner]) => {
    const built = join([s, part('://'), u, h, p, t]);
    if (inner === undefined) return built;
    const [character, n] = inner;
    const at = 1 + (n % (s.text.length + 3));
    return join([
      part(built.text.slice(0, at) + character + built.text.slice(at)),
      part('', ...built.shapes, 'tab, LF or CR inside'),
    ]);
  });

const nearMissScheme = fc.constantFrom(
  'postgre',
  'postgresqll',
  'pg',
  'mysql',
  'http',
  'jdbc:postgresql',
  'p0stgres',
  'postgres+ssl',
);

const nearMiss: fc.Arbitrary<Part> = fc
  .oneof(
    // The three shapes in UNPARSEABLE_DATABASE_URLS.
    fc
      .tuple(
        scheme,
        userinfo,
        host,
        fc.integer({ min: 65536, max: 2 ** 32 }),
        tail,
      )
      .map(([s, u, h, n, t]) =>
        join([s, part('://'), u, h, part(`:${n}`, 'port out of range'), t]),
      ),
    fc
      .tuple(scheme, userinfo, fc.ipV6(), tail)
      .map(([s, u, ip, t]) =>
        join([s, part('://'), u, part(`[${ip}`, 'unclosed IPv6 bracket'), t]),
      ),
    fc
      .tuple(scheme, userinfo, fc.domain(), fc.domain(), port, tail)
      .map(([s, u, a, b, p, t]) =>
        join([s, part('://'), u, part(`${a} ${b}`, 'space in host'), p, t]),
      ),
    // A scheme that is not postgres or postgresql.
    fc
      .tuple(nearMissScheme, userinfo, host, port, tail)
      .map(([s, u, h, p, t]) => join([part(`${s}://`), u, h, p, t])),
    // Missing, extra or wrong slashes after the scheme.
    fc
      .tuple(
        scheme,
        fc.constantFrom(':', ':/', ':///', ':\\\\'),
        userinfo,
        host,
        port,
        tail,
      )
      .map(([s, slashes, u, h, p, t]) => join([s, part(slashes), u, h, p, t])),
    // `/`, `?` or `#` in the password ends the authority early.
    fc
      .tuple(
        scheme,
        user,
        password,
        fc.constantFrom('/', '?', '#'),
        password,
        host,
        port,
        tail,
      )
      .map(([s, name, a, cut, b, h, p, t]) =>
        join([s, part(`://${name}:`), a, part(cut), b, part('@'), h, p, t]),
      ),
    // No host.
    fc
      .tuple(scheme, userinfo, port, tail)
      .map(([s, u, p, t]) => join([s, part('://'), u, p, t])),
    // A forbidden host code point, or a bad IPv6 literal.
    fc
      .tuple(
        scheme,
        userinfo,
        fc.domain(),
        fc.constantFrom('<', '>', '^', '|', '\\', '\u0000', '[', ']'),
        port,
        tail,
      )
      .map(([s, u, h, bad, p, t]) =>
        join([s, part('://'), u, part(h + bad), p, t]),
      ),
    fc
      .tuple(
        scheme,
        userinfo,
        fc.constantFrom('[::g]', '[1:2:3]', '[::1]x', '[]'),
        tail,
      )
      .map(([s, u, h, t]) => join([s, part('://'), u, part(h), t])),
    // The right scheme, then anything.
    fc
      .string({ unit: 'binary', maxLength: 30 })
      .map((rest) => part(`postgresql://${rest}`)),
  )
  // A near-miss can still parse, with the parts split differently, so it keeps
  // only the labels that name the miss itself.
  .map((built) =>
    part(
      built.text,
      'near miss',
      ...built.shapes.filter((shape) => UNPARSEABLE_SHAPES.includes(shape)),
    ),
  );

const random: fc.Arbitrary<Part> = fc
  .oneof(
    fc.string({ unit: 'binary', maxLength: 60 }),
    fc.string({ unit: 'grapheme-ascii', maxLength: 60 }),
    fc.string({
      unit: fc.constantFrom(...chars('postgresql:/@[]%. ')),
      maxLength: 40,
    }),
  )
  .map((text) => part(text, 'random'));

const run = (pool: readonly string[]): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...pool), { minLength: 1, maxLength: 3 })
    .map((picked) => picked.join(''));

/** Leading or trailing padding. */
const edge: fc.Arbitrary<Part> = fc.oneof(
  { arbitrary: fc.constant(part('')), weight: 4 },
  {
    arbitrary: run(C0_AND_SPACE).map((text) =>
      part(text, 'edge ASCII whitespace or C0 control'),
    ),
    weight: 2,
  },
  {
    arbitrary: run([...NBSP_AND_BOM, ...OTHER_UNICODE_SPACES]).map((text) =>
      [...text].some((c) => NBSP_AND_BOM.includes(c))
        ? part(text, 'edge U+00A0 or U+FEFF')
        : part(text, 'edge other Unicode space'),
    ),
    weight: 2,
  },
  {
    arbitrary: run([
      ...C0_AND_SPACE,
      ...NBSP_AND_BOM,
      ...OTHER_UNICODE_SPACES,
      ...TRIMMED_BY_NEITHER,
    ]).map((text) => part(text, 'edge mixed')),
    weight: 1,
  },
);

/** Every generated value, tagged with the shapes it was built from. */
export const databaseUrls: fc.Arbitrary<GeneratedUrl> = fc
  .tuple(
    edge,
    fc.oneof(
      { arbitrary: wellFormed, weight: 12 },
      { arbitrary: nearMiss, weight: 6 },
      { arbitrary: random, weight: 2 },
    ),
    edge,
  )
  .map((parts) => {
    const { text, shapes } = join(parts);
    return { value: text, shapes };
  });
