# Polytec SDK 的本地 macOS 构建

Copyright (c) 2016–2021 Polytec GmbH, Waldbronn. Device Communication Software is licensed under LGPLv3; GPLv3 and LGPLv3 texts from the supplied original SDK accompany the generated library.

This library is a local rebuild of the user-supplied Polytec 2021 SDK, not an official macOS binary or a statement of vendor support. The original SDK is referenced in `polytec-macos-build.json`; the repository's existing source reference is `vendor/polytec/source/DeviceCommunication-2021-source.zip`.

The macOS compatibility patch changes serial-platform selection, thread QoS, required standard/Boost includes, obsolete Asio API spelling, and invalid throw-only constexpr declarations. It does not change the device wire protocol or measurement scaling. The original source archive, patch and reproduction scripts are included under `source/polytec-macos`. Keep these materials and the license notices when redistributing the modified library. Compatible replacement shared libraries remain supported; build hashes only document the build, not an end-user replacement restriction.

Dependencies include Boost under the Boost Software License 1.0 and the Microsoft Guidelines Support Library (GSL) under the MIT License. Their headers retain their original copyright notices. License text sources:

- Boost: https://www.boost.org/LICENSE_1_0.txt
- Microsoft GSL: https://github.com/microsoft/GSL/blob/main/LICENSE

Native loading and payload smoke tests do not certify hardware acquisition, laser operation, motion safety, or official macOS support. This build script does not access devices or install dependencies.
