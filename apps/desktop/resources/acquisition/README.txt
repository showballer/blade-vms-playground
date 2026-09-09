BladeVMS Windows x64 acquisition service goes in this folder.

Expected layout:
  BladeAcquisition.exe
  _internal/  (all PyInstaller onedir dependencies, if present)

Build services/acquisition on Windows and copy the COMPLETE onedir output here
before running npm run package:windows. See FIELD_INTEGRATION.md.

This checkout does not include a prebuilt Python service or vendor drivers.
The client reports a missing service and never substitutes simulated data.
For hardware integration, choose the tested BladeAcquisition.exe and vendor
DeviceCommunication.dll through the desktop Settings page.
