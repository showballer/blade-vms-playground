"""Optical calibration contracts without hardware or acquisition."""
import math
import unittest
from pydantic import ValidationError
from blade_acquisition.turntable import PointCycleConfig, PointCycleGeometry
from test_automatic_stations import automatic_config


class PitchCalibrationTests(unittest.TestCase):
    def geometry(self, scale=0.896932, yaw_scale=1):
        return PointCycleGeometry(distanceM=2.5, hubHeightDeltaM=.73,
            anchorRadiusM=.16, anchorAxis1AngleDeg=.009 + scale * math.degrees(math.atan2(.57, 2.5)),
            anchorAxis2AngleDeg=0, pitchAngleScale=scale, yawAngleScale=yaw_scale)

    def test_live_p1_golden_targets_and_roundtrip_metadata(self):
        geometry = self.geometry()
        expected = ((11.529, 0), (14.581, -3.662), (17.585, 0), (14.581, 3.662))
        restored = PointCycleGeometry.model_validate_json(geometry.model_dump_json())
        for phase, angles in zip((0, 90, 180, 270), expected):
            for actual, target in zip(restored.angles(.16, phase), angles):
                self.assertAlmostEqual(actual, target, delta=.0006)

    def test_legacy_metadata_defaults_to_identity(self):
        data = self.geometry(1).model_dump()
        del data['pitchAngleScale']
        del data['yawAngleScale']
        legacy = PointCycleGeometry(**data)
        self.assertEqual(legacy.pitchAngleScale, 1)
        self.assertEqual(legacy.yawAngleScale, 1)
        for phase in (0, 45, 90, 180, 270):
            self.assertEqual(legacy.angles(.16, phase), self.geometry(1).angles(.16, phase))

    def test_anchor_is_not_scaled_and_yaw_is_unchanged(self):
        scaled, identity = self.geometry(), self.geometry(1)
        scaled.anchorAxis1AngleDeg = identity.anchorAxis1AngleDeg = 8
        for sign in (-1, 1):
            scaled.axis1Sign = identity.axis1Sign = sign
            self.assertEqual(scaled.angles(.16, 0)[0], 8)
            for radius in (.16, .3, .72):
                for phase in (0, 90, 180, 270):
                    pitch, yaw = scaled.angles(radius, phase)
                    original_pitch, original_yaw = identity.angles(radius, phase)
                    self.assertAlmostEqual(pitch, 8 + .896932 * (original_pitch - 8))
                    self.assertEqual(yaw, original_yaw)

    def test_invalid_calibration_does_not_silently_fall_back(self):
        for value in (0, .4999, 1.5001, float('nan'), float('inf'), True, None, '0.9'):
            for key in ('pitchAngleScale', 'yawAngleScale'):
                with self.subTest(key=key, value=value), self.assertRaises(ValidationError):
                    PointCycleGeometry(**{**self.geometry().model_dump(), key: value})

    def test_capture_preflight_accepts_corrected_targets_and_preserves_metadata(self):
        geometry = self.geometry(yaw_scale=.950153)
        data = automatic_config(radial_points=(('p1', .16),), geometry=geometry.model_dump())
        for point in data['points']:
            pitch, yaw = geometry.angles(point['radiusM'], point['azimuthDeg'])
            point.update(axis1AngleDeg=round(pitch, 6), axis2AngleDeg=round(yaw, 6))
        for port in ('COM6', '/dev/cu.usbserial-test', 'tcp://192.168.10.50:5000'):
            data['port'] = port
            for point in data['points']:
                point['port'] = port
            config = PointCycleConfig(**data)
            self.assertEqual(config.geometry.pitchAngleScale, .896932)
            self.assertEqual(config.geometry.yawAngleScale, .950153)
            self.assertEqual(PointCycleConfig.model_validate_json(config.model_dump_json()), config)
        for key, correct in (('pitchAngleScale', .896932), ('yawAngleScale', .950153)):
            data['geometry'][key] = 1
            with self.subTest(key=key), self.assertRaises(ValidationError):
                PointCycleConfig(**data)
            data['geometry'][key] = correct

    def test_p5_horizontal_trials_and_p1_cross_check(self):
        geometry = self.geometry(yaw_scale=.950153)
        for radius, phase, pitch, yaw in ((.72, 0, .215, 0), (.72, 90, 14.067, -15.266),
                (.72, 180, 27.019, 0), (.72, 270, 14.067, 15.266), (.16, 90, 14.581, -3.479)):
            actual = geometry.angles(radius, phase)
            self.assertAlmostEqual(actual[0], pitch, delta=.0006)
            self.assertAlmostEqual(actual[1], yaw, delta=.0006)
        geometry.anchorAxis2AngleDeg = 2
        identity = geometry.model_copy(update={'yawAngleScale': 1})
        for sign in (-1, 1):
            geometry.axis2Sign = identity.axis2Sign = sign
            self.assertEqual(geometry.angles(.16, 0)[1], 2)
            for radius in (.16, .3, .72):
                for phase in (0, 90, 180, 270):
                    actual, original = geometry.angles(radius, phase), identity.angles(radius, phase)
                    self.assertEqual(actual[0], original[0])
                    self.assertAlmostEqual(actual[1], 2 + .950153 * (original[1] - 2))
