"""Preserve detected source hands without masking the generated mouth or jaw."""
import cv2
import numpy as np


def create_segmenter(model_path):
    import mediapipe as mp
    options = mp.tasks.vision.ImageSegmenterOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
        output_category_mask=False, output_confidence_masks=True)
    segmenter = mp.tasks.vision.ImageSegmenter.create_from_options(options)
    if segmenter.labels != ["background", "hair", "body-skin", "face-skin", "clothes", "others"]:
        segmenter.close()
        raise RuntimeError("Unexpected occlusion model labels")
    return segmenter


def create_hand_detector(model_path):
    import mediapipe as mp
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
        num_hands=2)
    return mp.tasks.vision.HandLandmarker.create_from_options(options)


def protection_from_scores(scores, width, height, hands=()):
    # Body skin also includes the neck; clothes/others can touch the jaw or
    # appear inside an open mouth. Only accept them near a detected hand.
    hand_region = np.zeros(scores[0].shape, dtype=np.uint8)
    sh, sw = hand_region.shape
    for points in hands:
        pixels = np.round(np.asarray(points) * [sw, sh]).astype(np.int32)
        region = np.zeros_like(hand_region)
        cv2.fillConvexPoly(region, cv2.convexHull(pixels), 1)
        # Landmarks lie inside the fingers, not on their silhouette. Scale the
        # allowance with the hand so a close-up fingertip is not clipped off.
        margin = max(3, round(float(np.ptp(pixels, axis=0).min()) * 0.1))
        region = cv2.dilate(region, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*margin+1, 2*margin+1)))
        hand_region |= region
    foreground = np.maximum.reduce([scores[2], scores[4], scores[5]])
    core = ((foreground >= 0.35) & (foreground >= scores[3]) & (hand_region > 0)).astype(np.float32)
    core = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    core *= hand_region
    soft = np.maximum(core, cv2.GaussianBlur(core, (3, 3), 0)) * hand_region
    protection = cv2.resize(soft, (width, height), interpolation=cv2.INTER_LINEAR)
    # Resizing the soft edge must not make confidently protected pixels translucent.
    return np.maximum(protection, cv2.resize(core, (width, height), interpolation=cv2.INTER_NEAREST))


def source_protection(segmenter, hand_detector, frame, crop):
    import mediapipe as mp
    x, y, width, height = crop
    frame_h, frame_w = frame.shape[:2]
    # Detect in the full source frame: a face-only crop can omit the palm.
    scale = min(1, 768 / max(frame_h, frame_w))
    reduced = cv2.resize(frame, (round(frame_w * scale), round(frame_h * scale)), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(reduced, cv2.COLOR_BGR2RGB)
    detected = hand_detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    if not detected.hand_landmarks:
        return np.zeros((height, width), dtype=np.float32)
    hands = [[((p.x * frame_w - x) / width, (p.y * frame_h - y) / height)
              for p in hand] for hand in detected.hand_landmarks]
    # Segment the original picture, not the provider's potentially erased hand.
    # Keep outputs at model resolution so six full-size probability maps are not
    # allocated for every HD frame. The segmenter is reused throughout the clip.
    source_crop = frame[y:y + height, x:x + width]
    reduced = cv2.resize(source_crop, (256, 256), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(reduced, cv2.COLOR_BGR2RGB)
    result = segmenter.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    scores = [mask.numpy_view().squeeze() for mask in result.confidence_masks]
    return protection_from_scores(scores, width, height, hands)
