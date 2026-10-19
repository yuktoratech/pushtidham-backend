# Catalog image uploads

Admin Giving and Event uploads accept original JPG/JPEG (`image/jpeg`), PNG,
and WebP images up to **15 MiB (15,728,640 bytes)**, inclusive.
`PRODUCT_IMAGE_MAX_BYTES` defaults to `15728640` and cannot exceed that value.
Keep the frontend maximum aligned when configuring a lower backend limit.

Original size is enforced before processing. File signatures and full image
decoding are checked before storage. Sharp applies orientation, strips metadata,
and produces WebP at quality 85 with maximum dimensions of 1600 × 1600 without
upscaling. Pixel, dimension and processing-time safety limits still apply even
to files within the byte limit.

JPEG detection checks its SOI/marker signature rather than requiring a particular
JFIF/EXIF segment layout or end-of-file marker position. Sharp validates the
decoded format and rejects corrupt/truncated input with `IMAGE_DECODE_FAILED`.
Signature/MIME mismatches use `INVALID_IMAGE`; size and processing-safety errors
remain distinct. Browser preview failures do not determine upload validity.

Only optimized WebP is stored in R2. Admin authorization, random object keys and
managed-object cleanup remain required. Restart the backend after changing its
local environment configuration.
