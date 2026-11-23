import {
  boundedGet,
  type BoundedGetLimits,
  type BoundedGetResult,
} from '../shared/bounded-fetch.js';
import { BINANCE_VISION_ORIGIN } from './binance-vision.js';

/** The loader's only way out to the network. Tests pass a fake. */
export interface HttpGet {
  get(url: string, limits: BoundedGetLimits): Promise<BoundedGetResult>;
}

/** Every URL the loader may request starts with this. */
export const SPOT_DATA_PREFIX = `${BINANCE_VISION_ORIGIN}/data/spot/`;

/** After the prefix: plain path segments only, no `..`, query or escape. */
const PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

/** True for a URL under the spot bulk-data path, with no traversal. */
export function isSpotDataUrl(url: string): boolean {
  if (!url.startsWith(SPOT_DATA_PREFIX)) return false;
  const path = url.slice(SPOT_DATA_PREFIX.length);
  return PATH.test(path) && !path.split('/').some((part) => /^\.+$/.test(part));
}

/**
 * The production `HttpGet`: `boundedGet`, for spot bulk-data URLs only. Any
 * other URL is a programmer error and throws before `fetch` is called.
 */
export function visionHttpGet(get: typeof boundedGet = boundedGet): HttpGet {
  return {
    get(url, limits) {
      if (!isSpotDataUrl(url)) {
        return Promise.reject(
          new RangeError('url is outside the spot bulk-data path'),
        );
      }
      return get(url, limits);
    },
  };
}
