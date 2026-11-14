# Synthetic image fixtures

These 2 × 3 solid-red PNG, JPEG, GIF and WebP files were generated locally with ImageMagick (`magick -size 2x3 xc:red -strip tiny.png`, then converted with `-strip`). They contain no user image or metadata. Tests read them as bytes; ImageMagick is not a test/runtime dependency.
