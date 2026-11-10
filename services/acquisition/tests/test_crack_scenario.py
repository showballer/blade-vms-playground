import importlib.util
from pathlib import Path
import unittest

import numpy as np
from scipy import signal

spec=importlib.util.spec_from_file_location('crack_scenario',Path(__file__).parents[1]/'tools/generate_crack_scenario.py')
model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)


class CrackScenarioTest(unittest.TestCase):
    def test_repeatable_preserves_input_and_healthy_response(self):
        fs=4096;t=np.arange(8192)/fs;x=3+.2*t+.1*np.sin(2*np.pi*256*t);before=x.copy()
        y=model.synthesize(x,fs,3,np.random.default_rng(42),False)
        np.testing.assert_array_equal(x,before)
        np.testing.assert_array_equal(y,model.synthesize(x,fs,3,np.random.default_rng(42),False))
        self.assertLess(abs(np.std(signal.detrend(y))/np.std(signal.detrend(x))-1),.005)
        self.assertTrue(np.all(np.isfinite(y)))

    def test_crack_scenario_lowers_carrier_and_changes_outboard_response(self):
        fs=4096;t=np.arange(8192)/fs;x=3+.2*t+.1*np.sin(2*np.pi*256*t)
        y=model.synthesize(x,fs,3,np.random.default_rng(42),True)
        residual=signal.detrend(y);frequencies=np.fft.rfftfreq(len(x),1/fs)
        dominant=frequencies[np.argmax(abs(np.fft.rfft(residual*np.hanning(len(x)))))]
        self.assertAlmostEqual(dominant/256,model.RATIO[2],delta=.003)
        self.assertGreater(np.std(residual)/np.std(signal.detrend(x)),1.4)
        self.assertTrue(np.all(np.isfinite(y)))
        self.assertLess(abs(np.mean(y-x)),.001)


if __name__=='__main__':unittest.main()
