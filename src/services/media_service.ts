import { v2 as cloudinary } from 'cloudinary';

import { env } from '@/config/env';
import { BadRequestError, UpstreamError } from '@/lib/errors';

/**
 * Cloudinary. Two things are stored per image: `secure_url` for rendering and
 * `public_id`, which is the only handle that makes deletion possible later.
 *
 * Sizes are not stored. A transformed URL is requested at render time
 * (`w_600,f_auto,q_auto`), so one upload serves every viewport (FR-MENU-6).
 */

const MENU_FOLDER = 'popnsip/menu';

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

let configured = false;

/** Credentials are optional in development, so this is checked at use, not boot. */
function ensureConfigured(): void {
  if (configured) return;

  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new UpstreamError(
      'cloudinary',
      'Image uploads are not configured on this server.',
      { missing: 'CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET' },
    );
  }

  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

export const isMediaConfigured = (): boolean =>
  Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

export type UploadedImage = { url: string; publicId: string };

export async function uploadMenuImage(file: {
  buffer: Buffer;
  mimetype: string;
  size: number;
}): Promise<UploadedImage> {
  // Validate before reaching for credentials: a bad file is the uploader's
  // problem and should say so, whether or not Cloudinary is configured.
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.mimetype)) {
    throw new BadRequestError('Upload a JPEG, PNG, WebP or AVIF image.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new BadRequestError('Images must be 8MB or smaller.');
  }

  ensureConfigured();

  return new Promise<UploadedImage>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: MENU_FOLDER,
        resource_type: 'image',
        // One canonical stored rendition; per-viewport sizes are URL transforms.
        transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto' }],
      },
      (error, result) => {
        if (error || !result) {
          reject(new UpstreamError('cloudinary', 'The image could not be uploaded.', undefined, { cause: error }));
          return;
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );

    stream.end(file.buffer);
  });
}

/** Best-effort: a failed delete leaves an orphaned asset, not a broken menu. */
export async function deleteMenuImage(publicId: string): Promise<void> {
  ensureConfigured();
  await cloudinary.uploader.destroy(publicId);
}

/**
 * Build a transformed delivery URL from a stored `secure_url`. `f_auto` picks
 * the format the browser supports, `q_auto` the quality — which is most of
 * FR-MENU-6 for free, on a connection where it matters.
 */
export function transformedUrl(url: string, width: number): string {
  const marker = '/upload/';
  const index = url.indexOf(marker);
  if (index === -1) return url;

  return `${url.slice(0, index + marker.length)}w_${width},f_auto,q_auto/${url.slice(index + marker.length)}`;
}
