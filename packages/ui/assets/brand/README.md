# Client branding

- `polytec.png` and `fraunhofer.jpg` are the user-supplied reference images from 2026-11-05.
- `fraunhofer-transparent.png` removes the exterior white background from the Fraunhofer reference, using the built-in image generation editor. The header aligns the main green mark and wordmark with Polytec; the IPA descender shares the subtitle row.
- `app-icon.png` is the transparent, text-free Fraunhofer symbol extracted from that reference for the desktop application icon.
- `PartnerBrand` composes the two reference wordmarks with a multiplication sign in the desktop and Web headers. It does not change their lettering.
- Runtime copies live in `apps/desktop/public/brand` and `apps/web/public/brand`. Desktop packaging uses `apps/desktop/build/icons/icon.{png,icns,ico}`; keep those copies consistent when updating the icon.

The brand assets are provided for this customized client; their inclusion does not assert a partnership or endorsement.
