import tempfile
import unittest
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import wave
import worker
from occlusion import protection_from_scores, source_protection

import numpy as np
from worker import QualityError, choose_delay, crop_plan, pad_audio, frame_offset, prepare, composite


class FaceWorkflowTests(unittest.TestCase):
    def test_long_narration_face_input_holds_the_last_frame_before_lipsync(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            source = job / "original.mp4"
            worker.ffmpeg(["-f", "lavfi", "-i", "color=red:s=128x128:r=30:d=1",
                           "-f", "lavfi", "-i", "color=blue:s=128x128:r=30:d=1",
                           "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
                           "-map", "[v]", "-c:v", "libx264", str(source)])
            audio = job / "voice.wav"
            with wave.open(str(audio), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(24000)
                wav.writeframes(bytes(24000 * 2 * 7 // 2))
            detector = unittest.mock.Mock()
            detector.detect.return_value = (None, np.array([[12,12,100,100,40,40,80,40,60,60,40,80,80,80,.99]], dtype=np.float32))
            with patch("worker.load_syncnet", return_value=object()), \
                 patch("worker.create_segmenter"), \
                 patch("worker.create_hand_detector"), \
                 patch("worker.cv2.FaceDetectorYN.create", return_value=detector):
                result = prepare({"inputVideoPath":str(source), "audioPath":str(audio),
                                  "durationSeconds":3.5, "jobDir":directory})
            self.assertAlmostEqual(result["durationSeconds"], 4.4)
            images = list(worker.frames(job / "face-input.mp4", 16, 16))
            self.assertEqual(len(images), 132)
            for seconds in [2.2, 2.8, 3.4]:
                pixel = images[round((seconds + worker.PREPAD) * worker.FPS)].mean(axis=(0,1))
                self.assertTrue(pixel[0] > 200 and pixel[2] < 20,
                                f"provider input returned to the red opening at {seconds}s: {pixel}")
            manifest = json.loads((job / "face-manifest.json").read_text())
            self.assertEqual(len(manifest["track"]), 105)

    def test_tiny_secondary_detection_does_not_reject_the_only_usable_face(self):
        info = {"width":720,"height":1280,"duration":1}
        main = [318,462,117,160,348,527,403,525,375,559,355,581,402,579,.94]
        hand = [440,807,70,91,488,833,503,837,507,848,485,872,496,868,.76]
        detector = unittest.mock.Mock()
        detector.detect.return_value = (None,np.array([main,hand],dtype=np.float32))
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter([np.zeros((1280,720,3),dtype=np.uint8)]*6)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            _,data = worker.track("source.mp4")
        np.testing.assert_array_equal(data,np.tile(np.array(main[:14]),(6,1)))

    def test_two_usable_faces_still_rejected(self):
        info = {"width":720,"height":1280,"duration":1}
        row = [20,20,100,120,40,40,70,40,55,60,40,80,70,80,.95]
        detector = unittest.mock.Mock()
        detector.detect.return_value = (None,np.array([row,row],dtype=np.float32))
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter([np.zeros((1280,720,3),dtype=np.uint8)])), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            with self.assertRaisesRegex(QualityError,"More than one face"):
                worker.track("source.mp4")

    def test_extended_source_detects_identical_frames_once_and_keeps_full_track(self):
        info = {"width":128,"height":128,"duration":1}
        images = [np.full((128,128,3), i, dtype=np.uint8) for i in range(3)]
        rows = []
        class Detector:
            def detect(self, frame):
                i = int(frame[0,0,0])
                row = np.array([20+i,20,80,90,40,40,70,40,55,60,40,80,70,80,.99], dtype=np.float32)
                rows.append(row[:14])
                return None, row[None]
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter(images + [images[-1]]*6)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=Detector()):
            _, data = worker.track("source.mp4",duration=3,extend=True)
        self.assertEqual(len(rows),3,"repeated source frames must not rerun face inference")
        self.assertEqual(len(data),9,"every decoded frame still needs a face position")
        expected = worker.median_filter(np.concatenate([np.array(rows),np.repeat(np.array(rows[-1:]),6,axis=0)]),size=(3,1),mode="nearest")
        np.testing.assert_array_equal(data,expected)

    def test_reused_missing_faces_still_count_every_frame_against_coverage_gate(self):
        info = {"width":128,"height":128,"duration":1}
        image = np.zeros((128,128,3),dtype=np.uint8)
        detector = unittest.mock.Mock()
        detector.detect.return_value = (None,None)
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter([image]*6)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            with self.assertRaisesRegex(QualityError,"Face missing for more than five frames"):
                worker.track("source.mp4",duration=3,extend=True)
        self.assertEqual(detector.detect.call_count,1)

    def test_non_extended_source_still_detects_all_frames(self):
        info = {"width":128,"height":128,"duration":3}
        image = np.zeros((128,128,3),dtype=np.uint8)
        detector = unittest.mock.Mock()
        detector.detect.return_value = (None,np.array([[20,20,80,90,40,40,70,40,55,60,40,80,70,80,.99]],dtype=np.float32))
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter([image]*6)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            _,data = worker.track("source.mp4",duration=3,extend=False)
        self.assertEqual(detector.detect.call_count,6)
        self.assertEqual(len(data),6)

    def test_reused_track_still_rejects_a_jump_in_the_original_video(self):
        info = {"width":256,"height":256,"duration":1}
        images = [np.full((256,256,3),i,dtype=np.uint8) for i in range(3)]
        detector = unittest.mock.Mock()
        detector.detect.side_effect = lambda frame:(None,np.array([[int(frame[0,0,0])*60,20,80,90,40,40,70,40,55,60,40,80,70,80,.99]],dtype=np.float32))
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter(images + [images[-1]]*6)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            with self.assertRaisesRegex(QualityError,"Face track jumps or source contains a cut"):
                worker.track("source.mp4",duration=3,extend=True)
        self.assertEqual(detector.detect.call_count,3)

    def test_alignment_uses_full_validated_source_track_in_output_coordinates(self):
        data = np.arange(60 * 14, dtype=float).reshape(60, 14)
        info = {"width":640, "height":480, "duration":2}
        measured = []
        def scores(video, audio, face_track=None, model=None):
            measured.append(face_track)
            return [{"delayMs":0,"confidence":5}]
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory)/"candidate.mp4")
            (Path(directory)/"face-manifest.json").write_text(json.dumps({"version":1, "durationSeconds":2,
                "source":{"width":1280,"height":960}, "track":data.tolist()}))
            with patch("worker.load_syncnet", return_value=object()), \
                 patch("worker.track", side_effect=AssertionError("validated source must not be detected again")), \
                 patch("worker.sync_scores", side_effect=scores), patch("worker.probe", return_value=info), \
                 patch("worker.ffmpeg", side_effect=lambda args:Path(args[-1]).touch()):
                worker.align({"videoPath":"video.mp4","audioPath":"voice.wav","outputPath":output,"jobDir":directory})
            self.assertEqual(len(measured),2)
            for frame_track in measured:
                np.testing.assert_array_equal(frame_track[1],data*0.5)

    def test_sync_face_crop_matches_full_frame_padding_at_image_edges(self):
        frame = np.random.default_rng(41).integers(0, 256, (240, 320, 3), dtype=np.uint8)
        for box in [(53, 61, 182, 217), (-19, -13, 113, 165), (211, 170, 369, 283), (-20, -20, 340, 260)]:
            x1, y1, x2, y2 = box
            padded = worker.cv2.copyMakeBorder(frame, max(0, -y1), max(0, y2-240), max(0, -x1), max(0, x2-320), worker.cv2.BORDER_CONSTANT)
            expected = padded[max(0, y1):max(0, y1)+y2-y1, max(0, x1):max(0, x1)+x2-x1]
            np.testing.assert_array_equal(worker.sync_face_crop(frame, box), expected)

    def test_alignment_reuses_validated_geometry_after_padding_but_still_measures_encoded_candidate(self):
        data = np.arange(60 * 14, dtype=float).reshape(60, 14)
        info = {"width": 640, "height": 480, "duration": 2}
        model = object()
        measured = []
        def scores(video, audio, face_track=None, model=None):
            measured.append((video, audio, face_track, model))
            return [{"delayMs": -80 if len(measured) == 1 else 0, "confidence": 5}]
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "candidate.mp4")
            def encode(args):
                Path(args[-1]).touch()
            with patch("worker.load_syncnet", return_value=model) as loaded, \
                 patch("worker.track", return_value=(info, data)) as tracked, \
                 patch("worker.sync_scores", side_effect=scores), \
                 patch("worker.probe", return_value=info), patch("worker.ffmpeg", side_effect=encode):
                worker.align({"videoPath":"video.mp4", "audioPath":"voice.wav", "outputPath":output, "jobDir":directory})
            self.assertEqual(loaded.call_count, 1)
            self.assertEqual(tracked.call_count, 1)
            self.assertEqual(len(measured), 2, "encoded output still needs complete SyncNet measurement")
            self.assertEqual(measured[1][:2], (output, output))
            self.assertIs(measured[0][3], model)
            self.assertIs(measured[1][3], model)
            np.testing.assert_array_equal(measured[1][2][1][:2], np.repeat(data[:1], 2, axis=0))
            np.testing.assert_array_equal(measured[1][2][1][2:], data)

    def test_encoded_candidate_uncertainty_does_not_remove_deliverable(self):
        data = np.ones((60, 14))
        info = {"width":640, "height":480, "duration":2}
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory)/"candidate.mp4")
            with patch("worker.load_syncnet", return_value=object()), patch("worker.track", return_value=(info,data)), \
                 patch("worker.sync_scores", side_effect=[[{"delayMs":0,"confidence":5}], [{"delayMs":80,"confidence":5}]]), \
                 patch("worker.probe", return_value=info), \
                 patch("worker.ffmpeg", side_effect=lambda args:Path(args[-1]).touch()):
                report = worker.align({"videoPath":"video.mp4", "audioPath":"voice.wav", "outputPath":output, "jobDir":directory})
            self.assertTrue(Path(output).exists())
            self.assertEqual(report["residualDelayMs"],80)

    def test_one_uncertain_window_does_not_block_long_clip_calibration(self):
        # The reported 63-second job: 62 windows agree on 40 ms, one on 80 ms;
        # one of the 40 ms windows has confidence 2.35 rather than >= 3.
        rows = [{"delayMs":40,"confidence":6} for _ in range(63)]
        rows[1]["confidence"] = 2.35
        rows[21]["delayMs"] = 80
        self.assertEqual(choose_delay(rows),40)

    def test_measurement_failure_still_encodes_complete_narration(self):
        info = {"width":640,"height":480,"duration":2}
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory)/"candidate.mp4")
            with patch("worker.load_syncnet",side_effect=RuntimeError("model unavailable")), \
                 patch("worker.probe",return_value=info), \
                 patch("worker.ffmpeg",side_effect=lambda args:Path(args[-1]).touch()) as encoded:
                report = worker.align({"videoPath":"video.mp4","audioPath":"voice.wav","outputPath":output,"jobDir":directory})
            self.assertTrue(Path(output).exists())
            self.assertEqual(report["appliedDelayMs"],0)
            self.assertTrue(report["warnings"])
            self.assertIn("voice.wav",encoded.call_args.args[0])

    def test_mouth_roi_matches_full_crop_math_pixel_for_pixel(self):
        rng = np.random.default_rng(37)
        frame = rng.integers(0, 256, (240, 320, 3), dtype=np.uint8)
        patch_image = rng.integers(0, 256, (160, 160, 3), dtype=np.uint8)
        for cx, cy, rx, ry in [(80.3, 92.7, 26.8, 17.5), (4.1, 155.7, 27.2, 16.6), (200, 80, 22, 19)]:
            yy, xx = np.mgrid[0:160, 0:160]
            radius = np.sqrt(((xx-cx)/rx)**2 + ((yy-cy)/ry)**2)
            alpha = np.clip((1-radius)/0.3, 0, 1)
            alpha = (alpha*alpha*(3-2*alpha))[:, :, None]
            expected = frame.copy()
            region = expected[40:200, 60:220]
            expected[40:200, 60:220] = np.clip(region*(1-alpha)+patch_image*alpha, 0, 255).astype(np.uint8)
            actual = worker.blend_mouth(frame, patch_image, 60, 40, cx, cy, rx, ry)
            np.testing.assert_array_equal(actual, expected)
            np.testing.assert_array_equal(frame[:40], actual[:40])

    def test_hand_in_front_of_mouth_keeps_source_pixels(self):
        frame = np.full((120, 160, 3), 90, dtype=np.uint8)
        # A finger crosses the centre of the replacement, including its edge.
        frame[35:95, 77:86] = [40, 120, 220]
        generated = np.full((80, 100, 3), [180, 30, 70], dtype=np.uint8)
        protected = np.zeros((80, 100), dtype=np.float32)
        protected[15:75, 47:56] = 1
        actual = worker.blend_mouth(frame, generated, 30, 20, 50, 40, 35, 25, protected)
        np.testing.assert_array_equal(actual[35:95, 77:86], frame[35:95, 77:86])
        np.testing.assert_array_equal(actual[60, 65], generated[40, 35])
        np.testing.assert_array_equal(actual[:20], frame[:20])

    def test_no_occlusion_keeps_existing_mouth_blend_exactly(self):
        rng = np.random.default_rng(83)
        frame = rng.integers(0, 256, (120, 160, 3), dtype=np.uint8)
        generated = rng.integers(0, 256, (80, 100, 3), dtype=np.uint8)
        expected = worker.blend_mouth(frame, generated, 30, 20, 50, 40, 35, 25)
        actual = worker.blend_mouth(frame, generated, 30, 20, 50, 40, 35, 25,
                                    np.zeros((80, 100), dtype=np.float32))
        np.testing.assert_array_equal(actual, expected)

    def test_neck_clothes_and_mouth_labels_alone_do_not_cut_the_generated_jaw(self):
        scores = np.zeros((6, 64, 64), dtype=np.float32)
        scores[3] = 1
        # Segmentation cannot tell a neck from a hand, or an open mouth from
        # an accessory. None of these labels proves a foreground occlusion.
        for label, region in [(2, (slice(46, 56), slice(None))),
                              (4, (slice(56, None), slice(None))),
                              (5, (slice(30, 35), slice(25, 39)))]:
            scores[3][region] = 0
            scores[label][region] = 1
        protection = protection_from_scores(scores, 64, 64)
        self.assertFalse(protection.any(), "without a detected hand, keep the entire generated mouth/jaw")
        frame = np.full((64, 64, 3), 20, dtype=np.uint8)
        generated = np.full_like(frame, 180)
        expected = worker.blend_mouth(frame, generated, 0, 0, 32, 40, 25, 23)
        actual = worker.blend_mouth(frame, generated, 0, 0, 32, 40, 25, 23, protection)
        np.testing.assert_array_equal(actual, expected)

    def test_protection_tracks_current_hand_without_leaving_a_mask_after_it_moves(self):
        scores = np.zeros((6, 64, 64), dtype=np.float32)
        scores[3] = 1  # Uncovered face, including the lips.
        for column in [16, 42, None]:
            current = scores.copy()
            hands = []
            if column is not None:
                current[3, 12:52, column:column + 6] = 0.15
                current[2, 12:52, column:column + 6] = 0.85
                hands = [[(column/64, 12/64), ((column+6)/64, 12/64),
                          ((column+6)/64, 52/64), (column/64, 52/64)]]
            protection = protection_from_scores(current, 128, 96, hands)
            self.assertEqual(protection[48, 64], 0, "uncovered mouth must still animate")
            if column is None:
                self.assertFalse(protection.any(), "old hand positions must not leave a frozen mouth")
            else:
                self.assertEqual(protection[48, column * 2 + 4], 1)
                other = 42 if column == 16 else 16
                self.assertEqual(protection[48, other * 2 + 4], 0)

    def test_detected_hand_does_not_enable_neck_or_inner_mouth_protection_elsewhere(self):
        scores = np.zeros((6, 64, 64), dtype=np.float32)
        scores[3] = 1
        scores[3, 40:] = 0
        scores[2, 40:] = 1  # A neck shares the hand's segmentation class.
        scores[3, 25:35, 25:35] = 0
        scores[5, 25:35, 25:35] = 1  # Uncertain open-mouth pixels.
        scores[3, 20:52, 48:56] = 0
        scores[2, 20:52, 48:56] = 1
        hands = [[(48/64, 20/64), (56/64, 20/64), (56/64, 52/64), (48/64, 52/64)]]
        protection = protection_from_scores(scores, 64, 64, hands)
        self.assertEqual(protection[30, 52], 1, "preserve the foreground finger")
        self.assertFalse(protection[:, :40].any(), "never restore the unrelated original mouth or jaw")

    def test_no_detected_hand_skips_segmentation_and_preserves_uncovered_mouth(self):
        detector = unittest.mock.Mock()
        detector.detect.return_value.hand_landmarks = []
        segmenter = unittest.mock.Mock()
        mask = source_protection(segmenter, detector, np.zeros((120, 160, 3), np.uint8), (40, 20, 80, 80))
        self.assertEqual(mask.shape, (80, 80))
        self.assertFalse(mask.any())
        segmenter.segment.assert_not_called()

    def test_close_up_fingertip_outside_landmark_hull_remains_protected(self):
        scores = np.zeros((6, 256, 256), dtype=np.float32)
        scores[3] = 1
        scores[3, 62:180, 140:240] = 0
        scores[2, 62:180, 140:240] = 1
        hands = [[(150/256, 70/256), (230/256, 70/256), (230/256, 170/256), (150/256, 170/256)]]
        mask = protection_from_scores(scores, 256, 256, hands)
        self.assertEqual(mask[63, 180], 1)
        self.assertFalse(mask[:, :130].any())

    def test_hand_landmarks_are_mapped_from_full_frame_to_face_crop(self):
        detector = unittest.mock.Mock()
        detector.detect.return_value.hand_landmarks = [[SimpleNamespace(x=x/160, y=y/120)
            for x, y in [(96, 40), (112, 40), (112, 80), (96, 80)]]]
        scores = np.zeros((6, 64, 64), dtype=np.float32)
        scores[2] = 1
        segmenter = unittest.mock.Mock()
        segmenter.segment.return_value.confidence_masks = [SimpleNamespace(numpy_view=lambda s=s: s) for s in scores]
        mask = source_protection(segmenter, detector, np.zeros((120, 160, 3), np.uint8), (40, 20, 80, 80))
        self.assertEqual(detector.detect.call_args.args[0].numpy_view().shape, (120, 160, 3))
        self.assertEqual(mask[40, 64], 1)
        self.assertFalse(mask[:, :45].any())

    def test_fully_occluded_mouth_preserves_source_instead_of_painting_through_it(self):
        frame = np.full((120, 160, 3), [45, 125, 210], dtype=np.uint8)
        generated = np.full((80, 100, 3), [170, 20, 80], dtype=np.uint8)
        actual = worker.blend_mouth(frame, generated, 30, 20, 50, 40, 35, 25,
                                    np.ones((80, 100), dtype=np.float32))
        np.testing.assert_array_equal(actual, frame)

    def test_occlusion_runtime_failure_stops_face_preparation_before_encoding(self):
        with patch("worker.load_syncnet"), \
             patch("worker.create_segmenter", side_effect=RuntimeError("missing occlusion model")), \
             patch("worker.ffmpeg") as encode:
            with self.assertRaisesRegex(RuntimeError, "missing occlusion model"):
                prepare({"jobDir": "/unused", "durationSeconds": 2})
        encode.assert_not_called()

    def test_missing_hand_model_stops_face_preparation_before_encoding(self):
        with patch("worker.load_syncnet"), patch("worker.create_segmenter"), \
             patch("worker.create_hand_detector", side_effect=RuntimeError("missing hand model")), \
             patch("worker.ffmpeg") as encode:
            with self.assertRaisesRegex(RuntimeError, "missing hand model"):
                prepare({"jobDir": "/unused", "durationSeconds": 2})
        encode.assert_not_called()

    def test_encoded_composite_preserves_moving_hand_and_releases_uncovered_mouth(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            source = np.full((12, 120, 160, 3), 90, dtype=np.uint8)
            source[:4, 45:95, 83:91] = [20, 220, 30]
            source[4:8, 45:95, 103:111] = [20, 220, 30]
            generated = np.full((39, 80, 80, 3), [180, 30, 170], dtype=np.uint8)
            for name, images in [("source-video.mp4", source), ("rendered.mp4", generated)]:
                height, width = images.shape[1:3]
                worker.sp.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                               "-s", f"{width}x{height}", "-r", "30", "-i", "-", "-an", "-c:v",
                               "libx264rgb", "-crf", "0", str(job / name)], input=images.tobytes(), check=True)
            row = [40,20,80,80,60,40,100,40,80,55,70,70,100,70]
            (job / "face-manifest.json").write_text(json.dumps({"durationSeconds": 0.4,
                "source": {"width":160,"height":120}, "crop": {"x":40,"y":20,"size":80},
                "track": [row] * 12}))
            seen = []
            def protect(_segmenter, _hand_detector, frame, crop):
                x, y, w, h = crop
                source_crop = frame[y:y+h, x:x+w]
                seen.append(source_crop.copy())
                return (source_crop[:, :, 1] > 180).astype(np.float32)
            with patch("worker.frame_offset", return_value=0), patch("worker.create_segmenter"), \
                 patch("worker.create_hand_detector"), \
                 patch("worker.source_protection", side_effect=protect):
                result = composite({"jobDir":directory, "renderedPath":str(job / "rendered.mp4")})
            output = list(worker.frames(job / "face-composited.mp4", 160, 120))
            self.assertEqual(result["frames"], 12)
            self.assertEqual(len(seen), 12)
            np.testing.assert_array_equal(seen[0], source[0,20:100,40:120])
            for index, x in [(2, 86), (6, 106)]:
                self.assertLess(np.abs(output[index][70,x].astype(int) - source[index,70,x]).max(), 12,
                                "encoded output must retain the source finger, not the generated patch")
            for index, x in [(6, 86), (10, 86), (10, 106)]:
                self.assertGreater(output[index][70,x,0], 140, "mouth must resume after the hand moves")

    def test_short_narration_fails_before_model_loading_or_paid_work(self):
        with self.assertRaises(QualityError) as caught:
            prepare({"jobDir": "/unused", "durationSeconds": 0.8})
        self.assertEqual(caught.exception.code, "LIPSYNC_INPUT_DURATION")

    def test_padding_keeps_every_original_pcm_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "voice.wav", Path(directory) / "padded.wav"
            pcm = np.arange(12345, dtype=np.int16).tobytes()
            with wave.open(str(source), "wb") as wav:
                wav.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
                wav.writeframes(pcm)
            duration = pad_audio(source, target)
            with wave.open(str(target), "rb") as wav:
                result = wav.readframes(wav.getnframes())
            lead, tail = round(0.6 * 22050) * 2, round(0.3 * 22050) * 2
            self.assertEqual(result[:lead], bytes(lead))
            self.assertEqual(result[lead:-tail], pcm)
            self.assertEqual(result[-tail:], bytes(tail))
            self.assertEqual(duration, 12345 / 22050)

    def test_crop_uses_native_coordinates_and_contains_moving_face(self):
        data = np.array([[1000, 1400, 210, 260], [1070, 1410, 210, 260]], dtype=float)
        result = crop_plan({"width": 2160, "height": 3840}, data)
        self.assertEqual(result["outputSize"], 768)
        self.assertEqual(result["size"], 768)
        self.assertLessEqual(result["x"], 1000)
        self.assertGreaterEqual(result["x"] + result["size"], 1280)
        self.assertLessEqual(result["y"], 1400)
        self.assertGreaterEqual(result["y"] + result["size"], 1670)

    def test_small_native_face_is_not_made_valid_by_upscaling(self):
        with self.assertRaises(QualityError):
            crop_plan({"width": 2160, "height": 3840}, np.array([[1000, 1400, 40, 55]], dtype=float))

    def test_alignment_uses_measured_delay_in_either_direction(self):
        for value in [-120, 0, 80]:
            self.assertEqual(choose_delay([{"delayMs": value, "confidence": 5}] * 3), value)
        for low, high in [(-40, 0), (0, 40), (80, 120)]:
            rows = [{"delayMs": value, "confidence": 5} for value in [low, high, high]]
            self.assertEqual(choose_delay(rows), high)

    def test_frame_registration_ignores_held_tail_when_matching_motion(self):
        moving = np.random.default_rng(52).normal(128, 20, (90, 4, 4, 3)).astype(np.float32)
        source = np.concatenate([moving, np.repeat(moving[-1:], 210, axis=0)])
        for delay in [-2, 0, 2]:
            with self.subTest(delay=delay):
                rendered = np.concatenate([np.repeat(source[:1], 18 + delay, axis=0), source,
                                           np.repeat(source[-1:], 9, axis=0)])
                self.assertEqual(frame_offset(source, rendered, 18), delay)

    def test_frame_registration_uses_one_offset_and_rejects_local_speed_changes(self):
        source = np.random.default_rng(7).uniform(0, 255, (100, 12, 32, 3)).astype(np.float32)
        for delay in [-2, 0, 1]:
            rendered = np.concatenate([np.repeat(source[:1], 18 + delay, axis=0), source, np.repeat(source[-1:], 9, axis=0)])
            self.assertEqual(frame_offset(source, rendered, 18), delay)
        warped = np.concatenate([np.repeat(source[:1], 18, axis=0), source[:50], source[52:], np.repeat(source[-1:], 11, axis=0)])
        with self.assertRaises(QualityError):
            frame_offset(source, warped, 18)

    def test_local_speed_mismatch_and_uncertain_match_do_not_guess_global_offsets(self):
        for rows in [[], [{"delayMs": 0, "confidence": 1}],
                     [{"delayMs": 200, "confidence": 8}],
                     [{"delayMs": 0, "confidence": 5}, {"delayMs": 120, "confidence": 6}]]:
            self.assertIsNone(choose_delay(rows))

    def test_composite_registers_against_exact_provider_input_not_rescaled_base(self):
        source = np.random.default_rng(9).uniform(0, 255, (60, 12, 32, 3)).astype(np.float32)
        tail = np.repeat(source[-1:], 9, axis=0)
        rendered = np.concatenate([np.repeat(source[:1], 18, axis=0), source, tail])
        reference = np.concatenate([source, tail])
        unrelated_base = np.roll(source, 12, axis=0)
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            (job / "face-input.mp4").touch()
            (job / "face-manifest.json").write_text(json.dumps({"durationSeconds": 2,
                "source": {"width": 64, "height": 64}, "crop": {"x": 0, "y": 0, "size": 64}}))
            def decoded(file, *args, **kwargs):
                if Path(file).name == "face-input.mp4":
                    self.assertIn("trim=start_frame=18", kwargs["extra"])
                    return iter(reference)
                return iter(rendered if Path(file).name == "rendered.mp4" else unrelated_base)
            # Stop just before encoding; exercise the actual correspondence
            # check using decoded-frame fixtures without loading face models.
            with patch("worker.probe", return_value={"width": 64, "height": 64, "duration": 2.9}), \
                 patch("worker.frames", side_effect=decoded), \
                 patch("worker.sp.Popen", side_effect=RuntimeError("registration-passed")):
                with self.assertRaisesRegex(RuntimeError, "registration-passed"):
                    composite({"jobDir": str(job), "renderedPath": str(job / "rendered.mp4")})
            self.assertEqual(json.loads((job / "face-registration.json").read_text())["fixedFrameOffset"], 0)


if __name__ == "__main__":
    unittest.main()
