BladeVMS Windows x64 acquisition service is staged in this folder for the validation build.

Expected layout:
  BladeAcquisition.exe
  _internal/  (all PyInstaller onedir dependencies)
  vendor/     (DeviceCommunication.dll and accompanying license/source notices)

The bundled service includes Python, NumPy/SciPy, real-time preview analysis,
fixed-RPM order analysis, multi-point response fusion, and four ideal cantilever
bending templates with complex MAC/MSE comparison (rotation-fixed-rpm-1.1.0).
Fixed-RPM results use an assumed angle reference, not measured keyphasor synchronization.
Candidate template matching is not validated modal identification or damage detection.
The desktop animation uses normalized illustrative geometry, not physical deformation scale.
For hardware integration, use the service and DeviceCommunication.dll shown
in the desktop Settings page. Keep the entire service directory together.
