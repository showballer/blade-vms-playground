"""Absolute-import entry point for PyInstaller."""
import multiprocessing

from blade_acquisition.__main__ import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
