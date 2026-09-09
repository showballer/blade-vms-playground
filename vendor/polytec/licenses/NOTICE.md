# Polytec Device Communication Software

Copyright (c) 2016–2021 Polytec GmbH, Waldbronn.

This application dynamically loads the unmodified x64 DeviceCommunication.dll
provided in the project's `122` SDK release. The library is licensed under the
GNU Lesser General Public License version 3. The GPLv3 and LGPLv3 texts are
included alongside this notice. The application does not impose restrictions on
modifying the library or reverse engineering for debugging those modifications.

The supplied SDK sources, headers, build files, examples and documentation are
included in `../source/DeviceCommunication-2021-source.zip`. Build instructions
are in `doc/resources/000_GettingStarted.md` inside that archive. The original
source and binary were not modified. The SDK build uses Boost (Boost Software
License 1.0) and the Microsoft C++ toolchain; see the SDK's build instructions.

To use a compatible modified library, stop acquisition and select its x64 DLL
in the desktop application's device/service settings. Preserve the DLL's own
dependency directory. This selection is not restricted to the shipped hash.
The installer payload hash checks are build-integrity checks, not restrictions
on end-user replacement of the LGPL library.
