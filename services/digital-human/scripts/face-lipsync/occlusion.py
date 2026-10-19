"""Preserve source hands, sleeves and accessories in front of a generated mouth."""
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


def protection_from_scores(scores, width, height):
    # Body skin includes fingers; face skin includes the lips. Keep a narrow
    # protective margin around uncertain hand edges, never feather the hand core.
    foreground = np.maximum.reduce([scores[2], scores[4], scores[5]])
    core = ((foreground >= 0.35) & (foreground >= scores[3])).astype(np.float32)
    core = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    soft = np.maximum(core, cv2.GaussianBlur(core, (3, 3), 0))
    protection = cv2.resize(soft, (width, height), interpolation=cv2.INTER_LINEAR)
    # Resizing the soft edge must not make confidently protected pixels translucent.
    return np.maximum(protection, cv2.resize(core, (width, height), interpolation=cv2.INTER_NEAREST))


def source_protection(segmenter, source_crop):
    import mediapipe as mp
    height, width = source_crop.shape[:2]
    # Segment the original picture, not the provider's potentially erased hand.
    # Keep outputs at model resolution so six full-size probability maps are not
    # allocated for every HD frame. The segmenter is reused throughout the clip.
    reduced = cv2.resize(source_crop, (256, 256), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(reduced, cv2.COLOR_BGR2RGB)
    result = segmenter.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    scores = [mask.numpy_view().squeeze() for mask in result.confidence_masks]
    return protection_from_scores(scores, width, height)
