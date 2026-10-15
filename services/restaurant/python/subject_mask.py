"""Local subject masks only. RGB pixels are never generated or modified here."""
import base64
import io
import json
import sys

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image


def refine(image, prediction):
    image = image.copy()
    image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    rgb = np.asarray(image)
    height, width = rgb.shape[:2]
    probability = cv2.resize(prediction, (width, height), interpolation=cv2.INTER_LINEAR)
    labels = np.where(probability >= .5, cv2.GC_PR_FGD, cv2.GC_PR_BGD).astype(np.uint8)
    # Low model saliency is not a sure background: a plate rim may be less salient than food.
    labels[:2, :] = labels[-2:, :] = labels[:, :2] = labels[:, -2:] = cv2.GC_BGD
    yy, xx = np.ogrid[:height, :width]
    center = ((xx - width / 2) / (width * .32)) ** 2 + ((yy - height / 2) / (height * .38)) ** 2 < 1
    seeds = (probability > .9) & center
    if np.count_nonzero(seeds) < width * height * .05:
        raise ValueError("unreliable foreground")
    labels[seeds] = cv2.GC_FGD
    cv2.setRNGSeed(0)
    cv2.grabCut(rgb, labels, None, np.zeros((1, 65)), np.zeros((1, 65)), 3, cv2.GC_INIT_WITH_MASK)
    foreground = np.uint8((labels == cv2.GC_FGD) | (labels == cv2.GC_PR_FGD)) * 255
    count, components, stats, _ = cv2.connectedComponentsWithStats(foreground, connectivity=8)
    if count < 2:
        raise ValueError("empty foreground")
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    primary_area = int(stats[largest, cv2.CC_STAT_AREA])
    if any(stats[i, cv2.CC_STAT_AREA] > primary_area * .05 for i in range(1, count) if i != largest):
        raise ValueError("ambiguous foreground components")
    foreground = np.uint8(components == largest) * 255
    # Fill holes inside the plate so sauces and dark food never become transparent.
    exterior = foreground.copy()
    cv2.floodFill(exterior, np.zeros((height + 2, width + 2), dtype=np.uint8), (0, 0), 255)
    foreground |= cv2.bitwise_not(exterior)
    hull = cv2.convexHull(cv2.findNonZero(foreground))
    protected = np.zeros_like(foreground)
    cv2.fillConvexPoly(protected, hull, 255)
    if np.count_nonzero(protected) > np.count_nonzero(foreground) * 1.15:
        raise ValueError("unreliable dish boundary")
    foreground = protected
    alpha = cv2.GaussianBlur(foreground, (3, 3), .6)
    alpha[alpha > 245] = 255
    alpha[alpha < 10] = 0
    return Image.fromarray(alpha)


def main():
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    cv2.setNumThreads(2)
    session = ort.InferenceSession(sys.argv[1], sess_options=options, providers=["CPUExecutionProvider"])
    for line in sys.stdin:
        try:
            request = json.loads(line)
            image = Image.open(io.BytesIO(base64.b64decode(request["image"], validate=True))).convert("RGB")
            if image.width * image.height > 4_000_000:
                raise ValueError("image too large")
            pixels = np.asarray(image.resize((320, 320), Image.Resampling.LANCZOS), dtype=np.float32)
            pixels /= max(float(pixels.max()), 1.0)
            pixels = (pixels - np.array([.485, .456, .406], dtype=np.float32)) / np.array([.229, .224, .225], dtype=np.float32)
            tensor = pixels.transpose(2, 0, 1)[None, ...]
            prediction = session.run(None, {session.get_inputs()[0].name: tensor})[0][0, 0]
            span = float(prediction.max() - prediction.min())
            if not np.isfinite(prediction).all() or span < .05:
                raise ValueError("empty prediction")
            prediction = (prediction - prediction.min()) / span
            mask = refine(image, prediction)
            stream = io.BytesIO()
            mask.save(stream, format="PNG")
            print(json.dumps({"mask": base64.b64encode(stream.getvalue()).decode("ascii")}), flush=True)
        except Exception:
            print(json.dumps({"error": "SUBJECT_MASK_FAILED"}), flush=True)


if __name__ == "__main__":
    main()
