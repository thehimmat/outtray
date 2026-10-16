"""Dev-only: derive degraded page images from the synthetic fixtures (#160).

The clean renders are too easy for OCR (every labelled value is read; see
docs/evals/ocr-scoreboard.md). These variants imitate what a real pile looks
like: a flatbed scan and a poor phone photo. Labels and HTML stay those of the
source fixture; only the image changes.

Deterministic for a given Pillow/NumPy/libjpeg: the seed below and each
fixture's id fix the noise. The outputs are committed with SHA-256 checksums in
fixtures/degraded/manifest.json, so CI never runs this.

Usage: python3 -I packages/evals/scripts/degrade-fixtures.py
Needs: Pillow, NumPy.
"""

import hashlib
import json
import pathlib
import zlib

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

SEED = 20261016
ROOT = pathlib.Path(__file__).resolve().parent.parent / "fixtures"
OUT = ROOT / "degraded"

# Each level, in the order the operations run. Keep these in the manifest so a
# reader of the scoreboard can see what "harsh" means without opening this file.
LEVELS = {
    "scan": {
        "description": "Flatbed scan: slight skew, soft focus, sensor noise, JPEG.",
        "scale": 1.0,
        "rotate_deg": 1.5,
        "blur_radius": 0.8,
        "contrast": 0.85,
        "shade": 0.0,
        "noise_sigma": 10.0,
        "jpeg_quality": 55,
    },
    "harsh": {
        "description": (
            "Poor phone photo: half resolution, visible skew, blur, uneven light, "
            "washed-out contrast, heavy noise, strong JPEG."
        ),
        "scale": 0.5,
        "rotate_deg": -3.5,
        "blur_radius": 1.2,
        "contrast": 0.55,
        "shade": 0.35,
        "noise_sigma": 18.0,
        "jpeg_quality": 35,
    },
}


def degrade(img: Image.Image, p: dict, rng: np.random.Generator) -> Image.Image:
    img = img.convert("L")
    if p["scale"] != 1.0:
        w, h = img.size
        img = img.resize((round(w * p["scale"]), round(h * p["scale"])), Image.Resampling.LANCZOS)
    img = img.rotate(p["rotate_deg"], resample=Image.Resampling.BICUBIC, fillcolor=255)
    img = img.filter(ImageFilter.GaussianBlur(p["blur_radius"]))
    img = ImageEnhance.Contrast(img).enhance(p["contrast"])
    a = np.asarray(img, dtype=np.float64)
    if p["shade"] > 0:
        h, w = a.shape
        ramp = np.linspace(0.0, 1.0, w)[None, :] * 0.5 + np.linspace(0.0, 1.0, h)[:, None] * 0.5
        a = a * (1.0 - p["shade"] * ramp)
    a = a + rng.normal(0.0, p["noise_sigma"], a.shape)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), mode="L")


def main() -> None:
    clean = json.loads((ROOT / "manifest.json").read_text())
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.jpg"):
        old.unlink()
    pages = []
    for entry in clean["fixtures"]:
        source = Image.open(ROOT / entry["files"]["png"]["path"])
        for level, params in LEVELS.items():
            page_id = f"{entry['id']}.{level}"
            rng = np.random.default_rng([SEED, zlib.crc32(page_id.encode())])
            path = OUT / f"{page_id}.jpg"
            degrade(source, params, rng).save(path, "JPEG", quality=params["jpeg_quality"])
            pages.append(
                {
                    "id": page_id,
                    "source": entry["id"],
                    "level": level,
                    "image": {
                        "path": f"degraded/{page_id}.jpg",
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    },
                }
            )
    manifest = {"seed": SEED, "levels": LEVELS, "count": len(pages), "pages": pages}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(pages)} pages to {OUT}")


if __name__ == "__main__":
    main()
