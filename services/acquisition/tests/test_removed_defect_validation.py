import unittest
from unittest.mock import Mock

from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from blade_acquisition.record_analysis.reference.geometry import SignalError


class RemovedDefectValidationTests(unittest.TestCase):
    def test_old_desktop_request_is_rejected_before_reading_or_writing_data(self):
        manager = object.__new__(RecordAnalysisManager)
        manager._load_segment = Mock(side_effect=AssertionError('must not read samples'))
        with self.assertRaises(SignalError) as raised:
            manager.extended({'kind': 'defect_validation', 'parameters': {'point': 'P3'}})
        self.assertEqual(raised.exception.code, 'INVALID_ANALYSIS_KIND')
        manager._load_segment.assert_not_called()

    def test_real_displacement_and_band_analysis_still_dispatch(self):
        manager = object.__new__(RecordAnalysisManager)
        manager._point_displacement = Mock(return_value={'available': True, 'kind': 'point_displacement'})
        manager._point_band = Mock(return_value={'available': True, 'kind': 'point_band'})
        for kind in ('point_displacement', 'point_band'):
            request = {'kind': kind, 'jobId': 'existing-measurement'}
            self.assertEqual(manager.extended(request)['kind'], kind)
            getattr(manager, '_'+kind).assert_called_once_with(request)


if __name__ == '__main__':
    unittest.main()
