BladeVMS Windows x64 acquisition service is staged in this folder for the validation build.

Expected layout:
  BladeAcquisition.exe
  _internal/  (all PyInstaller onedir dependencies)
  vendor/     (DeviceCommunication.dll and accompanying license/source notices)

The bundled service includes the Python runtime, NumPy/SciPy real-time preview
analysis, and the tested vendor SDK payload. It does not install vendor drivers
or substitute simulated data. For hardware integration, use the service and
DeviceCommunication.dll shown in the desktop Settings page.
